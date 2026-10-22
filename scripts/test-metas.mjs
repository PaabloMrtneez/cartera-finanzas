/**
 * Prueba «Metas para todas las cuentas»: v_account_worth y v_savings_goal_progress.
 *
 *   node --env-file=.env.local scripts/test-metas.mjs
 *
 * Prueba el esquema ACTUAL. Antes aplicaba 20260921090000 dentro de la
 * transacción (cuando aún no estaba en producción); ya está aplicada y
 * reaplicarla falla («v_account_worth already exists»). Una migración aplicada
 * no vuelve a correrse: se prueba lo que hay. Los datos se siembran dentro de
 * una transacción que se DESHACE; los usuarios de prueba de auth.users sí se
 * crean (vía service role) y se borran en el `finally`, igual que en el resto.
 *
 * Lo que se demuestra:
 *   · una meta puede apoyarse en CUALQUIER tipo de cuenta (BANCO, AHORRO,
 *     EFECTIVO, INVERSION), no solo AHORRO
 *   · cuenta de dinero  → progreso = saldo derivado (v_account_balance)
 *   · cuenta de INVERSION → progreso = caja sin desplegar + valor de posiciones
 *     (revalorizadas, con fallback a lo aportado si no hay valoración), que NO
 *     es ni el saldo contable ni solo el valor invertido
 *   · `reached` respeta el límite (>=), y el % sale bien
 *   · un usuario no ve las metas ni el valor de las cuentas de otro
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

// Semilla de un usuario: cuatro cuentas (una por tipo) y una cuenta de inversión
// con dos posiciones. Devuelve los ids que hacen falta para las comprobaciones.
async function sembrar(uid) {
  const cuenta = (nombre, tipo, inicial) =>
    q(
      `insert into public.account (user_id,name,type,initial_balance_cents) values ($1,$2,$3,$4) returning id`,
      [uid, nombre, tipo, inicial],
    ).then((r) => r[0].id);

  const banco = await cuenta("Banco", "BANCO", 500000);
  const ahorro = await cuenta("Ahorro", "AHORRO", 30000);
  const efectivo = await cuenta("Efectivo", "EFECTIVO", 5000);
  const broker = await cuenta("Bróker", "INVERSION", 0);

  const posicion = (nombre) =>
    q(`insert into public.investment_position (user_id,name,account_id) values ($1,$2,$3) returning id`, [
      uid,
      nombre,
      broker,
    ]).then((r) => r[0].id);

  const fondoA = await posicion("Fondo A");
  const fondoB = await posicion("Fondo B");

  // Traspasos desde Banco al bróker. Con position_id = aportación a esa posición;
  // sin position_id = caja que entra pero queda sin desplegar.
  const traspaso = (cents, posId) =>
    q(
      `insert into public.transaction
         (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,position_id,source,status)
       values ($1,'TRANSFER',$2,'x',current_date,$3,$4,$5,'MANUAL','CONFIRMED')`,
      [uid, cents, banco, broker, posId],
    );

  await traspaso(100000, fondoA); // aportado a Fondo A
  await traspaso(50000, null); //    caja sin desplegar
  await traspaso(40000, fondoB); //  aportado a Fondo B (se queda sin valorar)

  // Fondo A se revaloriza: 100.000 aportados → 120.000 de valor.
  await q(
    `insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,current_date,$3)`,
    [uid, fondoA, 120000],
  );

  const meta = (nombre, cuentaId, target) =>
    q(`insert into public.savings_goal (user_id,name,account_id,target_cents) values ($1,$2,$3,$4)`, [
      uid,
      nombre,
      cuentaId,
      target,
    ]);

  await meta("Colchón banco", banco, 400000);
  await meta("Ahorro objetivo", ahorro, 100000);
  await meta("Bote efectivo", efectivo, 5000);
  await meta("Cartera invertida", broker, 300000);

  return { banco, ahorro, efectivo, broker };
}

async function main() {
  await client.connect();
  const uidA = await nuevoUsuario("meta-a");
  const uidB = await nuevoUsuario("meta-b");

  await client.query("begin");
  try {
    const a = await sembrar(uidA);
    await sembrar(uidB); // ruido de otro usuario, para el aislamiento

    console.log("\n— Progreso por tipo de cuenta (usuario A) —\n");
    const metas = await comoUsuario(uidA, () => q("select * from public.v_savings_goal_progress"));
    const worth = await comoUsuario(uidA, () =>
      q("select account_id, balance_cents, worth_cents from public.v_account_worth"),
    );
    const porNombre = Object.fromEntries(metas.map((m) => [m.name, m]));
    const worthDe = Object.fromEntries(worth.map((w) => [w.account_id, w]));
    const n = (x) => Number(x);

    // Cuenta de dinero (BANCO): saldo = 500.000 − 100.000 − 50.000 − 40.000 = 310.000.
    const banco = porNombre["Colchón banco"];
    check("BANCO: progreso = saldo (310.000)", n(banco.saved_cents) === 310000, `${banco?.saved_cents}`);
    check("BANCO: restante 90.000 y pct 77,5", n(banco.remaining_cents) === 90000 && n(banco.pct) === 77.5, `${banco?.remaining_cents} / ${banco?.pct}`);
    check("BANCO: no alcanzada", banco.reached === false);

    // AHORRO intacta: saldo 30.000.
    const ahorro = porNombre["Ahorro objetivo"];
    check("AHORRO: progreso = saldo (30.000)", n(ahorro.saved_cents) === 30000, `${ahorro?.saved_cents}`);
    check("AHORRO: pct 30,0", n(ahorro.pct) === 30.0, `${ahorro?.pct}`);

    // EFECTIVO: saldo 5.000, objetivo 5.000 → alcanzada justa (>=).
    const efectivo = porNombre["Bote efectivo"];
    check("EFECTIVO: alcanzada en el límite (5.000)", efectivo.reached === true && n(efectivo.remaining_cents) === 0 && n(efectivo.pct) === 100.0, `${efectivo?.saved_cents} / ${efectivo?.pct}`);

    // INVERSION: el valor, no el saldo.
    //   saldo bróker = 100.000 + 50.000 + 40.000 = 190.000
    //   aportado     = 100.000 (A) + 40.000 (B) = 140.000
    //   caja sin desplegar = 190.000 − 140.000 = 50.000
    //   valor posiciones   = 120.000 (A, valorada) + 40.000 (B, fallback aportado) = 160.000
    //   PROGRESO = 50.000 + 160.000 = 210.000
    const broker = porNombre["Cartera invertida"];
    const wBroker = worthDe[a.broker];
    check("INVERSION: progreso = caja sin desplegar + valor posiciones (210.000)", n(broker.saved_cents) === 210000, `${broker?.saved_cents}`);
    check("INVERSION: v_account_worth coincide (210.000)", n(wBroker.worth_cents) === 210000, `${wBroker?.worth_cents}`);
    check("INVERSION: NO es el saldo contable (190.000)", n(wBroker.balance_cents) === 190000 && n(broker.saved_cents) !== 190000, `saldo ${wBroker?.balance_cents}`);
    check("INVERSION: NO es solo el valor invertido (160.000)", n(broker.saved_cents) !== 160000);
    check("INVERSION: pct 70,0 y restante 90.000", n(broker.pct) === 70.0 && n(broker.remaining_cents) === 90000, `${broker?.pct} / ${broker?.remaining_cents}`);

    // Las cuatro metas están (todas las cuentas valen).
    check("Se listan las 4 metas del usuario (todas las cuentas valen)", metas.length === 4, `${metas.length}`);

    console.log("\n— Aislamiento entre usuarios —\n");
    const metasB = await comoUsuario(uidB, () => q("select * from public.v_savings_goal_progress"));
    check("B ve solo sus 4 metas, no las de A", metasB.length === 4 && metasB.every((m) => m.user_id === uidB));
    const worthAdesdeB = await comoUsuario(uidB, () =>
      q("select 1 from public.v_account_worth where account_id = $1", [a.broker]),
    );
    check("B no ve el valor de una cuenta de A", worthAdesdeB.length === 0, `ve ${worthAdesdeB.length}`);
  } finally {
    // No persistir NADA en la base: la migración y los datos de prueba se revierten.
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
