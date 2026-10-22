/**
 * Prueba de 20261020091100_idempotencia_de_altas.sql (H-22, lado SQL):
 *  · transaction.client_id: el mismo formulario enviado dos veces choca
 *    (23505); sin client_id, como antes;
 *  · import_transactions toma un candado por cuenta mientras importa.
 *
 *   node --env-file=.env.local scripts/test-idempotencia.mjs
 *
 * TODO dentro de UNA transacción que se deshace (y una segunda conexión que
 * solo PREGUNTA por el candado, sin escribir nada).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261020091100";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
// Solo observa el candado; con «sin-pendientes» la precarga con-pendientes.mjs no la toca.
const otra = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb, application_name: "sin-pendientes" });
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
    const r = await q(sql, params);
    await q("release savepoint i");
    return { filas: r, error: null };
  } catch (e) {
    await q("rollback to savepoint i");
    await q("release savepoint i");
    return { filas: null, error: e };
  }
}

async function main() {
  await client.connect();
  await otra.connect();
  await client.query("begin");
  try {
    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})\n`);

    const usuario = async () => (await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id"))[0].id;
    const u = await usuario();
    const v = await usuario();
    const cuenta = async (uid) => (await q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id::text as id", [uid]))[0].id;
    const b = await cuenta(u);
    const bv = await cuenta(v);
    const alta = (uid, cta, clientId) =>
      intento(
        "insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,client_id) values ($1,'EXPENSE',1250,'café',private.hoy(),$2,$3) returning id",
        [uid, cta, clientId],
      );

    console.log("— Alta manual —\n");
    const id = randomUUID();
    const a1 = await alta(u, b, id);
    const a2 = await alta(u, b, id);
    check("el mismo formulario (client_id) dos veces: la segunda choca (23505)", !a1.error && a2.error?.code === "23505", a2.error?.code ?? "aceptada");
    check("… y el choque nombra el índice (la acción puede decir «ya estaba guardado»)", /tx_client_id_uq/.test(a2.error?.message ?? ""));
    const a3 = await alta(v, bv, id);
    check("el mismo uuid en otro usuario no choca (el índice es por usuario)", !a3.error, a3.error?.message);
    const s1 = await alta(u, b, null);
    const s2 = await alta(u, b, null);
    check("sin client_id, dos altas iguales entran (como antes)", !s1.error && !s2.error);

    console.log("\n— Importación —\n");
    const [k] = await q("select pg_catalog.hashtextextended('cartera.importar:' || $1::text, 0)::text as k", [b]);
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u, role: "authenticated", aal: "aal2" })]);
    await q("set local role authenticated");
    const [imp] = await q(
      "select * from public.import_transactions($1, $2::jsonb, true, false)",
      [b, JSON.stringify([{ occurred_on: "2026-09-01", description: "Mercadona", amount_cents: -2350 }])],
    );
    await q("reset role");
    check("importar sigue funcionando (1 insertada)", imp.insertadas === 1, JSON.stringify(imp));
    const [libre] = (await otra.query("select pg_try_advisory_xact_lock($1::bigint) as libre", [k.k])).rows;
    check("mientras dura su transacción, otra conexión NO puede importar a la misma cuenta (candado tomado)", libre.libre === false);
    const [otraCuenta] = (await otra.query("select pg_try_advisory_xact_lock(pg_catalog.hashtextextended('cartera.importar:' || $1::text, 0)) as libre", [bv])).rows;
    check("… pero sí a otra cuenta", otraCuenta.libre === true);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
    await otra.end();
  }
  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
  await otra.end().catch(() => {});
  process.exit(2);
});
