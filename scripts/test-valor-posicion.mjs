/**
 * Prueba de las migraciones del valor de las posiciones y de la búsqueda:
 *   20261020090000_valor_de_posicion_sin_recalculos.sql   (C1: mismas cifras, sin recálculos)
 *   20261020090100_buscar_movimientos_sin_bucle_por_fila.sql (A2: mismos resultados)
 *   20261020090300_posicion_sin_precio_vale_lo_aportado.sql  (A1: sin precio vale lo aportado)
 *
 *   node --env-file=.env.local scripts/test-valor-posicion.mjs
 *
 * TODO dentro de UNA transacción que se deshace; las migraciones pendientes se
 * aplican ahí dentro, por pasos, comparando las huellas antes y después de
 * cada una con datos sintéticos (todas las variantes de posición) y con los de
 * los usuarios reales (sin imprimir ninguna cifra real).
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes, versionesAplicadas } from "./migraciones-pendientes.mjs";

const C1 = "20261020090000";
const A2 = "20261020090100";
const A1 = "20261020090300";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
const n = (v) => (v === null || v === undefined ? null : Number(v));

let ok = 0;
let mal = 0;
function check(nombre, condicion, detalle = "") {
  if (condicion) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    mal++;
    console.log(`  FALLO ${nombre}${detalle ? `\n        ${detalle}` : ""}`);
  }
}

async function comoUsuario(uid, trabajo) {
  await q("savepoint como");
  try {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
    await q("set local role authenticated");
    return await trabajo();
  } finally {
    await q("rollback to savepoint como");
    await q("release savepoint como");
  }
}

/** Consultas extra (además de la foto común) sobre el usuario sintético. */
const EXTRA = {
  diario_entero: "select * from public.net_worth_daily('2026-01-01', '2026-10-15')",
  mensual_12: "select * from public.net_worth_monthly(12)",
  rendimiento_6m: "select * from public.position_performance('2026-04-15', '2026-10-15')",
  rendimiento_corto: "select * from public.position_performance('2026-08-01', '2026-08-31')",
  rentabilidad_6m: "select * from public.position_return('2026-04-15', '2026-10-15')",
  proyeccion_metas: "select * from public.savings_goal_projection(6)",
  buscar_texto: "select id, total_count, total_net_cents from public.search_transactions(p_q => 'apor', p_limit => 1000)",
  buscar_cuenta_texto: "select id, total_count from public.search_transactions(p_q => 'bró', p_limit => 1000)",
  buscar_categoria_texto: "select id, total_count from public.search_transactions(p_q => 'SÚP', p_limit => 1000)",
  buscar_limitado: "select id, total_count, total_net_cents from public.search_transactions(p_limit => 3)",
  buscar_tipo: "select id, total_count from public.search_transactions(p_type => 'TRANSFER', p_limit => 1000)",
  buscar_vacio: "select id, total_count from public.search_transactions(p_q => '', p_limit => 1000)",
};

