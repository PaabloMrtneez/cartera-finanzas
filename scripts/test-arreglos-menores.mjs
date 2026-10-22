/**
 * Prueba de 20261020090900_arreglos_menores_de_datos.sql: M3 (v_net_worth de
 * una pasada, mismas cifras), B1 (la vista previa de borrar una cuenta trae
 * sus préstamos), B3 (índices redundantes fuera), B5 (índices de las FK) y B6
 * (permisos coherentes).
 *
 *   node --env-file=.env.local scripts/test-arreglos-menores.mjs
 *
 * TODO dentro de UNA transacción que se deshace; las migraciones pendientes se
 * aplican ahí dentro. De los usuarios reales solo se comparan huellas.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261020090900";
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

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    await aplicarPendientes(client, { hasta: String(Number(VERSION) - 1) });

    // Usuario sintético con todos los tipos de cuenta.
    const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const uid = u.id;
    const cuenta = async (n, t, i = 0, archivada = false) =>
      (await q("insert into public.account (user_id,name,type,initial_balance_cents,archived,archived_at) values ($1,$2,$3,$4,$5,case when $5 then now() end) returning id::text as id", [uid, n, t, i, archivada]))[0].id;
    const banco = await cuenta("Banco", "BANCO", 250000);
    await cuenta("Hucha", "AHORRO", 12345);
    await cuenta("Vieja", "EFECTIVO", 999, true);
    const broker = await cuenta("Bróker", "INVERSION", 5000);
    const [p] = await q("insert into public.investment_position (user_id,name,account_id,since) values ($1,'Plan',$2,'2026-01-01') returning id::text as id", [uid, broker]);
    await q("insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,'2026-03-31',61000)", [uid, p.id]);
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,position_id,source,status)
       values ($1,'TRANSFER',50000,'aporte','2026-02-01',$2,$3,$4,'MANUAL','CONFIRMED'), ($1,'TRANSFER',8000,'aporte','2026-05-01',$2,$3,$4,'MANUAL','CONFIRMED')`,
      [uid, banco, broker, p.id],
    );
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,source,status)
       values ($1,'TRANSFER',20000,'al bróker','2026-02-01',$2,$3,'MANUAL','CONFIRMED')`,
      [uid, banco, broker],
    );
    const [l] = await como(uid, "select public.create_loan('Coche', $1, 1000000, 60, 5, null, 0, 10, '2025-06-01', null, true) as r", [banco]);
    const prestamo = l.r;

    const reales = (await q("select id::text as id from auth.users where id <> $1 order by created_at", [uid])).map((r) => r.id);
    const VISTAS = "select (select row_to_json(n)::text from public.v_net_worth n) as nw, (select json_agg(w order by w.account_id)::text from public.v_account_worth w) as worth";
    const antesSint = await como(uid, VISTAS);
    const antesReales = [];
    for (const r of reales) antesReales.push(await fotoUsuario(client, r, { conHoy: false }));

    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})\n`);

    console.log("— M3: v_net_worth de una pasada —\n");
    const despuesSint = await como(uid, VISTAS);
    check(
      "usuario sintético (banco, ahorro, efectivo archivado, inversión con caja y posición, préstamo): v_net_worth idéntico",
      antesSint[0].nw === despuesSint[0].nw,
      `${antesSint[0].nw} → ${despuesSint[0].nw}`,
    );
    const nw = JSON.parse(despuesSint[0].nw);
    check("… y cuadra con la suma de v_account_worth", JSON.parse(despuesSint[0].worth).reduce((s, w) => s + Number(w.worth_cents), 0) === Number(nw.net_worth_cents));
    check("… con deuda negativa e idle = caja del bróker sin desplegar", Number(nw.debt_cents) < 0 && Number(nw.idle_cents) === 5000 + 20000, JSON.stringify(nw));
    let iguales = 0;
    for (const [i, r] of reales.entries()) {
      const d = compararFotos(antesReales[i], await fotoUsuario(client, r, { conHoy: false }));
      if (d.length === 0) iguales++;
      else console.log(`  usuario #${i + 1}: cambian ${d.join(", ")}`);
    }
    check(`usuarios reales (${reales.length}): huellas idénticas (patrimonio incluido)`, iguales === reales.length);
    const [plan] = await como(uid, "explain (format json) select * from public.v_net_worth");
    const texto = JSON.stringify(plan);
    const veces = (texto.match(/"Relation Name":"account"/g) ?? []).length;
    check("el plan recorre account una vez por la caja (no tres)", veces <= 2, `${veces} recorridos de account`);

    console.log("\n— B1: la vista previa avisa de los préstamos —\n");
    const [pv] = await como(uid, "select public.account_delete_preview($1) as p", [banco]);
    check("cuenta de pago: trae el préstamo con papel PAGO", pv.p.loans?.length === 1 && pv.p.loans[0].role === "PAGO" && pv.p.loans[0].name === "Coche", JSON.stringify(pv.p.loans));
    const [pp] = await como(uid, "select public.account_delete_preview($1) as p", [prestamo.liability_account_id]);
    check("cuenta-pasivo: trae el préstamo con papel PASIVO", pp.p.loans?.[0]?.role === "PASIVO", JSON.stringify(pp.p.loans));
    const [pb] = await como(uid, "select public.account_delete_preview($1) as p", [broker]);
    check("una cuenta sin préstamos: lista vacía", Array.isArray(pb.p.loans) && pb.p.loans.length === 0);

    console.log("\n— B3 / B5: índices —\n");
    const [ix] = await q(`select to_regclass('public.tx_recurring_income_idx') as a,
      (select count(*) from pg_constraint where conname = 'transaction_user_id_id_key')::int as b`);
    check("tx_recurring_income_idx y transaction_user_id_id_key, fuera", ix.a === null && ix.b === 0);
    const [fk] = await q(`select count(*)::int as n from pg_constraint where contype = 'f' and confrelid = 'public.transaction'::regclass and convalidated`);
    check("las FK que apuntan a transaction siguen ahí", fk.n >= 1);
    const g = await q("select id::text as id from public.transaction where user_id = $1 and type = 'TRANSFER' limit 1", [uid]);
    const [cat] = await q("insert into public.category (user_id,name,type) values ($1,'Ropa','EXPENSE') returning id::text as id", [uid]);
    const [gasto] = await q("insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type) values ($1,'EXPENSE',1000,'g','2026-09-01',$2,$3,'EXPENSE') returning id::text as id", [uid, banco, cat.id]);
    await q("insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,reimburses_id,reimburses_target_type) values ($1,'INCOME',500,'r','2026-09-02',$2,$3,'EXPENSE')", [uid, banco, gasto.id]);
    check("un reembolso (FK compuesta a transaction) sigue funcionando", g.length === 1);
    const nuevos = [
      "budget_category_fk_idx", "budget_alert_budget_fk_idx", "ingest_dead_letter_device_fk_idx", "investment_position_account_fk_idx",
      "loan_interest_category_fk_idx", "merchant_rule_category_fk_idx", "recurring_income_account_fk_idx", "recurring_income_category_fk_idx",
      "subscription_account_fk_idx", "subscription_category_fk_idx",
    ];
    const [hay] = await q("select count(*)::int as n from pg_class where relkind = 'i' and relname = any($1)", [nuevos]);
    check(`los ${nuevos.length} índices de apoyo de FK existen`, hay.n === nuevos.length, `${hay.n}`);

    console.log("\n— B6: permisos —\n");
    const [perm] = await q(`select
      has_function_privilege('service_role', 'public.net_worth_daily(date,date)', 'execute') as a,
      has_function_privilege('service_role', 'public.net_worth_monthly(integer)', 'execute') as b,
      has_function_privilege('service_role', 'public.account_balance_monthly(integer)', 'execute') as c,
      has_function_privilege('authenticated', 'public.net_worth_daily(date,date)', 'execute') as d`);
    check("service_role ya no las tiene; authenticated sí", !perm.a && !perm.b && !perm.c && perm.d, JSON.stringify(perm));
    const [vi] = await q("select reloptions from pg_class where oid = 'public.v_net_worth'::regclass");
    check("v_net_worth sigue security_invoker", (vi.reloptions ?? []).includes("security_invoker=true"));
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
