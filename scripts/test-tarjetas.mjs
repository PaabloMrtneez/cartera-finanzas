/**
 * Prueba «Varias tarjetas por cuenta»: tabla public.card y enrutado del Atajo.
 *
 *   node --env-file=.env.local scripts/test-tarjetas.mjs
 *
 * Prueba el esquema ACTUAL. Antes aplicaba 20260924090000 dentro de la
 * transacción (cuando aún no estaba en producción) y probaba su backfill desde
 * account.card_last4; esa columna ya se retiró (20260924100000), así que el
 * backfill no se puede volver a ejercitar y reaplicar la migración falla. Una
 * migración aplicada no vuelve a correrse: se prueba lo que hay. Los datos se
 * siembran en una transacción que se DESHACE; los usuarios de auth.users sí se
 * crean vía service role y se borran en el finally.
 *
 * Lo que se demuestra:
 *   (b) ENRUTADO del Atajo por public.card:
 *         · dos tarjetas en la MISMA cuenta → ambos pagos caen en esa cuenta
 *         · tarjetas en cuentas DISTINTAS   → cada pago a la suya
 *   (c) AISLAMIENTO: el usuario B no ve ni inserta tarjetas de A, y la FK
 *       compuesta (user_id, account_id) impide colgar una tarjeta de la cuenta
 *       de otro usuario.
 *
 * Nota pg: `set local role` y `set_config(...,true)` se revierten con
 * `rollback to savepoint`, así que los fallos esperados se aíslan con savepoints
 * y no abortan la transacción entera.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const API = process.env.NEXT_PUBLIC_SUPABASE_URL;
const S = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: S, Authorization: `Bearer ${S}`, "Content-Type": "application/json" };

let ok = 0;
let mal = 0;
function check(nombre, cond, detalle = "") {
  if (cond) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    mal++;
    console.log(`  FALLO ${nombre}${detalle ? `\n        ${detalle}` : ""}`);
  }
}

const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

// Ejecuta `trabajo` con la identidad de un usuario (RLS + security_invoker),
// dentro de la MISMA transacción, y vuelve al rol privilegiado al terminar.
async function comoUsuario(uid, trabajo) {
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
  ]);
  await client.query("set local role authenticated");
  try {
    return await trabajo();
  } finally {
    await client.query("reset role");
  }
}

// Un intento que DEBE fallar, aislado en un savepoint para no abortar la tx.
// Ejecuta como el usuario `uid`. Devuelve el código de error de Postgres.
async function debeFallar(nombre, uid, sql, params, codigoEsperado) {
  await client.query("savepoint sp");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    await client.query(sql, params);
    await client.query("rollback to savepoint sp");
    check(nombre, false, "la operación pasó y no debía");
    return null;
  } catch (e) {
    await client.query("rollback to savepoint sp");
    check(nombre, codigoEsperado ? e.code === codigoEsperado : true, `code=${e.code} ${e.message}`);
    return e.code;
  }
}

const usuarios = [];
async function nuevoUsuario(prefijo) {
  const r = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      email: `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@cartera.local`,
      email_confirm: true,
    }),
  });
  const uid = (await r.json()).id;
  usuarios.push(uid);
  return uid;
}

// Crea una cuenta y devuelve su id.
const nuevaCuenta = (uid, nombre, tipo = "BANCO") =>
  q(
    `insert into public.account (user_id, name, type)
     values ($1, $2, $3) returning id`,
    [uid, nombre, tipo],
  ).then((r) => r[0].id);

// Crea una tarjeta y devuelve su id.
const nuevaTarjeta = (uid, accountId, last4, tipo = "DEBITO", nickname = null) =>
  q(
    `insert into public.card (user_id, account_id, last4, type, nickname)
     values ($1, $2, $3, $4, $5) returning id`,
    [uid, accountId, last4, tipo, nickname],
  ).then((r) => r[0].id);

// Da de alta un dispositivo de ingesta con un token conocido; devuelve el token.
async function nuevoDispositivo(uid, token) {
  await q(
    `insert into public.ingest_device (user_id, name, token_hash, token_prefix)
     values ($1, 'atajo-test', extensions.digest($2, 'sha256'), 'cart_')`,
    [uid, token],
  );
  return token;
}

// Simula un pago del Atajo: llama a ingest_transaction como lo hace el endpoint
// (rol de servicio, autenticación por token). Devuelve el objeto de respuesta.
async function pago(token, cents, { card, merchant, external_id }) {
  const rows = await q(
    `select public.ingest_transaction($1, $2, $3::jsonb) as res`,
    [token, cents, JSON.stringify({ card, merchant, external_id })],
  );
  return rows[0].res;
}

// account_id real del movimiento creado, para verificar el enrutado sin fiarse
// del nombre que devuelve la función.
const cuentaDelMovimiento = (uid, txId) =>
  q(`select account_id from public.transaction where user_id = $1 and id = $2`, [uid, txId]).then(
    (r) => r[0]?.account_id,
  );

async function main() {
  await client.connect();
  const uidA = await nuevoUsuario("tarjeta-a");
  const uidB = await nuevoUsuario("tarjeta-b");

  await client.query("begin");
  try {
    // ─────────────────────────────────────────────────────────────────────
    // (b) ENRUTADO del Atajo por public.card.
    // ─────────────────────────────────────────────────────────────────────
    console.log("— Enrutado del Atajo —\n");

    // La columna account.card_last4 ya no existe: el último4 vive solo en card.
    const [legado] = await q(
      `select count(*)::int as n from information_schema.columns
       where table_schema = 'public' and table_name = 'account' and column_name = 'card_last4'`,
    );
    check("account.card_last4 ya no existe (20260924100000)", legado.n === 0);

    const banco = await nuevaCuenta(uidA, "Banco principal", "BANCO");
    const ahorro = await nuevaCuenta(uidA, "Ahorro objetivo", "AHORRO");

    // Dos tarjetas en la MISMA cuenta (banco): física y desechable.
    await nuevaTarjeta(uidA, banco, "1111", "DEBITO", "física");
    await nuevaTarjeta(uidA, banco, "2222", "PREPAGO", "desechable sitios no seguros");
    // Una tarjeta en otra cuenta (ahorro).
    await nuevaTarjeta(uidA, ahorro, "3333", "CREDITO", null);

    const token = await nuevoDispositivo(uidA, "cart_" + "a".repeat(40));

    // Dos pagos con las dos tarjetas de la MISMA cuenta → ambos a banco.
    const p1 = await pago(token, 1570, { card: "1111", merchant: "Bar Pepe", external_id: "ext-1" });
    const p2 = await pago(token, 999, { card: "2222", merchant: "Web dudosa", external_id: "ext-2" });
    check("Pago con tarjeta 1111 entra ok", p1.ok === true, JSON.stringify(p1));
    check("Pago con tarjeta 2222 entra ok", p2.ok === true, JSON.stringify(p2));
    const c1 = await cuentaDelMovimiento(uidA, p1.id);
    const c2 = await cuentaDelMovimiento(uidA, p2.id);
    check("Dos tarjetas de la misma cuenta: pago 1111 → banco", c1 === banco, `${c1}`);
    check("Dos tarjetas de la misma cuenta: pago 2222 → banco", c2 === banco, `${c2}`);

    // Pago con la tarjeta de la OTRA cuenta → ahorro.
    const p3 = await pago(token, 4200, { card: "3333", merchant: "Nómina extra", external_id: "ext-3" });
    const c3 = await cuentaDelMovimiento(uidA, p3.id);
    check("Tarjetas en cuentas distintas: pago 3333 → ahorro", c3 === ahorro, `${c3}`);
    check("Tarjetas en cuentas distintas: 1111 y 3333 caen en cuentas diferentes", c1 !== c3);

    // Una tarjeta desconocida sin cuenta por defecto → rechazo NO_ACCOUNT.
    const p4 = await pago(token, 500, { card: "8888", merchant: "Desconocido", external_id: "ext-4" });
    check(
      "Tarjeta desconocida sin cuenta por defecto → no_account_configured",
      p4.ok === false && p4.error === "no_account_configured",
      JSON.stringify(p4),
    );

    // ─────────────────────────────────────────────────────────────────────
    // (c) AISLAMIENTO entre usuarios.
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n— Aislamiento —\n");

    const cuentaB = await nuevaCuenta(uidB, "Banco de B", "BANCO");
    await nuevaTarjeta(uidB, cuentaB, "1111", "DEBITO", null); // mismo last4 que A: legal, es por usuario

    // B no ve las tarjetas de A.
    const tarjetasDeAvistasPorB = await comoUsuario(uidB, () =>
      q(`select id from public.card where user_id = $1`, [uidA]),
    );
    check("B no ve ninguna tarjeta de A", tarjetasDeAvistasPorB.length === 0, `ve ${tarjetasDeAvistasPorB.length}`);

    // A sí ve las suyas (control positivo).
    const tarjetasDeA = await comoUsuario(uidA, () => q(`select id from public.card`));
    check("A ve sus propias tarjetas (las 3 creadas)", tarjetasDeA.length === 3, `${tarjetasDeA.length}`);

    // B no puede INSERTAR una tarjeta a nombre de A (WITH CHECK de la política).
    await debeFallar(
      "B no puede insertar una tarjeta con user_id de A (RLS)",
      uidB,
      `insert into public.card (user_id, account_id, last4) values ($1, $2, '4444')`,
      [uidA, banco],
      "42501",
    );

    // FK compuesta: B (con su propio user_id) no puede colgar una tarjeta de una
    // cuenta de A. La política de insert pasa (user_id = B), pero la FK
    // (user_id, account_id) no encuentra la cuenta de A bajo B → 23503.
    await debeFallar(
      "FK compuesta: B no puede apuntar una tarjeta a la cuenta de A (23503)",
      uidB,
      `insert into public.card (user_id, account_id, last4) values ($1, $2, '5555')`,
      [uidB, banco],
      "23503",
    );
  } finally {
    // No persistir NADA: migración, tabla, enum, función y datos se revierten.
    await client.query("rollback").catch(() => {});
  }

  for (const u of usuarios)
    await fetch(`${API}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: h }).catch(() => {});
  await client.end();

  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await client.query("rollback").catch(() => {});
  for (const u of usuarios)
    await fetch(`${API}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: h }).catch(() => {});
  await client.end().catch(() => {});
  process.exit(2);
});
