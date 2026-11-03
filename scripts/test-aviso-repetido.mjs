/**
 * Prueba de 20261103090000_aviso_repetido_de_cartera.sql: el mismo aviso de
 * Cartera dos veces entra pendiente y con «¿Repetido?», sin perder ninguno.
 *
 *   node --env-file=.env.local scripts/test-aviso-repetido.mjs
 *
 *  · Dos avisos iguales (comercio, importe y cuenta) en ≤ 10 minutos: el
 *    segundo, PENDIENTE y con nota; el primero, como estaba. Los dos existen.
 *  · Con regla de comercio: el primero confirmado, el segundo pendiente pero
 *    con su categoría.
 *  · Otro comercio, otro importe, otra cuenta, más de 10 minutos o el primero
 *    descartado: sin nota.
 *  · El atajo NFC no cambia, y el cruce NFC ↔ aviso sigue fundiendo.
 *  · Un reintento del mismo aviso sigue sin duplicar.
 *  · Los usuarios reales: sus cifras, idénticas (solo huellas).
 *
 * TODO dentro de UNA transacción que se deshace. Usuarios y dispositivo
 * sintéticos (token inventado).
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261103090000";
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
async function envio(token, cents, payload) {
  await q("savepoint envio");
  try {
    await q("set local role service_role");
    const [r] = await q("select public.ingest_transaction($1, $2, $3::jsonb) as res", [token, cents, JSON.stringify(payload)]);
    await q("reset role");
    await q("release savepoint envio");
    return r.res;
  } catch (e) {
    await q("rollback to savepoint envio");
    await q("release savepoint envio");
    return { ok: false, error: e.message };
  }
}

const aviso = (tarjeta, comercio, occurred_at, id) => ({
  source: "cartera", origin: "CARTERA", wallet_card: tarjeta, merchant: comercio, occurred_at, external_id: `cartera_${id}`,
});
const nfc = (comercio, card, occurred_at, id) => ({ merchant: comercio, card, occurred_at, external_id: `atajo_${id}` });

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    await aplicarPendientes(client, { hasta: String(Number(VERSION) - 1) });
    const reales = (await q("select id::text as id from auth.users order by created_at")).map((r) => r.id);
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

    console.log("\n— Esquema —\n");
    const [cfg] = await q("select prosecdef, proconfig from pg_proc where oid = 'public.ingest_transaction(text,bigint,jsonb)'::regprocedure");
    check("ingest_transaction sigue security definer con search_path = ''", cfg.prosecdef && (cfg.proconfig ?? []).includes('search_path=""'));
    const [priv] = await q(`select has_function_privilege('anon', 'public.ingest_transaction(text,bigint,jsonb)', 'execute') as anon,
                                   has_function_privilege('authenticated', 'public.ingest_transaction(text,bigint,jsonb)', 'execute') as auth,
                                   has_function_privilege('service_role', 'public.ingest_transaction(text,bigint,jsonb)', 'execute') as srv`);
    check("solo service_role puede llamar a la ingesta", !priv.anon && !priv.auth && priv.srv);

    console.log("\n— Funcional —\n");
    const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const uid = u.id;
    const cuenta = async (nombre) =>
      (await q("insert into public.account (user_id, name, type) values ($1, $2, 'BANCO') returning id::text as id", [uid, nombre]))[0].id;
    const santander = await cuenta("Santander");
    await cuenta("Revolut");
    await q("insert into public.card (user_id, account_id, last4, type) values ($1, $2, '1111', 'DEBITO')", [uid, santander]);
    const [gasolina] = await q("insert into public.category (user_id, name, type) values ($1, 'Gasolina', 'EXPENSE') returning id::text as id", [uid]);
    await q("insert into public.merchant_rule (user_id, match_text, category_id, category_type) values ($1, 'Ballenoil', $2, 'EXPENSE')", [uid, gasolina.id]);
    const token = `cart_${randomBytes(24).toString("hex")}`;
    await q("insert into public.ingest_device (user_id, name, token_hash, token_prefix) values ($1, 'atajo-test', extensions.digest($2, 'sha256'), 'cart_')", [uid, token]);
    const mov = async (id) =>
      (await q("select status, note, category_id::text as cat, account_id::text as a from public.transaction where id = $1", [id]))[0];
    const cuantos = async () => Number((await q("select count(*) from public.transaction where user_id = $1", [uid]))[0].count);
    const repetido = (m) => /^¿Repetido\?/.test(m?.note ?? "");

    // El caso real: el repostaje de 65 € avisado dos veces, a las 22:52 y a las 22:54.
    const g1 = await envio(token, 6500, aviso("Santander", "Ballenoil Getafe II M50", "2026-10-31T22:52:00+01:00", "g1"));
    const g2 = await envio(token, 6500, aviso("Santander", "Ballenoil Getafe II M50", "2026-10-31T22:54:00+01:00", "g2"));
    const m1 = await mov(g1.id);
    const m2 = await mov(g2.id);
    check("el primer aviso, como siempre: confirmado por la regla y sin nota", m1?.status === "CONFIRMED" && m1?.note === null, JSON.stringify(m1));
    check("el segundo, igual a los 2 min: entra (no se pierde)", g2.ok === true && g2.id !== g1.id && g2.merged === false, JSON.stringify(g2));
    check("… PENDIENTE y con «¿Repetido?»", m2?.status === "PENDING" && repetido(m2), JSON.stringify(m2));
    check("… la nota dice cuándo, cuánto y dónde", /Hace 2 min/.test(m2?.note ?? "") && /65,00/.test(m2?.note ?? "") && /Ballenoil Getafe II M50/.test(m2?.note ?? ""), m2?.note);
    check("… y conserva la categoría de la regla", m2?.cat === gasolina.id);
    check("… la respuesta al móvil lo cuenta como pendiente", g2.status === "PENDING");

    // El mismo minuto.
    await envio(token, 990, aviso("Santander", "Peaje AP-6", "2026-11-01T10:00:00+01:00", "p1"));
    const p2 = await envio(token, 990, aviso("Santander", "Peaje AP-6", "2026-11-01T10:00:40+01:00", "p2"));
    check("en el mismo minuto: «En el mismo minuto»", /^¿Repetido\? En el mismo minuto/.test((await mov(p2.id))?.note ?? ""), (await mov(p2.id))?.note);

    // Nada que ver: sin nota.
    await envio(token, 450, aviso("Santander", "Cafeteria", "2026-11-01T11:00:00+01:00", "c1"));
    const c2 = await envio(token, 450, aviso("Santander", "Panaderia", "2026-11-01T11:01:00+01:00", "c2"));
    check("otro comercio con el mismo importe: sin nota", (await mov(c2.id))?.note === null);
    const c3 = await envio(token, 460, aviso("Santander", "Cafeteria", "2026-11-01T11:02:00+01:00", "c3"));
    check("el mismo comercio con otro importe: sin nota", (await mov(c3.id))?.note === null);
    const c4 = await envio(token, 450, aviso("Revolut", "Cafeteria", "2026-11-01T11:03:00+01:00", "c4"));
    check("el mismo comercio e importe en OTRA cuenta: sin nota", (await mov(c4.id))?.note === null);
    const c5 = await envio(token, 450, aviso("Santander", "Cafeteria", "2026-11-01T11:11:00+01:00", "c5"));
    check("a 11 minutos del anterior: sin nota", (await mov(c5.id))?.note === null);

    // Mayúsculas y espacios no cambian el comercio.
    const c6 = await envio(token, 450, aviso("Santander", "  CAFETERIA ", "2026-11-01T11:15:00+01:00", "c6"));
    check("el mismo comercio escrito distinto (mayúsculas, espacios): con nota", repetido(await mov(c6.id)), (await mov(c6.id))?.note);

    // El primero descartado ya no cuenta.
    const d1 = await envio(token, 700, aviso("Santander", "Kiosco", "2026-11-01T12:00:00+01:00", "d1"));
    await q("update public.transaction set status = 'DISCARDED' where id = $1", [d1.id]);
    const d2 = await envio(token, 700, aviso("Santander", "Kiosco", "2026-11-01T12:02:00+01:00", "d2"));
    check("si el primero se descartó, el segundo no lleva nota", !repetido(await mov(d2.id)));

    // Pagos de verdad repetidos (tres partidas de 1 €): entran todos.
    const antes = await cuantos();
    for (const [i, h] of ["21:44", "21:49", "21:55"].entries()) {
      await envio(token, 100, aviso("Revolut", "Ilusiona Tresaguas", `2026-10-31T${h}:00+01:00`, `i${i}`));
    }
    check("tres avisos iguales a 5 minutos: entran los tres", (await cuantos()) === antes + 3);

    // Un reintento del mismo aviso sigue sin duplicar.
    const tras = await cuantos();
    const g2b = await envio(token, 6500, aviso("Santander", "Ballenoil Getafe II M50", "2026-10-31T22:54:00+01:00", "g2"));
    check("el reintento de un aviso: duplicado, no crea nada", g2b.duplicate === true && g2b.id === g2.id && (await cuantos()) === tras);

    // El NFC no cambia: dos pagos iguales seguidos por NFC, sin nota.
    await envio(token, 330, nfc("Bar", "1111", "2026-11-01T13:00:00+01:00", "n1"));
    const n2 = await envio(token, 330, nfc("Bar", "1111", "2026-11-01T13:02:00+01:00", "n2"));
    check("el atajo NFC no se marca: dos pagos iguales seguidos, sin nota", (await mov(n2.id))?.note === null);

    // Y el cruce NFC ↔ aviso sigue fundiendo.
    const n3 = await envio(token, 1250, nfc("ZARA", "1111", "2026-11-01T15:00:00+01:00", "n3"));
    const tras3 = await cuantos();
    const a3 = await envio(token, 1250, aviso("Santander", "ZARA ESPAÑA SA", "2026-11-01T15:01:00+01:00", "a3"));
    check("NFC y luego el aviso del mismo pago: se sigue fundiendo", a3.merged === true && a3.id === n3.id && (await cuantos()) === tras3, JSON.stringify(a3));
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
