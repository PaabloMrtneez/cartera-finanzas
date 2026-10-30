/**
 * Prueba de 20261027090000_avisos_de_cartera.sql: los avisos de Cartera
 * (iOS 27) como fuente de pagos.
 *
 *   node --env-file=.env.local scripts/test-avisos-cartera.mjs
 *
 *  · La cuenta sale del nombre de la tarjeta (wallet_card, o una cuenta que se
 *    llame igual); sin ninguna, la de por defecto PENDIENTE y con nota.
 *  · Una recarga («Revolut» pagado con la de Santander) es un traspaso; un
 *    comercio que solo se llama como una cuenta, no.
 *  · El mismo pago por el atajo NFC y por el aviso se apunta una vez, llegue
 *    primero el que llegue; con dudas, pendiente con «¿Repetido?».
 *  · Los reintentos de un aviso no duplican.
 *  · RLS y claves compuestas de las tablas nuevas; la ingesta sigue cerrada a
 *    service_role.
 *  · Los usuarios reales: sus cifras, idénticas (solo huellas).
 *
 * TODO dentro de UNA transacción que se deshace. Usuarios y dispositivo
 * sintéticos (token inventado). Las fechas se piden con ::text.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261027090000";
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
async function envio(token, cents, payload) {
  await q("savepoint envio");
  try {
    await q("set local role service_role");
    const [r] = await q("select public.ingest_transaction($1, $2, $3::jsonb) as res", [token, cents, JSON.stringify(payload)]);
    await q("reset role");
    await q("release savepoint envio");
    return { res: r.res, error: null };
  } catch (e) {
    await q("rollback to savepoint envio");
    await q("release savepoint envio");
    return { res: null, error: e };
  }
}

/** Un aviso de Cartera tal como lo deja la ruta (ya leído). */
const aviso = (tarjeta, comercio, occurred_at, id) => ({
  source: "cartera", origin: "CARTERA", wallet_card: tarjeta, merchant: comercio, occurred_at, external_id: `cartera_${id}`,
});
/** Un envío del atajo NFC. */
const nfc = (comercio, card, occurred_at, id) => ({ merchant: comercio, card, occurred_at, external_id: `atajo_${id}` });

