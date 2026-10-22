/**
 * Prueba de 20261020090500_cobros_vuelven_a_su_dia.sql (M5): los fijos e
 * ingresos fijos del 29, 30 y 31 vuelven a su día en los meses que lo tienen.
 *
 *   node --env-file=.env.local scripts/test-dia-ancla.mjs
 *
 * TODO dentro de UNA transacción que se deshace; las migraciones pendientes se
 * aplican ahí dentro (y unas filas «de antes» se siembran antes de aplicarla,
 * para probar el relleno). Las fechas se piden con ::text.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes, versionesAplicadas } from "./migraciones-pendientes.mjs";

const VERSION = "20261020090500";
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
    const r = await q(sql, params);
    await q("reset role");
    await q("release savepoint como");
    return r;
  } catch (e) {
    await q("rollback to savepoint como");
    await q("release savepoint como");
    throw e;
  }
}

const sub = (uid, cuenta, desc, periodo, proximo, inicio) =>
  q(
    `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,started_at,account_id)
     values ($1,$2,1000,$3,$4,$5,$6) returning id::text as id`,
    [uid, desc, periodo, proximo, inicio, cuenta],
  ).then((r) => r[0].id);
const fechas = (campo, id) =>
  q(`select occurred_on::text as d from public.transaction where ${campo} = $1 order by 1`, [id]).then((r) => r.map((x) => x.d));

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const yaEstaba = (await versionesAplicadas(client)).has(VERSION);
    await aplicarPendientes(client, { hasta: String(Number(VERSION) - 1) });
    const reales = (await q("select id::text as id from auth.users order by created_at")).map((r) => r.id);
    const antes = [];
    for (const u of reales) antes.push(await fotoUsuario(client, u, { conHoy: false }));

    const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const uid = u.id;
    const [b] = await q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id::text as id", [uid]);

    // Filas «de antes» (sin ancla), para el relleno: una ya derivada al 28.
    let derivada = null;
    let normal = null;
    if (!yaEstaba) {
      derivada = await sub(uid, b.id, "Derivada", "MENSUAL", "2026-11-28", "2026-01-31");
      normal = await sub(uid, b.id, "Del 15", "MENSUAL", "2026-11-15", "2026-01-15");
    }
    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})`);

    console.log("\n— El cálculo —\n");
    const nc = async (d, p, a) => (await q("select private.next_charge($1::date, $2, $3::smallint)::text as d", [d, p, a]))[0].d;
    check("31 ene + 1 mes, ancla 31 → 28 feb", (await nc("2026-01-31", "MENSUAL", 31)) === "2026-02-28");
    check("28 feb + 1 mes, ancla 31 → 31 mar (vuelve a su día)", (await nc("2026-02-28", "MENSUAL", 31)) === "2026-03-31");
    check("31 mar + 1 mes, ancla 31 → 30 abr", (await nc("2026-03-31", "MENSUAL", 31)) === "2026-04-30");
    check("30 nov + 3 meses, ancla 31 → 28 feb; 28 feb + 3 meses → 31 may", (await nc("2026-11-30", "TRIMESTRAL", 31)) === "2027-02-28" && (await nc("2027-02-28", "TRIMESTRAL", 31)) === "2027-05-31");
    check("anual, ancla 29: 28 feb 2027 → 29 feb 2028", (await nc("2027-02-28", "ANUAL", 29)) === "2028-02-29");
    check("semanal: +7 días, el ancla no cuenta", (await nc("2026-01-31", "SEMANAL", 31)) === "2026-02-07");
    const [dos] = await q("select private.next_charge('2026-01-31', 'MENSUAL')::text as d");
    check("la versión de dos argumentos da lo mismo que antes (28 feb)", dos.d === "2026-02-28");

    if (!yaEstaba) {
      console.log("\n— Relleno de las filas que ya había —\n");
      const [d] = await q("select anchor_day, next_charge_date::text as n from public.subscription where id = $1", [derivada]);
      check("una suscripción del 31 ya derivada al 28: ancla 31 y el próximo cobro vuelve al 30 de noviembre", d.anchor_day === 31 && d.n === "2026-11-30", JSON.stringify(d));
      const [m] = await q("select anchor_day, next_charge_date::text as n from public.subscription where id = $1", [normal]);
      check("una del 15: ancla 15 y la fecha no se toca", m.anchor_day === 15 && m.n === "2026-11-15", JSON.stringify(m));
    }

    console.log("\n— Generar —\n");
    const s31 = await sub(uid, b.id, "Día 31", "MENSUAL", "2026-01-31", "2026-01-31");
    const s29 = await sub(uid, b.id, "29 feb", "ANUAL", "2024-02-29", "2024-02-29");
    const [ing] = await q(
      `insert into public.recurring_income (user_id,description,amount_cents,periodicity,next_income_date,started_at,account_id)
       values ($1,'Nómina 30',100000,'MENSUAL','2026-01-30','2026-01-30',$2) returning id::text as id`,
      [uid, b.id],
    );
    await como(uid, "select public.generate_subscription_charges(), public.generate_recurring_income()");
    const f31 = await fechas("subscription_id", s31);
    check(
      "suscripción del 31: 31 ene, 28 feb, 31 mar, 30 abr, 31 may, 30 jun, 31 jul, 31 ago, 30 sep",
      f31.slice(0, 9).join() === "2026-01-31,2026-02-28,2026-03-31,2026-04-30,2026-05-31,2026-06-30,2026-07-31,2026-08-31,2026-09-30",
      f31.join(", "),
    );
    const [p31] = await q("select anchor_day, next_charge_date::text as n from public.subscription where id = $1", [s31]);
    check("… y su ancla sigue en 31 tras generar", p31.anchor_day === 31, JSON.stringify(p31));
    const f29 = await fechas("subscription_id", s29);
    check("anual del 29 feb 2024: 2024-02-29, 2025-02-28, 2026-02-28", f29.join() === "2024-02-29,2025-02-28,2026-02-28", f29.join(", "));
    const [p29] = await q("select anchor_day, next_charge_date::text as n from public.subscription where id = $1", [s29]);
    check("… próximo, 28 feb 2027, con ancla 29 (en 2028 será el 29)", p29.n === "2027-02-28" && p29.anchor_day === 29, JSON.stringify(p29));
    const fi = await fechas("recurring_income_id", ing.id);
    check("ingreso fijo del 30: 30 ene, 28 feb, 30 mar, 30 abr", fi.slice(0, 4).join() === "2026-01-30,2026-02-28,2026-03-30,2026-04-30", fi.join(", "));

    console.log("\n— Próximos cargos —\n");
    const s2 = await sub(uid, b.id, "Fin de mes", "MENSUAL", "2027-01-31", "2027-01-31");
    const prox = await como(uid, "select charge_date::text as d from public.upcoming_charges(400) where subscription_id = $1 order by 1", [s2]);
    check(
      "los próximos cargos de una del 31: 31 ene, 28 feb, 31 mar, 30 abr…",
      prox.slice(0, 4).map((x) => x.d).join() === "2027-01-31,2027-02-28,2027-03-31,2027-04-30",
      prox.map((x) => x.d).join(", "),
    );

    console.log("\n— Quién cambia el ancla —\n");
    await como(uid, "update public.subscription set next_charge_date = '2026-12-15' where id = $1", [s31]);
    const [e] = await q("select anchor_day from public.subscription where id = $1", [s31]);
    check("cambiar la fecha a mano: el ancla pasa a ser el día nuevo (15)", e.anchor_day === 15, JSON.stringify(e));
    await como(uid, "update public.subscription set amount_cents = 2000 where id = $1", [s31]);
    const [e2] = await q("select anchor_day from public.subscription where id = $1", [s31]);
    check("cambiar otra cosa no la toca", e2.anchor_day === 15);
    const [alta] = await como(
      uid,
      "select r.subscription_id::text as s, r.next_charge_date::text as n from public.create_expense_with_subscription(999, 'Gym', '2026-08-31', $1, null, 'MENSUAL', null, '12:00') r",
      [b.id],
    );
    const [ea] = await q("select anchor_day from public.subscription where id = $1", [alta.s]);
    check("alta de gasto con suscripción el 31 de agosto: próximo el 30 de septiembre, ancla 31", alta.n === "2026-09-30" && ea.anchor_day === 31, JSON.stringify({ alta, ea }));
    await como(uid, "select public.generate_subscription_charges()");
    const fa = await fechas("subscription_id", alta.s);
    check("… y al generar: 31 ago, 30 sep (y el 31 de octubre cuando toque)", fa.slice(0, 2).join() === "2026-08-31,2026-09-30", fa.join(", "));
    const [pa] = await q("select next_charge_date::text as n from public.subscription where id = $1", [alta.s]);
    check("… su próximo cobro es el 31 de octubre", pa.n === "2026-10-31", JSON.stringify(pa));

    console.log("\n— Esquema y datos reales —\n");
    const [cfg] = await q(`
      select count(*) filter (where p.prosecdef) as definer,
             count(*) filter (where not coalesce(p.proconfig, '{}') @> array['search_path=""']) as sin_path
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ('next_charge', 'ancla_inicial', 'tg_ancla_suscripcion', 'tg_ancla_ingreso')`);
    check("funciones nuevas security invoker y con search_path = ''", Number(cfg.definer) === 0 && Number(cfg.sin_path) === 0, JSON.stringify(cfg));
    let iguales = 0;
    for (const [i, x] of reales.entries()) {
      const d = compararFotos(antes[i], await fotoUsuario(client, x, { conHoy: false }));
      if (d.length === 0) iguales++;
      else console.log(`  usuario #${i + 1}: cambian ${d.join(", ")}`);
    }
    check(`cifras de los ${reales.length} usuarios reales idénticas`, iguales === reales.length);
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