async function extra(uid) {
  return comoUsuario(uid, async () => {
    const h = {};
    for (const [k, sql] of Object.entries(EXTRA)) {
      const [r] = await q(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h, count(*) as n from (${sql}) x`);
      h[k] = `${r.h}:${r.n}`;
    }
    return h;
  });
}

async function sembrar() {
  const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  const uid = u.id;
  const cuenta = async (nombre, tipo, inicial = 0) =>
    (await q("insert into public.account (user_id,name,type,initial_balance_cents) values ($1,$2,$3,$4) returning id::text as id", [uid, nombre, tipo, inicial]))[0].id;
  const banco = await cuenta("Banco", "BANCO", 5_000_000);
  const broker = await cuenta("Bróker", "INVERSION");
  const [cat] = await q("insert into public.category (user_id,name,type) values ($1,'Súper','EXPENSE') returning id::text as id", [uid]);
  await q("insert into public.savings_goal (user_id,name,target_cents,account_id) values ($1,'Colchón',2000000,$2)", [uid, broker]);

  const instrumento = async (sim, divisa) =>
    (await q("insert into public.instrument (kind, yahoo_symbol, name, currency) values ('FONDO', $1, $1, $2) returning id::text as id", [sim, divisa]))[0].id;
  const i1 = await instrumento("ZZVAL-EUR", "EUR");
  const i2 = await instrumento("ZZVAL-XTS", "XTS");
  const i3 = await instrumento("ZZVAL-SINPRECIO", "EUR");
  await q(
    `insert into public.instrument_price (instrument_id, date, close)
     select $1, d, 10 + (extract(doy from d)::int % 30) / 10.0 from generate_series('2026-01-02'::date, '2026-10-15', '1 day') d
     where extract(isodow from d) < 6`,
    [i1],
  );
  await q(
    `insert into public.instrument_price (instrument_id, date, close)
     select $1, d, 100 + (extract(doy from d)::int % 17) from generate_series('2026-02-02'::date, '2026-10-15', '1 day') d
     where extract(isodow from d) < 6`,
    [i2],
  );
  await q(
    `insert into public.fx_rate (currency, date, rate)
     select 'XTS', d, 1.05 + (extract(doy from d)::int % 11) / 100.0 from generate_series('2026-02-02'::date, '2026-10-15', '1 day') d
     where extract(isodow from d) < 6
     on conflict do nothing`,
  );

  const posicion = async (nombre, desde, archivada = false) =>
    (await q("insert into public.investment_position (user_id,name,account_id,since,archived) values ($1,$2,$3,$4,$5) returning id::text as id", [uid, nombre, broker, desde, archivada]))[0].id;
  const evento = (p, kind, fecha, inst, units, aportado) =>
    q(
      "insert into public.position_unit_event (user_id, position_id, kind, date, instrument_id, units, contributed_cents) values ($1,$2,$3,$4,$5,$6,$7)",
      [uid, p, kind, fecha, inst, units, aportado],
    );
  const aporte = (p, fecha, cents, units = null, status = "CONFIRMED") =>
    q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,position_id,position_units,source,status)
       values ($1,'TRANSFER',$2,'aportación',$3,$4,$5,$6,$7,'MANUAL',$8)`,
      [uid, cents, fecha, banco, broker, p, units, status],
    );
  const valoracion = (p, fecha, cents) =>
    q("insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,$3,$4)", [uid, p, fecha, cents]);

  // P1: fondo en euros, aportaciones con y sin participaciones, un ajuste y una descartada.
  const p1 = await posicion("Indexado", "2026-02-01");
  await evento(p1, "ALTA", "2026-02-01", i1, 100, 100000);
  for (const [m, conUnidades] of [[3, true], [4, false], [5, true], [6, false], [7, false], [8, true], [9, false], [10, false]]) {
    await aporte(p1, `2026-${String(m).padStart(2, "0")}-05`, 20000, conUnidades ? 15 : null);
  }
  await aporte(p1, "2026-06-20", 99900, null, "DISCARDED");
  await evento(p1, "AJUSTE", "2026-07-01", null, 260, null);

  // P2: acciones en otra divisa (XTS), con cambio diario.
  const p2 = await posicion("Acciones XTS", "2026-03-01");
  await evento(p2, "ALTA", "2026-03-01", i2, 10, 50000);
  for (const m of [4, 6, 8]) await aporte(p2, `2026-0${m}-10`, 30000);

  // P3: manual, con valoraciones y aportaciones entre medias.
  const p3 = await posicion("Plan manual", "2026-01-01");
  for (const [f, v] of [["2026-01-31", 200000], ["2026-03-31", 215000], ["2026-06-30", 260000], ["2026-09-30", 280000]]) await valoracion(p3, f, v);
  for (const f of ["2026-02-15", "2026-05-15", "2026-08-15", "2026-10-01"]) await aporte(p3, f, 10000);

  // P4: seguida, pero su instrumento no tiene ningún precio (A1).
  const p4 = await posicion("Sin precio", "2026-04-01");
  await evento(p4, "ALTA", "2026-04-01", i3, 50, 80000);
  await aporte(p4, "2026-06-10", 20000);

  // P5: seguida y luego dejada de seguir, con una valoración después.
  const p5 = await posicion("Dejado", "2026-02-15");
  await evento(p5, "ALTA", "2026-02-15", i1, 20, 20000);
  await evento(p5, "BAJA", "2026-08-01", null, null, null);
  await valoracion(p5, "2026-08-15", 30000);

  // P6: archivada, con valoración.
  const p6 = await posicion("Archivada", "2026-01-01", true);
  await valoracion(p6, "2026-02-28", 12345);

  // Gastos para la búsqueda.
  for (const [d, cents, conCat] of [["2026-09-01", 1500, true], ["2026-09-02", 2500, false], ["2026-10-03", 990, true]]) {
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
       values ($1,'EXPENSE',$2,'compra',$3,$4,$5,case when $5::uuid is null then null else 'EXPENSE'::public.entry_type end,'MANUAL','CONFIRMED')`,
      [uid, cents, d, banco, conCat ? cat.id : null],
    );
  }
  return { uid, p1, p2, p3, p4, p5, p6, banco, broker };
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const aplicadas = await versionesAplicadas(client);
    const previas = await aplicarPendientes(client, { hasta: String(Number(C1) - 1) });
    if (previas.length) console.log(`(aplicadas antes: ${previas.join(", ")})`);

    const reales = (await q("select id::text as id from auth.users order by created_at")).map((r) => r.id);
    const fotoReales = async () => {
      const r = [];
      for (const u of reales) r.push(await fotoUsuario(client, u, { conHoy: false }));
      return r;
    };
    const s = await sembrar();
    const foto = async () => ({ ...(await fotoUsuario(client, s.uid, { conHoy: false })), ...(await extra(s.uid)) });

    const antesReales = await fotoReales();
    const antes = await foto();
    const errores = Object.entries(antes).filter(([, v]) => v.startsWith("ERROR"));
    check("la foto sintética se calcula sin errores", errores.length === 0, JSON.stringify(errores));

    // ── C1 + A2 ──
    console.log("\n— C1 y A2: mismas cifras al céntimo —\n");
    if (aplicadas.has(C1) && aplicadas.has(A2)) console.log("  (ya aplicadas en la base: la comparación es trivial)");
    const ap1 = await aplicarPendientes(client, { hasta: A2 });
    if (ap1.length) console.log(`  (aplicadas: ${ap1.join(", ")})`);
    const despues = await foto();
    const dif = compararFotos(antes, despues);
    check("datos sintéticos (6 posiciones, todas las variantes): huellas idénticas", dif.length === 0, `cambian: ${dif.join(", ")}`);
    const despuesReales = await fotoReales();
    const difReales = despuesReales.map((f, i) => compararFotos(antesReales[i], f)).filter((d) => d.length);
    check(`usuarios reales (${reales.length}): huellas idénticas`, difReales.length === 0, difReales.map((d) => d.join(", ")).join(" / "));

    const [idx] = await q("select to_regclass('public.tx_position_flow_idx') is not null as v");
    check("existe el índice cubriente tx_position_flow_idx", idx.v);
    const [cfg] = await q(`
      select count(*) filter (where p.prosecdef) as definer,
             count(*) filter (where not coalesce(p.proconfig, '{}') @> array['search_path=""']) as sin_path
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname, p.proname) in (('private','position_value_on'), ('public','position_performance'), ('public','search_transactions'))`);
    check("las tres funciones siguen security invoker y con search_path = ''", n(cfg.definer) === 0 && n(cfg.sin_path) === 0, JSON.stringify(cfg));
    const plan = await comoUsuario(s.uid, () =>
      q("explain (costs off) select * from public.search_transactions(p_q => 'x', p_limit => 10)"),
    );
    check("la búsqueda se planifica (explain sin error)", plan.length > 0);

    // ── A1 ──
    console.log("\n— A1: una posición seguida sin precio vale lo aportado —\n");
    const valor = () =>
      comoUsuario(s.uid, () =>
        q("select position_id::text as id, value_cents, fuente, sin_precio, contributed_cents, gain_cents from public.v_position_market"),
      );
    const antesA1 = await valor();
    const [nwAntes] = await comoUsuario(s.uid, () => q("select invested_cents, net_worth_cents from public.v_net_worth"));
    const ap2 = await aplicarPendientes(client, { hasta: A1 });
    if (ap2.length) console.log(`  (aplicadas: ${ap2.join(", ")})`);
    const despuesA1 = await valor();
    const de = (filas, id) => filas.find((x) => x.id === id);
    const p4 = de(despuesA1, s.p4);
    check(
      "sin precio: vale lo aportado en el ALTA + lo traspasado después (800 € + 200 € = 1.000 €)",
      n(p4.value_cents) === 100000 && p4.sin_precio === true,
      JSON.stringify(p4),
    );
    check("… y su ganancia es 0, no −100 %", n(p4.gain_cents) === 0, JSON.stringify(p4));
    const otras = [s.p1, s.p2, s.p3, s.p5];
    check(
      "las demás posiciones (mercado, otra divisa, manual, dejada) valen lo mismo que antes",
      otras.every((id) => JSON.stringify(de(antesA1, id)) === JSON.stringify(de(despuesA1, id))),
    );
    const [nw] = await comoUsuario(s.uid, () => q("select invested_cents, net_worth_cents from public.v_net_worth"));
    check(
      "el patrimonio invertido sube exactamente el valor de la posición sin precio",
      n(nw.invested_cents) - n(nwAntes.invested_cents) === 100000 - n(de(antesA1, s.p4).value_cents),
      `${nwAntes.invested_cents} → ${nw.invested_cents}`,
    );
    const [curva] = await comoUsuario(s.uid, () =>
      q("select v.value_cents from public.position_performance('2026-06-01', '2026-06-30') v where v.position_id = $1 and v.fecha = '2026-06-15'", [s.p4]),
    );
    check("la curva de rendimiento tampoco la hunde a 0 (15 de junio: 1.000 €)", n(curva?.value_cents) === 100000, JSON.stringify(curva));
    const [dia] = await comoUsuario(s.uid, () =>
      q("select invested_cents from public.net_worth_daily('2026-05-01', '2026-05-01')"),
    );
    check("antes de la aportación posterior (1 de mayo) vale solo lo del ALTA en la curva diaria", n(dia.invested_cents) >= 80000, JSON.stringify(dia));
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
  process.exit(2);
});
