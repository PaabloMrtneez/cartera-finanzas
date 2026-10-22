/**
 * Prueba de 20261020090400_reembolsos_coherentes.sql (M1 y M2): un reembolso
 * nunca acaba contando como ingreso, no resta si su gasto está descartado y no
 * puede superar al gasto.
 *
 *   node --env-file=.env.local scripts/test-reembolsos.mjs
 *
 * TODO dentro de UNA transacción que se deshace; las migraciones pendientes se
 * aplican ahí dentro. Usuarios sintéticos; de los reales solo se comprueba que
 * sus cifras no cambian (huellas, sin imprimir nada).
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261020090400";
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

/** Como el usuario, en un savepoint que se deshace solo si `deshacer`. Devuelve { filas, error }. */
async function como(uid, sql, params = [], { deshacer = false } = {}) {
  await q("savepoint como");
  let filas = null;
  let error = null;
  try {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
    await q("set local role authenticated");
    filas = await q(sql, params);
  } catch (e) {
    error = e;
  }
  if (error || deshacer) await q("rollback to savepoint como");
  else await q("reset role");
  await q("release savepoint como");
  return { filas, error };
}

const MES = "date_trunc('month', private.hoy())::date";

async function usuario() {
  const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  const [b] = await q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id::text as id", [u.id]);
  const [b2] = await q("insert into public.account (user_id,name,type) values ($1,'Otra','BANCO') returning id::text as id", [u.id]);
  const [c] = await q("insert into public.category (user_id,name,type) values ($1,'Viajes','EXPENSE') returning id::text as id", [u.id]);
  return { uid: u.id, banco: b.id, otra: b2.id, cat: c.id };
}
const gasto = async (u, cents, status = "CONFIRMED", cuenta = u.banco) =>
  (
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
       values ($1,'EXPENSE',$2,'g',private.hoy(),$3,$4,'EXPENSE','MANUAL',$5) returning id::text as id`,
      [u.uid, cents, cuenta, u.cat, status],
    )
  )[0].id;
const sqlReembolso = `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,source,status,reimburses_id,reimburses_target_type)
  values ($1,'INCOME',$2,'r',private.hoy(),$3,'MANUAL',$5,$4,'EXPENSE') returning id::text as id`;
const reembolso = (u, cents, de, { status = "CONFIRMED", cuenta = u.banco } = {}) =>
  como(u.uid, sqlReembolso, [u.uid, cents, cuenta, de, status]);
const mes = async (u) =>
  (await como(u.uid, `select income_cents, net_expense_cents, gross_expense_cents, reimbursed_cents from public.v_month_summary where period_month = ${MES}`)).filas[0] ?? {};

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const previas = await aplicarPendientes(client, { hasta: String(Number(VERSION) - 1) });
    if (previas.length) console.log(`(aplicadas antes: ${previas.join(", ")})`);
    const reales = (await q("select id::text as id from auth.users order by created_at")).map((r) => r.id);
    const antes = [];
    for (const u of reales) antes.push(await fotoUsuario(client, u, { conHoy: false }));
    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicada dentro de la transacción: ${ap.join(", ")})`);

    console.log("\n— M2a: el reembolso de un gasto descartado no resta —\n");
    {
      const u = await usuario();
      const g = await gasto(u, 30000, "DISCARDED");
      const r = await reembolso(u, 30000, g);
      check("se puede apuntar (el gasto existe)", !r.error, r.error?.message);
      const m = await mes(u);
      check("gasto neto del mes 0, no −300 €", n(m.net_expense_cents ?? 0) === 0, JSON.stringify(m));
      check("… y tampoco cuenta como ingreso", n(m.income_cents ?? 0) === 0, JSON.stringify(m));
      check("gasto bruto − reembolsado = gasto neto", n(m.gross_expense_cents ?? 0) - n(m.reimbursed_cents ?? 0) === n(m.net_expense_cents ?? 0), JSON.stringify(m));
      const [rep] = (await como(u.uid, `select coalesce(sum(net_cents), 0) as s from public.category_breakdown(${MES})`)).filas;
      check("el reparto por categoría no queda en negativo", n(rep.s) >= 0, JSON.stringify(rep));
      const [bus] = (await como(u.uid, "select total_net_cents from public.search_transactions(p_limit => 10) limit 1")).filas;
      check("el total de la búsqueda tampoco lo resta", n(bus?.total_net_cents ?? 0) === 0, JSON.stringify(bus));
      // Un gasto vivo con reembolso sí resta (no se ha roto lo normal).
      const g2 = await gasto(u, 10000);
      await reembolso(u, 4000, g2);
      const m2 = await mes(u);
      check("un gasto vivo de 100 € con 40 € reembolsados: gasto neto 60 €, ingreso 0", n(m2.net_expense_cents) === 6000 && n(m2.income_cents ?? 0) === 0, JSON.stringify(m2));
    }

    console.log("\n— M2b: los reembolsos no superan al gasto —\n");
    {
      const u = await usuario();
      const g = await gasto(u, 1000);
      const r1 = await reembolso(u, 1500, g);
      check("un reembolso de 15 € de un gasto de 10 €: rechazado (23514)", r1.error?.code === "23514", r1.error?.code ?? "aceptado");
      check("… con un mensaje en español que dice el tope", /no puede ser mayor que el gasto.*10,00 €/.test(r1.error?.message ?? ""), r1.error?.message);
      const r2 = await reembolso(u, 600, g);
      check("uno de 6 €: aceptado", !r2.error, r2.error?.message);
      const r3 = await reembolso(u, 500, g);
      check("otro de 5 € (sumarían 11 €): rechazado, «como mucho, de 4,00 €»", r3.error?.code === "23514" && /4,00 €/.test(r3.error.message), r3.error?.message);
      const r4 = await reembolso(u, 400, g);
      check("otro de 4 € (justo el total): aceptado", !r4.error, r4.error?.message);
      const [cat] = (await como(u.uid, `select net_cents from public.category_breakdown(${MES}) where category_id = $1`, [u.cat])).filas;
      check("la categoría queda en 0, no en negativo", n(cat?.net_cents ?? 0) === 0, JSON.stringify(cat));
      const baja = await como(u.uid, "update public.transaction set amount_cents = 900 where id = $1", [g], { deshacer: true });
      check("bajar el gasto por debajo de lo reembolsado (9 € < 10 €): rechazado", baja.error?.code === "23514", baja.error?.message ?? "aceptado");
      const sube = await como(u.uid, "update public.transaction set amount_cents = 2000 where id = $1", [g], { deshacer: true });
      check("subirlo: aceptado", !sube.error, sube.error?.message);
      const subeR = await como(u.uid, "update public.transaction set amount_cents = 700 where id = $1", [r2.filas[0].id], { deshacer: true });
      check("subir un reembolso por encima de lo que queda: rechazado", subeR.error?.code === "23514", subeR.error?.message ?? "aceptado");
      const desc = await como(u.uid, "update public.transaction set status = 'DISCARDED' where id = $1", [r4.filas[0].id]);
      const r5 = await reembolso(u, 400, g);
      check("descartado uno, cabe otro del mismo importe", !desc.error && !r5.error, desc.error?.message ?? r5.error?.message);
      const reac = await como(u.uid, "update public.transaction set status = 'CONFIRMED' where id = $1", [r4.filas[0].id], { deshacer: true });
      check("… y reactivar el descartado (sumarían 14 €): rechazado", reac.error?.code === "23514", reac.error?.message ?? "aceptado");
    }

    console.log("\n— M1: borrar un gasto con reembolsos —\n");
    {
      const u = await usuario();
      const g = await gasto(u, 50000);
      const r = await reembolso(u, 50000, g);
      const antesM = await mes(u);
      const del = await como(u.uid, "delete from public.transaction where id = $1", [g]);
      check("borrar el gasto con un reembolso vivo: rechazado", !!del.error, "se borró");
      check("… con un mensaje claro en español (55000)", del.error?.code === "55000" && /un reembolso \(500,00 €\)/.test(del.error.message) && /ingreso/.test(del.error.message), del.error?.message);
      const despuesM = await mes(u);
      check("… y el ingreso del mes no cambia", n(despuesM.income_cents ?? 0) === n(antesM.income_cents ?? 0), JSON.stringify({ antesM, despuesM }));
      const [sigue] = await q("select count(*)::int as n from public.transaction where id = $1", [g]);
      check("… el gasto sigue ahí", sigue.n === 1);
      const delR = await como(u.uid, "delete from public.transaction where id = $1", [r.filas[0].id]);
      const del2 = await como(u.uid, "delete from public.transaction where id = $1", [g]);
      check("borrado antes el reembolso, el gasto se borra", !delR.error && !del2.error, delR.error?.message ?? del2.error?.message);

      const g3 = await gasto(u, 2000);
      const r3 = await reembolso(u, 2000, g3);
      await como(u.uid, "update public.transaction set status = 'DISCARDED' where id = $1", [r3.filas[0].id]);
      const del3 = await como(u.uid, "delete from public.transaction where id = $1", [g3]);
      check("un reembolso DESCARTADO no impide borrar el gasto", !del3.error, del3.error?.message);

      const g4 = await gasto(u, 3000);
      const r4 = await reembolso(u, 3000, g4);
      const quitar = await como(u.uid, "update public.transaction set reimburses_id = null, reimburses_target_type = null where id = $1", [r4.filas[0].id]);
      const del4 = await como(u.uid, "delete from public.transaction where id = $1", [g4]);
      check("quitado el enlace a mano (ahora SÍ es un ingreso, porque lo dice el usuario), el gasto se borra", !quitar.error && !del4.error, quitar.error?.message ?? del4.error?.message);
    }

    console.log("\n— Los borrados explícitos siguen funcionando —\n");
    {
      const u = await usuario();
      const g = await gasto(u, 10000, "CONFIRMED", u.otra);
      await reembolso(u, 10000, g); // el reembolso, en «Banco»; el gasto, en «Otra»
      const prev = await como(u.uid, "select public.account_delete_preview($1) as p", [u.otra]);
      const cr = prev.filas?.[0]?.p?.cross_reimbursements?.incomes_elsewhere;
      check("la vista previa de borrar la cuenta avisa del reembolso de otra cuenta", n(cr?.count) === 1, JSON.stringify(cr));
      const del = await como(u.uid, "select public.delete_account($1, 'Otra') as r", [u.otra]);
      check("delete_account (avisado y confirmado con el nombre) borra la cuenta", !del.error, del.error?.message);
      const m = await mes(u);
      check("… y el reembolso pasa a ingreso, como dice el aviso", n(m.income_cents) === 10000, JSON.stringify(m));

      const v = await usuario();
      const gv = await gasto(v, 7000);
      await reembolso(v, 7000, gv);
      await q("savepoint baja");
      let errBaja = null;
      try {
        await q("delete from auth.users where id = $1", [v.uid]);
      } catch (e) {
        errBaja = e;
      }
      await q("rollback to savepoint baja");
      check("dar de baja al usuario (cascada) no lo impide el disparador", !errBaja, errBaja?.message);
    }

    console.log("\n— Esquema —\n");
    const [cfg] = await q(`
      select count(*) filter (where p.prosecdef) as definer,
             count(*) filter (where not coalesce(p.proconfig, '{}') @> array['search_path=""']) as sin_path
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ('tg_reembolso_no_supera_gasto', 'tg_gasto_con_reembolsos', 'euros')`);
    check("disparadores security invoker y con search_path = ''", n(cfg.definer) === 0 && n(cfg.sin_path) === 0, JSON.stringify(cfg));
    const [vi] = await q("select reloptions from pg_class where oid = 'public.v_transaction_econ'::regclass");
    check("v_transaction_econ sigue security_invoker", (vi.reloptions ?? []).includes("security_invoker=true"));
    const [viol] = await q(`
      select count(*)::int as n from (
        select g.id from public.transaction g
        join public.transaction r on r.user_id = g.user_id and r.reimburses_id = g.id and r.status <> 'DISCARDED'
        group by g.id, g.amount_cents having sum(r.amount_cents) > g.amount_cents) x`);
    check("en la base no queda ningún gasto con más reembolsado que su importe", viol.n === 0);

    console.log("\n— Datos reales (solo si cuadran) —\n");
    let iguales = 0;
    for (const [i, u] of reales.entries()) {
      const d = compararFotos(antes[i], await fotoUsuario(client, u, { conHoy: false }));
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
