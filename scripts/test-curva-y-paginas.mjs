/**
 * Prueba de 20261020090800_curva_muestreada_y_orden_total.sql (C2, lado SQL):
 *  · position_performance da un punto por día (≤ ~6 meses), por semana (≤ ~3
 *    años) o por mes, con EXACTAMENTE los mismos valores que antes en los
 *    puntos que quedan, y cabe en el tope de 1.000 filas de PostgREST;
 *  · search_transactions tiene un orden total: leído por páginas (limit/offset,
 *    lo que hace .range()) no repite ni se salta filas.
 *
 *   node --env-file=.env.local scripts/test-curva-y-paginas.mjs
 *
 * TODO dentro de UNA transacción que se deshace. De los usuarios reales solo
 * se comparan filas en memoria (no se imprime ninguna cifra).
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { aplicarPendientes, versionesAplicadas } from "./migraciones-pendientes.mjs";

const VERSION = "20261020090800";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

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

async function como(uid, sql, params = []) {
  await q("savepoint como");
  try {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
    await q("set local role authenticated");
    return await q(sql, params);
  } finally {
    await q("rollback to savepoint como");
    await q("release savepoint como");
  }
}

const curva = (uid, desde, hasta) =>
  como(
    uid,
    "select position_id::text as p, fecha::text as f, value_cents::text as v, cost_cents::text as c, return_pct::text as r from public.position_performance($1, $2)",
    [desde, hasta],
  );
const clave = (x) => `${x.p}|${x.f}`;

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const yaEstaba = (await versionesAplicadas(client)).has(VERSION);
    await aplicarPendientes(client, { hasta: String(Number(VERSION) - 1) });

    // Usuario sintético: 6 fondos con precio cada día laborable desde mediados de 2022.
    const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const uid = u.id;
    const [banco] = await q("insert into public.account (user_id,name,type,initial_balance_cents) values ($1,'Banco','BANCO',100000000) returning id::text as id", [uid]);
    const [broker] = await q("insert into public.account (user_id,name,type) values ($1,'Bróker','INVERSION') returning id::text as id", [uid]);
    for (let i = 1; i <= 6; i++) {
      const [inst] = await q("insert into public.instrument (kind, yahoo_symbol, name, currency) values ('FONDO', $1, $1, 'EUR') returning id::text as id", [`ZZCURVA-${i}`]);
      await q(
        `insert into public.instrument_price (instrument_id, date, close)
         select $1, d, 10 + $2 + (extract(doy from d)::int % 23) / 10.0 from generate_series('2022-06-01'::date, '2026-10-15', '1 day') d
         where extract(isodow from d) < 6`,
        [inst.id, i],
      );
      const [p] = await q("insert into public.investment_position (user_id,name,account_id,since) values ($1,$2,$3,'2022-06-01') returning id::text as id", [uid, `Fondo ${i}`, broker.id]);
      await q("insert into public.position_unit_event (user_id, position_id, kind, date, instrument_id, units, contributed_cents) values ($1,$2,'ALTA','2022-06-01',$3,100,100000)", [uid, p.id, inst.id]);
      await q(
        `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,position_id,source,status)
         select $1,'TRANSFER',10000,'aporte',d,$2,$3,$4,'MANUAL','CONFIRMED' from generate_series('2022-07-05'::date, '2026-10-05', '1 month') d`,
        [uid, banco.id, broker.id, p.id],
      );
    }
    // 30 gastos idénticos (mismo día, hora y created_at: una sola sentencia, como una importación).
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,occurred_time,account_id,source,status)
       select $1,'EXPENSE',100,'importado','2026-09-01','00:00',$2,'IMPORT','CONFIRMED' from generate_series(1, 30)`,
      [uid, banco.id],
    );

    const RANGOS = [
      ["3M", "2026-07-15", "2026-10-15", "day"],
      ["Año", "2026-01-01", "2026-10-15", "week"],
      ["Todo", "2022-05-31", "2026-10-15", "month"],
    ];
    const reales = (await q("select id::text as id from auth.users where id <> $1 order by created_at", [uid])).map((r) => r.id);
    const antes = {};
    for (const [n, d, h] of RANGOS) antes[n] = await curva(uid, d, h);
    const antesReales = [];
    for (const r of reales) antesReales.push(await curva(r, "2000-01-01", "2026-10-15"));

    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})`);
    if (yaEstaba) console.log("(ya estaba aplicada: el «antes» ya es el «después»)");

    console.log("\n— La curva de Inversiones —\n");
    for (const [n, d, h, unidad] of RANGOS) {
      const despues = await curva(uid, d, h);
      const previo = new Map(antes[n].map((x) => [clave(x), JSON.stringify(x)]));
      const iguales = despues.every((x) => previo.get(clave(x)) === JSON.stringify(x));
      check(`${n}: ${despues.length} filas (antes ${antes[n].length}), todas ≤ 1.000`, despues.length <= 1000, `${despues.length}`);
      check(`${n}: cada punto que queda vale EXACTAMENTE lo mismo que antes`, iguales);
      const porPos = new Map();
      for (const x of despues) porPos.set(x.p, [...(porPos.get(x.p) ?? []), x.f]);
      const ultimoAntes = antes[n].reduce((m, x) => (x.f > m ? x.f : m), "");
      check(`${n}: cada fondo acaba en el último día con dato (${ultimoAntes})`, [...porPos.values()].every((fs) => fs.at(-1) === ultimoAntes));
      const primeroAntes = antes[n].reduce((m, x) => (x.f < m ? x.f : m), "9999");
      check(`${n}: y empieza en el primero (${primeroAntes})`, [...porPos.values()].every((fs) => fs[0] === primeroAntes));
      if (unidad === "day") check(`${n}: hasta ~6 meses, un punto por día (igual que antes)`, despues.length === antes[n].length);
      if (unidad === "week") {
        const semanas = new Set(despues.map((x) => x.f).map((f) => { const t = new Date(`${f}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); }));
        check(`${n}: un punto por semana (más el primero)`, porPos.get(despues[0].p).length <= semanas.size + 1);
      }
      if (unidad === "month") {
        const meses = new Set(despues.map((x) => x.f.slice(0, 7)));
        check(`${n}: un punto por mes (más el primero)`, porPos.get(despues[0].p).length <= meses.size + 1, `${porPos.get(despues[0].p).length} / ${meses.size}`);
      }
    }

    console.log("\n— Usuarios reales (en memoria, sin imprimir) —\n");
    let bien = 0;
    for (const [i, r] of reales.entries()) {
      const despues = await curva(r, "2000-01-01", "2026-10-15");
      const previo = new Map(antesReales[i].map((x) => [clave(x), JSON.stringify(x)]));
      if (despues.every((x) => previo.get(clave(x)) === JSON.stringify(x)) && despues.length <= antesReales[i].length) bien++;
    }
    check(`los ${reales.length} usuarios reales: su curva «Todo» es un subconjunto exacto de la de antes`, bien === reales.length);

    console.log("\n— La búsqueda por páginas —\n");
    const todas = await como(uid, "select id::text as id from public.search_transactions(p_limit => 5000)");
    const paginas = [];
    for (let desde = 0; desde < todas.length; desde += 7) {
      paginas.push(...(await como(uid, `select id::text as id from public.search_transactions(p_limit => 5000) limit 7 offset ${desde}`)));
    }
    const ids = paginas.map((x) => x.id);
    check(
      `${todas.length} movimientos (30 empatados) leídos de 7 en 7: ni repetidos ni perdidos, y en el mismo orden`,
      new Set(ids).size === todas.length && ids.join() === todas.map((x) => x.id).join(),
    );
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
