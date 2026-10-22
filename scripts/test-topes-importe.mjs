/**
 * Prueba de 20261020090600_topes_de_importe.sql (M6): todas las columnas de
 * dinero que escribe el usuario tienen el tope de 1.000 M€ de los movimientos,
 * y los resúmenes de fijos no desbordan.
 *
 *   node --env-file=.env.local scripts/test-topes-importe.mjs
 *
 * TODO dentro de UNA transacción que se deshace; las migraciones pendientes se
 * aplican ahí dentro. Usuario sintético.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261020090600";
const TOPE = 100_000_000_000;
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

async function intento(sql, params) {
  await q("savepoint i");
  try {
    await q(sql, params);
    await q("release savepoint i");
    return null;
  } catch (e) {
    await q("rollback to savepoint i");
    await q("release savepoint i");
    return e;
  }
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})\n`);

    const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const uid = u.id;
    const [b] = await q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id::text as id", [uid]);
    const [c] = await q("insert into public.category (user_id,name,type) values ($1,'Casa','EXPENSE') returning id::text as id", [uid]);
    const [inv] = await q("insert into public.account (user_id,name,type) values ($1,'Bróker','INVERSION') returning id::text as id", [uid]);
    const [pos] = await q("insert into public.investment_position (user_id,name,account_id,since) values ($1,'Fondo',$2,'2026-01-01') returning id::text as id", [uid, inv.id]);

    const casos = [
      ["subscription.amount_cents", "insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,account_id) values ($1,'s',$2,'SEMANAL','2027-01-01',$3)", [b.id]],
      ["recurring_income.amount_cents", "insert into public.recurring_income (user_id,description,amount_cents,periodicity,next_income_date,account_id) values ($1,'i',$2,'SEMANAL','2027-01-01',$3)", [b.id]],
      ["savings_goal.target_cents", "insert into public.savings_goal (user_id,name,target_cents,account_id) values ($1,'m',$2,$3)", [inv.id]],
      ["budget.monthly_cap_cents", "insert into public.budget (user_id,category_id,monthly_cap_cents) values ($1,$3,$2)", [c.id]],
      ["valuation.value_cents", "insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$3,'2026-02-01',$2)", [pos.id]],
    ];
    for (const [nombre, sql, extra] of casos) {
      const encima = await intento(sql, [uid, TOPE + 1, ...extra]);
      check(`${nombre}: 1.000 M€ + 1 céntimo, rechazado (23514)`, encima?.code === "23514", encima ? encima.code : "aceptado");
      const justo = await intento(sql, [uid, TOPE, ...extra]);
      check(`${nombre}: justo 1.000 M€, aceptado`, !justo, justo?.message);
    }

    // Muchas suscripciones semanales al máximo: el resumen no desborda y cuadra.
    await q(
      `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,account_id)
       select $1, 's' || g, $2, 'SEMANAL', '2027-01-01', $3 from generate_series(1, 200) g`,
      [uid, TOPE, b.id],
    );
    await q("savepoint r");
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
    await q("set local role authenticated");
    let r = null;
    let err = null;
    try {
      [r] = await q("select sum(yearly_cents)::text as anual, count(*)::int as n from public.v_subscription_summary");
    } catch (e) {
      err = e;
    }
    await q("rollback to savepoint r");
    const esperado = BigInt(TOPE) * 52n * BigInt(r?.n ?? 0);
    check("201 suscripciones semanales de 1.000 M€: v_subscription_summary no desborda", !err, err?.message);
    check("… y el total anual es exacto (sin coma flotante)", r && BigInt(r.anual) === esperado, `${r?.anual} / ${esperado}`);

    const [viol] = await q(`
      select (select count(*) from public.subscription where amount_cents > ${TOPE} and user_id <> $1)
           + (select count(*) from public.recurring_income where amount_cents > ${TOPE})
           + (select count(*) from public.savings_goal where target_cents > ${TOPE})
           + (select count(*) from public.budget where monthly_cap_cents > ${TOPE})
           + (select count(*) from public.valuation where value_cents > ${TOPE}) as n`, [uid]);
    check("ninguna fila de la base supera el tope", Number(viol.n) === 0);
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
