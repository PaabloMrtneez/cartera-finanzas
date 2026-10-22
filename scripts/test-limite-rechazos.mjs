/**
 * Prueba de 20261020100000_limite_de_rechazos_del_atajo.sql (fase 2,
 * seguridad): los rechazos del Atajo cuentan para el mismo límite que los
 * cargos, y pasado el límite no se guarda una fila por petición.
 *
 *   node --env-file=.env.local scripts/test-limite-rechazos.mjs
 *
 * TODO dentro de UNA transacción que se deshace; las migraciones pendientes se
 * aplican ahí dentro. Usuario y dispositivos sintéticos (tokens inventados).
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261020100000";
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

/** Llama como el endpoint (rol de servicio). */
async function comoServicio(sql, params) {
  await q("set local role service_role");
  try {
    const [r] = await q(sql, params);
    return r.res;
  } finally {
    await q("reset role");
  }
}
const rechazo = (token, i) =>
  comoServicio("select public.record_ingest_rejection($1, 'BAD_AMOUNT', $2::jsonb) as res", [
    token,
    JSON.stringify({ amount: "[Importe]", n: i }),
  ]);
const pago = (token, i) =>
  comoServicio("select public.ingest_transaction($1, 150, $2::jsonb) as res", [
    token,
    JSON.stringify({ merchant: "Bar", external_id: `lim-${token.slice(-6)}-${i}` }),
  ]);

async function dispositivo(uid, nombre) {
  const token = `cart_${randomBytes(24).toString("hex")}`;
  const [d] = await q(
    "insert into public.ingest_device (user_id, name, token_hash, token_prefix) values ($1, $2, extensions.digest($3, 'sha256'), 'cart_') returning id::text as id",
    [uid, nombre, token],
  );
  return { token, id: d.id };
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
    await q("update public.profile set default_ingest_account_id = $2 where user_id = $1", [uid, b.id]);
    const muertosDe = async (devId) =>
      (await q("select reason from public.ingest_dead_letter where device_id = $1 order by id", [devId])).map((r) => r.reason);

    console.log("— Rechazos —\n");
    const a = await dispositivo(uid, "atajo-a");
    const primeros = [];
    for (let i = 1; i <= 60; i++) primeros.push(await rechazo(a.token, i));
    check("los 60 primeros rechazos se guardan", primeros.every((r) => r?.ok === true), JSON.stringify(primeros.find((r) => r?.ok !== true)));
    const pasados = [];
    for (let i = 61; i <= 70; i++) pasados.push(await rechazo(a.token, i));
    check("del 61 en adelante responden rate_limited", pasados.every((r) => r?.ok === false && r?.error === "rate_limited"), JSON.stringify(pasados[0]));
    let dl = await muertosDe(a.id);
    check(
      "… y solo dejan UNA marca RATE_LIMITED (61 filas, no 70)",
      dl.length === 61 && dl.filter((r) => r === "RATE_LIMITED").length === 1,
      `${dl.length} filas, ${dl.filter((r) => r === "RATE_LIMITED").length} RATE_LIMITED`,
    );
    const [cont] = await q("select rejected_count from public.ingest_device where id = $1", [a.id]);
    check("rejected_count cuenta solo los guardados (60)", cont.rejected_count === 60, `${cont.rejected_count}`);
    const despues = await pago(a.token, 1);
    check("el contador es compartido: un cargo del mismo dispositivo también da rate_limited", despues?.error === "rate_limited", JSON.stringify(despues));
    check("… sin escribir otra fila", (await muertosDe(a.id)).length === 61);
    const [tx] = await q("select count(*)::int as n from public.transaction where device_id = $1", [a.id]);
    check("… ni un movimiento", tx.n === 0, `${tx.n}`);

    console.log("\n— Cargos —\n");
    const c = await dispositivo(uid, "atajo-c");
    const buenos = [];
    for (let i = 1; i <= 60; i++) buenos.push(await pago(c.token, i));
    check("60 cargos dentro del límite entran", buenos.every((r) => r?.ok === true), JSON.stringify(buenos.find((r) => r?.ok !== true)));
    const demas = [];
    for (let i = 61; i <= 70; i++) demas.push(await pago(c.token, i));
    check("del 61 en adelante, rate_limited", demas.every((r) => r?.error === "rate_limited"), JSON.stringify(demas[0]));
    dl = await muertosDe(c.id);
    check("… con una sola marca RATE_LIMITED (antes, una fila por petición)", dl.length === 1 && dl[0] === "RATE_LIMITED", JSON.stringify(dl));

    console.log("\n— Lo que no cambia —\n");
    const falso = await rechazo(`cart_${randomBytes(24).toString("hex")}`, 0);
    check("un token inventado sigue siendo unauthorized", falso?.error === "unauthorized", JSON.stringify(falso));
    const [huerfanos] = await q("select count(*)::int as n from public.ingest_dead_letter where user_id = $1 and device_id not in ($2, $3)", [uid, a.id, c.id]);
    check("… y no guarda nada", huerfanos.n === 0);

    for (const firma of ["public.ingest_transaction(text,bigint,jsonb)", "public.record_ingest_rejection(text,text,jsonb)"]) {
      const [cfg] = await q(
        `select p.prosecdef, p.proconfig,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as servicio
           from pg_proc p where p.oid = $1::regprocedure`,
        [firma],
      );
      check(
        `${firma.split("(")[0]}: security definer, search_path = '', solo service_role`,
        cfg.prosecdef && (cfg.proconfig ?? []).includes('search_path=""') && !cfg.anon && !cfg.auth && cfg.servicio,
        JSON.stringify(cfg),
      );
    }
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
