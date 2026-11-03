/**
 * Prueba de 20261103100000_fondo_archivado_en_las_curvas.sql: un fondo
 * archivado deja de contar en las curvas de patrimonio desde que se archiva,
 * igual que en la cifra de cabecera, sin cambiar el pasado.
 *
 *   node --env-file=.env.local scripts/test-fondo-archivado.mjs
 *
 *  · archived_on (el día de Madrid) lo pone y lo quita el disparador; no se
 *    reescribe a mano.
 *  · Archivado: net_worth_daily(hoy) = v_net_worth; los cierres de meses
 *    anteriores, idénticos a antes de archivar.
 *  · Desarchivado: vuelve a contar en toda la curva.
 *  · Los usuarios de prueba con un fondo archivado (el que deja la e2e) ya
 *    cuadran; los reales, cifras idénticas (solo huellas).
 *
 * TODO dentro de UNA transacción que se deshace.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261103100000";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
const n = (v) => Number(v ?? 0);

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

/** Ejecuta `trabajo` con la sesión de `uid` (authenticated + aal2) y vuelve a postgres. */
async function comoUsuario(uid, trabajo) {
  await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
  await q("set local role authenticated");
  try {
    return await trabajo();
  } finally {
    await q("reset role");
  }
}

/** Hoy en la curva diaria frente a la cifra de cabecera. */
async function cuadraHoy(uid) {
  return comoUsuario(uid, async () => {
    const [v] = await q("select net_worth_cents, invested_cents from public.v_net_worth");
    const [d] = await q("select net_worth_cents, invested_cents from public.net_worth_daily(current_date, current_date)");
    return { v, d, iguales: n(v?.net_worth_cents) === n(d?.net_worth_cents) && n(v?.invested_cents) === n(d?.invested_cents) };
  });
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    await aplicarPendientes(client, { hasta: String(Number(VERSION) - 1) });
    const reales = (await q("select id::text as id from auth.users where email not like '%@cartera.local' order by created_at")).map((r) => r.id);
    const fotos = [];
    for (const r of reales) fotos.push(await fotoUsuario(client, r, { conHoy: false }));

    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})\n`);

    console.log("— Usuarios reales (solo huellas) —\n");
    let iguales = 0;
    for (const [i, r] of reales.entries()) {
      if (compararFotos(fotos[i], await fotoUsuario(client, r, { conHoy: false })).length === 0) iguales++;
    }
    check(`cifras de los ${reales.length} usuarios reales idénticas`, iguales === reales.length, `${iguales}`);
    const [{ c: archivadosReales }] = await q(
      "select count(*)::int as c from public.investment_position p join auth.users u on u.id = p.user_id where p.archived and u.email not like '%@cartera.local'",
    );
    check("ningún usuario real tiene un fondo archivado (nadie cambia hoy)", archivadosReales === 0, `${archivadosReales}`);

    console.log("\n— Esquema —\n");
    const [inc] = await q("select count(*)::int as c from public.investment_position where archived <> (archived_on is not null)");
    check("los ya archivados reciben su fecha; los demás, ninguna", inc.c === 0);
    const [fn] = await q("select prosecdef, proconfig from pg_proc where oid = 'private.account_worth_on(date[])'::regprocedure");
    check("account_worth_on sigue security invoker con search_path = ''", !fn.prosecdef && (fn.proconfig ?? []).includes('search_path=""'));
    const [tg] = await q("select has_function_privilege('authenticated', 'private.tg_posicion_archivada()', 'execute') as auth");
    check("el disparador no se puede llamar desde la app", !tg.auth);

    console.log("\n— Usuarios de prueba —\n");
    const pruebas = await q(`select u.id::text as id, u.email from auth.users u where u.email like '%@cartera.local'
                             and exists (select 1 from public.investment_position p where p.user_id = u.id and p.archived)`);
    for (const p of pruebas) {
      const r = await cuadraHoy(p.id);
      check(`${p.email.split("@")[0]}, con un fondo archivado: la curva de hoy = la cifra`, r.iguales, JSON.stringify(r));
    }
    if (pruebas.length === 0) console.log("  (ningún usuario de prueba tiene hoy un fondo archivado)");

    console.log("\n— Funcional —\n");
    const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const uid = u.id;
    const [banco] = await q("insert into public.account (user_id, name, type, initial_balance_cents) values ($1, 'Banco', 'BANCO', 500000) returning id::text as id", [uid]);
    const [broker] = await q("insert into public.account (user_id, name, type) values ($1, 'Broker', 'INVERSION') returning id::text as id", [uid]);
    const [pos] = await q(
      "insert into public.investment_position (user_id, name, account_id, account_type, since) values ($1, 'Fondo', $2, 'INVERSION', '2026-06-01') returning id::text as id, archived_on::text as archived_on",
      [uid, broker.id],
    );
    check("una posición nueva no lleva fecha de archivado", pos.archived_on === null);
    await q(
      `insert into public.transaction (user_id, type, amount_cents, description, occurred_on, account_id, to_account_id, position_id)
       values ($1, 'TRANSFER', 100000, 'Aportación', '2026-06-01', $2, $3, $4)`,
      [uid, banco.id, broker.id, pos.id],
    );
    await q("insert into public.valuation (user_id, position_id, date, value_cents) values ($1, $2, '2026-07-01', 120000)", [uid, pos.id]);

    const cierres = async () =>
      comoUsuario(uid, () => q("select period_month::text as m, net_worth_cents::text as nw, invested_cents::text as inv from public.net_worth_monthly(6) order by 1"));
    const pasados = (filas) => filas.filter((f) => f.m < new Date().toISOString().slice(0, 7) + "-01");
    const antes = await cierres();
    const r0 = await cuadraHoy(uid);
    check("sin archivar: la curva de hoy = la cifra, con el fondo dentro", r0.iguales && n(r0.v.invested_cents) === 120000, JSON.stringify(r0));

    await q("update public.investment_position set archived = true where id = $1", [pos.id]);
    const [a1] = await q("select archived_on::text as archived_on, private.hoy()::text as hoy from public.investment_position where id = $1", [pos.id]);
    check("archivar pone el día de hoy (Madrid)", a1.archived_on === a1.hoy, JSON.stringify(a1));
    const r1 = await cuadraHoy(uid);
    check("archivado: la curva de hoy = la cifra, ya sin el fondo (antes sobraba su valor)", r1.iguales && n(r1.d.invested_cents) === 0, JSON.stringify(r1));
    const despues = await cierres();
    check("los cierres de meses anteriores no cambian al archivar", JSON.stringify(pasados(antes)) === JSON.stringify(pasados(despues)),
      `${JSON.stringify(pasados(antes))} → ${JSON.stringify(pasados(despues))}`);
    const [julio] = await comoUsuario(uid, () => q("select invested_cents::text as inv from public.net_worth_daily('2026-07-15', '2026-07-15')"));
    check("en julio el fondo sigue contando (120.000)", julio.inv === "120000", JSON.stringify(julio));

    await q("update public.investment_position set archived_on = '2026-06-15' where id = $1", [pos.id]);
    const [a2] = await q("select archived_on::text as archived_on from public.investment_position where id = $1", [pos.id]);
    check("la fecha no se reescribe a mano", a2.archived_on === a1.archived_on, JSON.stringify(a2));
    const chapuza = await q("savepoint s").then(() =>
      q("update public.investment_position set archived = false, archived_on = '2026-06-15' where id = $1", [pos.id]).then(() => null, (e) => e),
    );
    await q(chapuza ? "rollback to savepoint s" : "release savepoint s");
    const [a3] = await q("select archived, archived_on::text as archived_on from public.investment_position where id = $1", [pos.id]);
    check("desarchivar quita la fecha aunque se mande una", chapuza === null && a3.archived === false && a3.archived_on === null, JSON.stringify({ a3, err: chapuza?.message }));
    const r3 = await cuadraHoy(uid);
    check("desarchivado: vuelve a contar y cuadra", r3.iguales && n(r3.d.invested_cents) === 120000, JSON.stringify(r3));

    const [nacido] = await q(
      "insert into public.investment_position (user_id, name, account_id, account_type, since, archived) values ($1, 'Viejo', $2, 'INVERSION', '2026-01-01', true) returning archived_on::text as archived_on",
      [uid, broker.id],
    );
    check("una posición dada de alta ya archivada recibe su fecha", nacido.archived_on !== null);
    const sinFecha = await q("savepoint s2").then(() =>
      q("alter table public.investment_position disable trigger tg_posicion_archivada")
        .then(() => q("update public.investment_position set archived = true, archived_on = null where id = $1", [pos.id]))
        .then(() => null, (e) => e),
    );
    await q("rollback to savepoint s2");
    check("la base rechaza un archivado sin fecha (CHECK)", sinFecha?.code === "23514", sinFecha?.message);
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
