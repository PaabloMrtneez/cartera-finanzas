/**
 * Prueba de 20261022090000_avisos_de_limite_sin_ambiguedad.sql: los avisos de
 * límite (80 % y 100 %) que reparte /api/notificar salen de verdad.
 *
 *   node --env-file=.env.local scripts/test-aviso-limite.mjs
 *
 * Antes, claim_budget_alerts abortaba siempre con 42702 («threshold» ambiguo).
 * TODO dentro de UNA transacción que se deshace; las migraciones pendientes se
 * aplican ahí dentro. Usuario sintético. La función recorre los límites de
 * todos los usuarios, así que solo se miran las filas del sintético (y todo lo
 * que anota de los demás se deshace con el rollback).
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

// HASTA=20261021000000 la corre SIN la migración, para ver el fallo de antes.
const VERSION = process.env.HASTA ?? "20261022090000";
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

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})\n`);

    const [{ id: uid }] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const [{ id: banco }] = await q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id", [uid]);
    const nuevaCategoria = async (nombre) =>
      (await q("insert into public.category (user_id,name,type,color,icon) values ($1,$2,'EXPENSE','#7f6a45','cart') returning id", [uid, nombre]))[0].id;
    const gasto = (cat, cents) =>
      q(
        `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
         values ($1,'EXPENSE',$2,'x',private.hoy(),$3,$4,'EXPENSE','MANUAL','CONFIRMED')`,
        [uid, cents, banco, cat],
      );
    const limite = (cat, cap, warn = true) =>
      q("insert into public.budget (user_id,category_id,monthly_cap_cents,warn_at_80) values ($1,$2,$3,$4)", [uid, cat, cap, warn]);

    // Comida: 85 € de 100 → 80 %. Ocio: 120 € de 100 → 100 % (cruza los dos a la vez).
    // Ropa: 50 € de 100 → nada. Libros: 90 € de 100 pero sin aviso del 80 → nada.
    const comida = await nuevaCategoria("Comida-test");
    const ocio = await nuevaCategoria("Ocio-test");
    const ropa = await nuevaCategoria("Ropa-test");
    const libros = await nuevaCategoria("Libros-test");
    await limite(comida, 10_000);
    await limite(ocio, 10_000);
    await limite(ropa, 10_000);
    await limite(libros, 10_000, false);
    await gasto(comida, 8_500);
    await gasto(ocio, 12_000);
    await gasto(ropa, 5_000);
    await gasto(libros, 9_000);

    const reclamar = async () => {
      await q("savepoint reclamar");
      try {
        await q("set local role service_role");
        const filas = await q(
          "select user_id::text as uid, category_name, threshold, spent_cents::bigint as gastado, cap_cents::bigint as tope from public.claim_budget_alerts(date_trunc('month', private.hoy())::date)",
        );
        await q("reset role");
        await q("release savepoint reclamar");
        return { filas: filas.filter((f) => f.uid === uid), error: null };
      } catch (e) {
        await q("rollback to savepoint reclamar");
        await q("release savepoint reclamar");
        return { filas: [], error: e };
      }
    };

    console.log("— Primera pasada —\n");
    const primera = await reclamar();
    check("claim_budget_alerts no lanza (antes: 42702, «threshold» ambiguo)", !primera.error, primera.error?.message);
    const de = (nombre) => primera.filas.find((f) => f.category_name === nombre);
    check("Comida al 85 %: aviso del 80", de("Comida-test")?.threshold === 80, JSON.stringify(primera.filas));
    check(
      "Ocio al 120 %: UN aviso, el del 100 (no dos)",
      primera.filas.filter((f) => f.category_name === "Ocio-test").length === 1 && de("Ocio-test")?.threshold === 100,
      JSON.stringify(primera.filas),
    );
    check("… con lo gastado y el tope", Number(de("Ocio-test")?.gastado) === 12_000 && Number(de("Ocio-test")?.tope) === 10_000);
    check("Ropa al 50 %: sin aviso", !de("Ropa-test"));
    check("Libros al 90 % sin aviso del 80 activado: sin aviso", !de("Libros-test"));
    const anotados = await q(
      "select threshold from public.budget_alert where user_id = $1 order by threshold",
      [uid],
    );
    check("se anotan los umbrales alcanzados (80 de Comida; 80 y 100 de Ocio)", anotados.length === 3, JSON.stringify(anotados));

    console.log("\n— Segunda pasada —\n");
    const segunda = await reclamar();
    check("no repite ningún aviso ya dado", !segunda.error && segunda.filas.length === 0, segunda.error?.message ?? JSON.stringify(segunda.filas));

    await gasto(comida, 2_000); // Comida pasa al 105 %.
    const tercera = await reclamar();
    check(
      "si Comida cruza después el 100, avisa del 100 (una vez)",
      tercera.filas.length === 1 && tercera.filas[0].category_name === "Comida-test" && tercera.filas[0].threshold === 100,
      JSON.stringify(tercera.filas),
    );

    const [cfg] = await q(
      `select p.prosecdef, p.proconfig,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as servicio
         from pg_proc p where p.oid = 'public.claim_budget_alerts(date)'::regprocedure`,
    );
    check(
      "sigue security definer, search_path = '' y solo para service_role",
      cfg.prosecdef && (cfg.proconfig ?? []).includes('search_path=""') && !cfg.anon && !cfg.auth && cfg.servicio,
      JSON.stringify(cfg),
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
