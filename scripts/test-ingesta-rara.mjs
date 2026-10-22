/**
 * Prueba de 20261020090700_ingesta_sin_perder_pagos.sql (H-02, lado SQL): una
 * tarjeta o una fecha raras ya no hacen que ingest_transaction LANCE (y se
 * pierda el pago sin rastro): o se entienden, o acaban en ingest_dead_letter
 * con su motivo.
 *
 *   node --env-file=.env.local scripts/test-ingesta-rara.mjs
 *
 * TODO dentro de UNA transacción que se deshace; las migraciones pendientes se
 * aplican ahí dentro. Usuario y dispositivo sintéticos (token inventado).
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261020090700";
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

/** Llama como el endpoint (rol de servicio). Devuelve { res, error }. */
async function pago(token, cents, payload) {
  await q("savepoint pago");
  try {
    await q("set local role service_role");
    const [r] = await q("select public.ingest_transaction($1, $2, $3::jsonb) as res", [token, cents, JSON.stringify(payload)]);
    await q("reset role");
    await q("release savepoint pago");
    return { res: r.res, error: null };
  } catch (e) {
    await q("rollback to savepoint pago");
    await q("release savepoint pago");
    return { res: null, error: e };
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
    const [t] = await q("insert into public.account (user_id,name,type) values ($1,'Tarjeta','BANCO') returning id::text as id", [uid]);
    await q("update public.profile set default_ingest_account_id = $2 where user_id = $1", [uid, b.id]);
    await q("insert into public.card (user_id, account_id, last4, type) values ($1, $2, '4321', 'DEBITO')", [uid, t.id]);
    const token = `cart_${randomBytes(24).toString("hex")}`;
    await q(
      "insert into public.ingest_device (user_id, name, token_hash, token_prefix) values ($1, 'atajo-test', extensions.digest($2, 'sha256'), 'cart_')",
      [uid, token],
    );
    const muertos = async () => (await q("select reason, payload from public.ingest_dead_letter where user_id = $1 order by id", [uid]));
    const cuentaDe = async (id) => (await q("select account_id::text as a, card_last4 from public.transaction where id = $1", [id]))[0];

    console.log("— Tarjeta —\n");
    const largo = await pago(token, 1234, { card: "4111 1111 1111 4321", merchant: "Largo", external_id: "e1" });
    check("un número de tarjeta largo no lanza", !largo.error, largo.error?.message);
    const mov = largo.res?.ok ? await cuentaDe(largo.res.id) : null;
    check("… usa los 4 últimos para enrutar (va a la cuenta de la tarjeta 4321) y guarda solo esos 4", mov?.a === t.id && mov?.card_last4 === "4321", JSON.stringify({ res: largo.res, mov }));
    const corto = await pago(token, 1234, { card: "12", merchant: "Corto", external_id: "e2" });
    check("una tarjeta de 2 dígitos no lanza", !corto.error, corto.error?.message);
    check("… responde invalid_card", corto.res?.ok === false && corto.res?.error === "invalid_card", JSON.stringify(corto.res));
    let dl = await muertos();
    check("… y deja el pago en ingest_dead_letter con motivo BAD_CARD", dl.some((d) => d.reason === "BAD_CARD" && d.payload.merchant === "Corto"), JSON.stringify(dl.map((d) => d.reason)));
    const sin = await pago(token, 1234, { card: "Visa", merchant: "Sin dígitos", external_id: "e3" });
    const movSin = sin.res?.ok ? await cuentaDe(sin.res.id) : null;
    check("una tarjeta sin dígitos, como antes: a la cuenta por defecto, sin tarjeta", movSin?.a === b.id && movSin?.card_last4 === null, JSON.stringify({ res: sin.res, movSin }));

    console.log("\n— Fecha —\n");
    for (const [txt, desc] of [["ayer por la tarde", "texto"], ["2026-02-30T10:00:00Z", "30 de febrero"], ["1990-01-01T10:00:00Z", "1990"], ["2099-01-01T10:00:00Z", "2099"]]) {
      const r = await pago(token, 999, { occurred_at: txt, merchant: `Fecha ${desc}`, external_id: `f-${desc}` });
      check(`fecha «${desc}»: no lanza y responde invalid_date`, !r.error && r.res?.ok === false && r.res?.error === "invalid_date", r.error?.message ?? JSON.stringify(r.res));
    }
    dl = await muertos();
    check("… las cuatro quedan en ingest_dead_letter con motivo BAD_DATE", dl.filter((d) => d.reason === "BAD_DATE").length === 4, JSON.stringify(dl.map((d) => d.reason)));
    const buena = await pago(token, 999, { occurred_at: "2026-10-15T22:30:00Z", merchant: "Buena", external_id: "f-ok" });
    const [fb] = buena.res?.ok ? await q("select occurred_on::text as d, occurred_time::text as h from public.transaction where id = $1", [buena.res.id]) : [null];
    check("una fecha ISO buena entra, en hora de Madrid (22:30Z → 16 oct 00:30)", fb?.d === "2026-10-16" && fb?.h === "00:30:00", JSON.stringify({ res: buena.res, fb }));
    const vacia = await pago(token, 999, { occurred_at: "", merchant: "Vacía", external_id: "f-vacia" });
    check("una fecha vacía es «ahora», como antes", vacia.res?.ok === true, JSON.stringify(vacia.res));

    console.log("\n— Cualquier otro rechazo de la base —\n");
    // Un movimiento que la base rechaza: más de 1.000 M€ (CHECK tx_amount_positive).
    const largo2 = await pago(token, 100_000_000_001, { merchant: "Enorme", external_id: "db-1" });
    check("un rechazo de la base al insertar no lanza", !largo2.error, largo2.error?.message);
    dl = await muertos();
    const db = dl.find((d) => d.reason === "DB_ERROR");
    check(
      "… responde db_error y queda en ingest_dead_letter (DB_ERROR, con el SQLSTATE)",
      largo2.res?.ok === false && largo2.res?.error === "db_error" && !!db?.payload?._sqlstate,
      JSON.stringify({ res: largo2.res, db: db?.payload?._sqlstate }).slice(0, 300),
    );
    const [cnt] = await q("select count(*)::int as n from public.transaction where user_id = $1", [uid]);
    check("solo entraron los tres buenos (largo, sin dígitos, fecha buena) y la vacía", cnt.n === 4, `${cnt.n}`);

    const [cfg] = await q("select prosecdef, proconfig from pg_proc where oid = 'public.ingest_transaction(text,bigint,jsonb)'::regprocedure");
    check("ingest_transaction sigue security definer con search_path = ''", cfg.prosecdef && (cfg.proconfig ?? []).includes('search_path=""'));
    const [perm] = await q(
      "select has_function_privilege('anon', 'public.ingest_transaction(text,bigint,jsonb)', 'execute') as anon, has_function_privilege('authenticated', 'public.ingest_transaction(text,bigint,jsonb)', 'execute') as auth",
    );
    check("… y sin permiso para anon ni authenticated (solo el servicio)", !perm.anon && !perm.auth, JSON.stringify(perm));
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