async function comoUsuario(uid, sql, params) {
  await q("savepoint u");
  try {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
    await q("set local role authenticated");
    const filas = await q(sql, params);
    await q("reset role");
    await q("release savepoint u");
    return { filas, error: null };
  } catch (e) {
    await q("rollback to savepoint u");
    await q("release savepoint u");
    return { filas: null, error: e };
  }
}

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
                                   has_function_privilege('authenticated', 'private.ingest_respuesta(uuid,boolean,boolean,bigint)', 'execute') as resp`);
    check("ni anon ni authenticated pueden llamar a la ingesta ni a su respuesta", !priv.anon && !priv.auth && !priv.resp);
    const rls = await q(`select relname, relrowsecurity and relforcerowsecurity as rls from pg_class
                         where oid in ('public.wallet_card'::regclass, 'public.ingest_merged'::regclass)`);
    check("wallet_card e ingest_merged con RLS forzada", rls.length === 2 && rls.every((r) => r.rls));

    console.log("\n— Funcional —\n");
    const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const [u2] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const uid = u.id;
    const cuenta = async (nombre, user = uid) =>
      (await q("insert into public.account (user_id, name, type) values ($1, $2, 'BANCO') returning id::text as id", [user, nombre]))[0].id;
    const santander = await cuenta("Santander");
    const revolut = await cuenta("Revoult"); // como la llama el usuario: no se llama igual que la tarjeta
    const efectivo = await cuenta("Efectivo");
    const ajena = await cuenta("Ajena", u2.id);
    await q("update public.profile set default_ingest_account_id = $2 where user_id = $1", [uid, efectivo]);
    await q("insert into public.card (user_id, account_id, last4, type) values ($1, $2, '1111', 'DEBITO')", [uid, santander]);
    const token = `cart_${randomBytes(24).toString("hex")}`;
    await q("insert into public.ingest_device (user_id, name, token_hash, token_prefix) values ($1, 'atajo-test', extensions.digest($2, 'sha256'), 'cart_')", [uid, token]);
    const mov = async (id) =>
      (await q(`select type, amount_cents, account_id::text as a, to_account_id::text as b, status, note, description,
                       occurred_at::text as w from public.transaction where id = $1`, [id]))[0];
    const cuantos = async () => Number((await q("select count(*) from public.transaction where user_id = $1", [uid]))[0].count);

    // Cuenta por nombre (Santander se llama igual) y sin categoría: pendiente.
    const t0 = "2026-10-27T10:00:00+01:00";
    const a1 = await envio(token, 230, aviso("Santander", "Cafeteria", t0, "a1"));
    const m1 = a1.res?.ok ? await mov(a1.res.id) : null;
    check("aviso de «Santander»: a la cuenta que se llama igual, como gasto", m1?.a === santander && m1?.type === "EXPENSE", JSON.stringify(a1));
    check("… con la hora del aviso", m1?.w === "2026-10-27 09:00:00+00", m1?.w);

    // Reintento del mismo aviso.
    const n = await cuantos();
    const a1b = await envio(token, 230, aviso("Santander", "Cafeteria", t0, "a1"));
    check("el mismo aviso otra vez: duplicado, no crea nada", a1b.res?.duplicate === true && a1b.res?.id === a1.res?.id && (await cuantos()) === n);

    // «Revolut» no se llama como ninguna cuenta: a la de por defecto, pendiente y con nota.
    const a2 = await envio(token, 500, aviso("Revolut", "Cafeteria", "2026-10-27T11:00:00+01:00", "a2"));
    const m2 = a2.res?.ok ? await mov(a2.res.id) : null;
    check("tarjeta sin cuenta: a la de por defecto, PENDIENTE y con nota que lo dice",
      m2?.a === efectivo && m2?.status === "PENDING" && /tarjeta «Revolut».*Ajustes/.test(m2?.note ?? ""), JSON.stringify(m2));

    // El usuario la asigna (con su sesión, por RLS).
    const asignar = await comoUsuario(uid, "insert into public.wallet_card (user_id, name, account_id) values ($1, ' revolut ', $2) returning name_norm", [uid, revolut]);
    check("asignar la tarjeta a su cuenta (con la sesión del usuario)", asignar.filas?.[0]?.name_norm === "revolut", asignar.error?.message);
    const deOtro = await comoUsuario(uid, "insert into public.wallet_card (user_id, name, account_id) values ($1, 'Otra', $2)", [uid, ajena]);
    check("no se puede apuntar una tarjeta a la cuenta de otro usuario (FK compuesta)", deOtro.error !== null);
    const veOtro = await comoUsuario(u2.id, "select count(*)::int as c from public.wallet_card");
    check("otro usuario no ve las tarjetas de este", veOtro.filas?.[0]?.c === 0);
    const escribeFundido = await comoUsuario(uid, "insert into public.ingest_merged (user_id, external_id, transaction_id, transaction_type) values ($1, 'x', $2, 'EXPENSE')", [uid, a1.res.id]);
    check("ingest_merged no se escribe desde la app", escribeFundido.error !== null);

    const a3 = await envio(token, 700, aviso("Revolut", "Cafeteria", "2026-10-27T12:00:00+01:00", "a3"));
    const m3 = a3.res?.ok ? await mov(a3.res.id) : null;
    check("con la tarjeta asignada: a su cuenta, sin nota", m3?.a === revolut && m3?.note === null, JSON.stringify(m3));

    // Recarga: «Revolut» pagado con la de Santander.
    const a4 = await envio(token, 2400, aviso("Santander", "Revolut", "2026-10-27T13:00:00+01:00", "a4"));
    const m4 = a4.res?.ok ? await mov(a4.res.id) : null;
    check("recarga: TRASPASO Santander → la cuenta de la tarjeta Revolut, confirmado",
      m4?.type === "TRANSFER" && m4?.a === santander && m4?.b === revolut && m4?.status === "CONFIRMED", JSON.stringify(m4));
    check("… la respuesta lo dice (kind TRANSFER, to_account)", a4.res?.kind === "TRANSFER" && a4.res?.to_account === "Revoult", JSON.stringify(a4.res));
    const [gasto] = await comoUsuario(uid, "select coalesce(sum(net_expense_cents), 0)::int as g from public.v_transaction_econ where id = $1", [a4.res.id]).then((r) => r.filas);
    check("… y no cuenta como gasto", gasto.g === 0);
    const recargaEfectivo = await envio(token, 1000, aviso("Santander", "Efectivo", "2026-10-27T13:30:00+01:00", "a4b"));
    check("comercio que se llama como una cuenta pero NO es una tarjeta de Cartera: gasto, no traspaso", recargaEfectivo.res?.kind === "EXPENSE", JSON.stringify(recargaEfectivo.res));
    const cuotaRevolut = await envio(token, 999, aviso("Revolut", "Revolut", "2026-10-27T14:00:00+01:00", "a5"));
    check("«Revolut» cobrado en la propia Revolut (su cuota): gasto, no traspaso", cuotaRevolut.res?.kind === "EXPENSE", JSON.stringify(cuotaRevolut.res));

    // El mismo pago por los dos caminos: primero NFC, luego el aviso.
    const n1 = await envio(token, 1250, nfc("ZARA", "1111", "2026-10-27T15:00:00+01:00", "n1"));
    const tras = await cuantos();
    const a6 = await envio(token, 1250, aviso("Santander", "ZARA ESPAÑA SA", "2026-10-27T15:01:00+01:00", "a6"));
    check("NFC y luego el aviso del mismo pago: se funde, no crea nada",
      a6.res?.merged === true && a6.res?.duplicate === true && a6.res?.id === n1.res?.id && (await cuantos()) === tras, JSON.stringify(a6.res));
    const a6b = await envio(token, 1250, aviso("Santander", "ZARA ESPAÑA SA", "2026-10-27T15:01:00+01:00", "a6"));
    check("… y su reintento tampoco", a6b.res?.duplicate === true && (await cuantos()) === tras);

    // Al revés: primero el aviso, luego NFC.
    const a7 = await envio(token, 845, aviso("Santander", "Mercadona", "2026-10-27T16:00:00+01:00", "a7"));
    const tras7 = await cuantos();
    const n7 = await envio(token, 845, nfc("MERCADONA", "1111", "2026-10-27T16:00:30+01:00", "n7"));
    check("el aviso y luego NFC: también se funde", n7.res?.merged === true && n7.res?.id === a7.res?.id && (await cuantos()) === tras7, JSON.stringify(n7.res));

    // Ya emparejado: otro aviso igual es OTRO pago (dos cafés seguidos).
    const a8 = await envio(token, 845, aviso("Santander", "Mercadona", "2026-10-27T16:02:00+01:00", "a8"));
    check("un pago ya emparejado no absorbe a un tercero: entra como pago nuevo", a8.res?.merged === false && a8.res?.id !== a7.res?.id, JSON.stringify(a8.res));

    // Fuera de la ventana: dos pagos.
    const n9 = await envio(token, 330, nfc("Bar", "1111", "2026-10-27T17:00:00+01:00", "n9"));
    const a9 = await envio(token, 330, aviso("Santander", "Bar", "2026-10-27T17:20:00+01:00", "a9"));
    check("a 20 minutos no es el mismo pago", a9.res?.merged === false && a9.res?.id !== n9.res?.id);

    // Dudas: el candidato está en otra cuenta → pendiente con «¿Repetido?».
    await envio(token, 1500, nfc("Tienda", "1111", "2026-10-27T18:00:00+01:00", "n10"));
    const a10 = await envio(token, 1500, aviso("Revolut", "Tienda", "2026-10-27T18:01:00+01:00", "a10"));
    const m10 = a10.res?.ok ? await mov(a10.res.id) : null;
    check("mismo importe pero en OTRA cuenta: se apunta, PENDIENTE y con «¿Repetido?»",
      a10.res?.merged === false && m10?.status === "PENDING" && /^¿Repetido\?/.test(m10?.note ?? ""), JSON.stringify(m10));

    // Dos candidatos en la misma cuenta: tampoco se adivina.
    await envio(token, 600, nfc("Kiosco", "1111", "2026-10-27T19:00:00+01:00", "n11"));
    await envio(token, 600, nfc("Kiosco", "1111", "2026-10-27T19:02:00+01:00", "n12"));
    const a11 = await envio(token, 600, aviso("Santander", "Kiosco", "2026-10-27T19:03:00+01:00", "a11"));
    const m11 = a11.res?.ok ? await mov(a11.res.id) : null;
    check("dos candidatos posibles: no se funde con ninguno, pendiente con «¿Repetido?»",
      a11.res?.merged === false && m11?.status === "PENDING" && /2 pagos/.test(m11?.note ?? ""), JSON.stringify(m11));

    // Borrar el pago fundido borra su rastro (FK en cascada).
    await q("delete from public.transaction where id = $1", [n1.res.id]);
    const [{ c: rastro }] = await q("select count(*)::int as c from public.ingest_merged where transaction_id = $1", [n1.res.id]);
    check("borrar un pago borra su emparejamiento (cascada)", rastro === 0);

    // NFC de siempre sin cambios: enruta por los 4 dígitos.
    const n13 = await envio(token, 120, nfc("Panadería", "1111", "2026-10-27T20:00:00+01:00", "n13"));
    const m13 = n13.res?.ok ? await mov(n13.res.id) : null;
    check("el atajo NFC de siempre sigue enrutando por los 4 dígitos", m13?.a === santander && m13?.type === "EXPENSE");
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
