/**
 * Prueba de 20261007090000_eliminar_cuentas.sql:
 *   account_delete_preview(uuid), delete_account(uuid, text) y las políticas de
 *   borrado de account e investment_position.
 *
 *   node --env-file=.env.local scripts/test-eliminar-cuenta.mjs
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): la
 * migración se aplica ahí dentro, los usuarios de prueba se insertan en
 * auth.users ahí dentro, y no persiste nada. Así se prueba contra la base real
 * sin aplicar nada a producción. (Si la migración ya está aplicada, volver a
 * crear las políticas fallaría: en ese caso se salta el paso de aplicarla.)
 *
 * Tres bloques:
 *
 *   1. DATOS REALES. Para cada usuario y cada cuenta suya, el preview cuadra con
 *      recuentos independientes y con v_account_balance. Para una cuenta por
 *      usuario se ejecuta delete_account dentro de un savepoint y se comprueba
 *      que el saldo de CADA otra cuenta cambia exactamente lo que dijo el
 *      preview, y que no queda nada colgando de la cuenta. Se deshace al
 *      momento. No se imprime ninguna cifra de nadie: solo si cuadra o no.
 *   2. DATOS SEMBRADOS. Una cuenta con todo tipo de dependencias (gastos,
 *      ingresos, traspasos en los dos sentidos, uno descartado, una aportación a
 *      posición, reembolsos cruzados en los dos sentidos, tarjeta, posición con
 *      valoración, suscripción, ingreso recurrente, meta, regla, límite,
 *      dispositivo del Atajo con la cuenta por defecto) y los resultados
 *      esperados a mano.
 *   3. AISLAMIENTO Y PERMISOS. Otro usuario no puede ni previsualizar ni borrar;
 *      una sesión sin aal2 tampoco; anon no puede ejecutar; el DELETE directo
 *      sobre account sigue sin borrar nada.
 *
 * Las fechas se piden a la base con ::text cuando hacen falta: el driver pg
 * convierte un `date` a medianoche local y toISOString() daría el día anterior.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACION = "20261007090000_eliminar_cuentas.sql";
const sqlMigracion = readFileSync(join(raiz, "supabase", "migrations", MIGRACION), "utf8");

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

/** Ejecuta `trabajo` con la sesión de `uid` (authenticated + aal) y vuelve a postgres. */
async function comoUsuario(uid, trabajo, aal = "aal2") {
  await q("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal }),
  ]);
  await q("set local role authenticated");
  try {
    return await trabajo();
  } finally {
    await q("reset role");
  }
}

/**
 * Ejecuta `trabajo` como `uid` dentro de un savepoint y devuelve el error de
 * Postgres (o null si no lo hubo). Pase lo que pase, deshace hasta el savepoint:
 * ni lo que hizo ni el cambio de rol sobreviven.
 */
async function intentoComo(uid, trabajo, aal = "aal2") {
  await q("savepoint intento");
  let error = null;
  try {
    await q("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal }),
    ]);
    await q("set local role authenticated");
    await trabajo();
  } catch (e) {
    error = e;
  }
  await q("rollback to savepoint intento");
  await q("release savepoint intento");
  return error;
}

const preview = (id) => q("select public.account_delete_preview($1) as p", [id]).then((r) => r[0].p);
const borrar = (id, nombre) => q("select public.delete_account($1, $2) as r", [id, nombre]).then((r) => r[0].r);
const saldos = () =>
  q("select account_id::text as id, balance_cents from public.v_account_balance").then(
    (rows) => new Map(rows.map((r) => [r.id, n(r.balance_cents)])),
  );

// --------------------------------------------------------------------------
// Lo que debería quedar colgando de una cuenta tras borrarla: nada.
// Se consulta como postgres (sin RLS) para no fiarse de lo que deja ver.
// --------------------------------------------------------------------------
async function restos(accountId) {
  const [r] = await q(
    `select
       (select count(*) from public.account where id = $1) as cuentas,
       (select count(*) from public.transaction where account_id = $1 or to_account_id = $1) as movimientos,
       (select count(*) from public.card where account_id = $1) as tarjetas,
       (select count(*) from public.investment_position where account_id = $1) as posiciones,
       (select count(*) from public.subscription where account_id = $1) as suscripciones,
       (select count(*) from public.recurring_income where account_id = $1) as ingresos,
       (select count(*) from public.savings_goal where account_id = $1) as metas,
       (select count(*) from public.profile where default_ingest_account_id = $1) as atajo`,
    [accountId],
  );
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, n(v)]));
}
const todoCero = (r) => Object.values(r).every((v) => v === 0);

// --------------------------------------------------------------------------
// 1. Datos reales
// --------------------------------------------------------------------------
async function datosReales(uid, etiqueta) {
  const cuentas = await comoUsuario(uid, () =>
    q("select id::text as id, name from public.account order by created_at"),
  );
  if (cuentas.length === 0) {
    console.log(`  (${etiqueta}: sin cuentas)`);
    return;
  }

  let cuadran = 0;
  const fallos = [];
  let elegida = null;
  for (const c of cuentas) {
    const p = await comoUsuario(uid, () => preview(c.id));
    const [ind] = await q(
      `select
         (select count(*) from public.transaction where account_id = $1 or to_account_id = $1) as total,
         (select count(*) from public.transaction where account_id = $1 and type = 'EXPENSE') as gastos,
         (select count(*) from public.transaction where account_id = $1 and type = 'INCOME') as ingresos,
         (select count(*) from public.transaction where type = 'TRANSFER' and (account_id = $1 or to_account_id = $1)) as traspasos,
         (select count(*) from public.card where account_id = $1) as tarjetas,
         (select count(*) from public.investment_position where account_id = $1) as posiciones,
         (select count(*) from public.subscription where account_id = $1) as suscripciones,
         (select count(*) from public.recurring_income where account_id = $1) as ingresos_rec,
         (select count(*) from public.savings_goal where account_id = $1) as metas`,
      [c.id],
    );
    const [saldo] = await comoUsuario(uid, () =>
      q("select balance_cents from public.v_account_balance where account_id = $1", [c.id]),
    );
    const iguales =
      n(p.transactions.total) === n(ind.total) &&
      n(p.transactions.expenses) === n(ind.gastos) &&
      n(p.transactions.incomes) === n(ind.ingresos) &&
      n(p.transactions.transfers) === n(ind.traspasos) &&
      n(p.cards) === n(ind.tarjetas) &&
      n(p.positions) === n(ind.posiciones) &&
      n(p.subscriptions) === n(ind.suscripciones) &&
      n(p.recurring_incomes) === n(ind.ingresos_rec) &&
      n(p.goals) === n(ind.metas) &&
      n(p.balance_cents) === n(saldo.balance_cents) &&
      p.name === c.name;
    if (iguales) cuadran++;
    else fallos.push(c.id.slice(0, 8));
    // La cuenta con más traspasos con otras es la más exigente para el borrado.
    if (!elegida || p.external_transfers.length > elegida.p.external_transfers.length) elegida = { c, p };
  }
  check(`${etiqueta}: el preview cuadra con recuentos independientes en ${cuentas.length} cuentas`, cuadran === cuentas.length, fallos.join(", "));

  // Borrado de verdad, dentro de un savepoint que se deshace al momento.
  const { c, p } = elegida;
  await q("savepoint real");
  try {
    const antes = await comoUsuario(uid, saldos);
    const [mesAntes] = await comoUsuario(uid, () =>
      q("select count(*) as n from public.v_month_summary"),
    );
    await comoUsuario(uid, () => borrar(c.id, c.name));
    const despues = await comoUsuario(uid, saldos);

    const esperado = new Map(p.external_transfers.map((x) => [x.account_id, n(x.balance_delta_cents)]));
    const malas = [];
    for (const [id, saldo] of antes) {
      if (id === c.id) continue;
      const delta = (despues.get(id) ?? NaN) - saldo;
      if (delta !== (esperado.get(id) ?? 0)) malas.push(id.slice(0, 8));
    }
    check(
      `${etiqueta}: al borrar una cuenta, el saldo de cada otra cambia exactamente lo que dijo el preview (${antes.size - 1} cuentas)`,
      malas.length === 0 && !despues.has(c.id),
      malas.join(", "),
    );
    const r = await restos(c.id);
    check(`${etiqueta}: no queda nada colgando de la cuenta borrada`, todoCero(r), JSON.stringify(r));
    const [mesDespues] = await comoUsuario(uid, () =>
      q("select count(*) as n from public.v_month_summary"),
    );
    check(`${etiqueta}: las vistas siguen respondiendo tras el borrado`, n(mesDespues.n) <= n(mesAntes.n));
  } finally {
    await q("rollback to savepoint real");
    await q("release savepoint real");
  }
}

// --------------------------------------------------------------------------
// 2. Datos sembrados
// --------------------------------------------------------------------------
async function sembrar() {
  const uid = (await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id"))[0].id;
  const cuenta = async (nombre, tipo, inicial) =>
    (
      await q(
        "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,$2,$3,$4) returning id::text as id",
        [uid, nombre, tipo, inicial],
      )
    )[0].id;
  const X = await cuenta("Bróker Prueba", "INVERSION", 10000);
  const Y = await cuenta("Otra cuenta", "BANCO", 50000);
  const Z = await cuenta("Tercera", "AHORRO", 0);

  const cat = async (nombre, tipo) =>
    (await q("insert into public.category (user_id,name,type) values ($1,$2,$3) returning id::text as id", [uid, nombre, tipo]))[0].id;
  const cGasto = await cat("Super", "EXPENSE");
  const cIngreso = await cat("Nómina", "INCOME");

  const tx = async (campos) => {
    const cols = Object.keys(campos);
    const vals = Object.values(campos);
    const [r] = await q(
      `insert into public.transaction (user_id,${cols.join(",")}) values ($1,${cols.map((_, i) => `$${i + 2}`).join(",")}) returning id::text as id`,
      [uid, ...vals],
    );
    return r.id;
  };
  const hoy = (await q("select (current_date - 5)::text as d"))[0].d;

  // En X: dos gastos, un ingreso, un gasto descartado.
  await tx({ type: "EXPENSE", amount_cents: 3000, occurred_on: hoy, account_id: X, category_id: cGasto, category_type: "EXPENSE" });
  await tx({ type: "EXPENSE", amount_cents: 1500, occurred_on: hoy, account_id: X });
  await tx({ type: "INCOME", amount_cents: 20000, occurred_on: hoy, account_id: X, category_id: cIngreso, category_type: "INCOME" });
  await tx({ type: "EXPENSE", amount_cents: 999, occurred_on: hoy, account_id: X, status: "DISCARDED" });

  // Posición en X con valoración.
  const P = (await q("insert into public.investment_position (user_id,name,account_id,since) values ($1,'Fondo prueba',$2,(current_date - 60)) returning id::text as id", [uid, X]))[0].id;
  await q("insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,current_date - 10,12000)", [uid, P]);

  // Traspasos con Y: X→Y 30000 (Y baja), Y→X 5000 (Y sube), Y→X 700
  // descartado (sin efecto), Y→X 10000 aportado a la posición (Y sube).
  // Efecto esperado en Y: −30000 + 5000 + 10000 = −15000.
  await tx({ type: "TRANSFER", amount_cents: 30000, occurred_on: hoy, account_id: X, to_account_id: Y });
  await tx({ type: "TRANSFER", amount_cents: 5000, occurred_on: hoy, account_id: Y, to_account_id: X });
  await tx({ type: "TRANSFER", amount_cents: 700, occurred_on: hoy, account_id: Y, to_account_id: X, status: "DISCARDED" });
  await tx({ type: "TRANSFER", amount_cents: 10000, occurred_on: hoy, account_id: Y, to_account_id: X, position_id: P });
  // Y un traspaso Y→Z que no toca X: no debe moverse nada.
  await tx({ type: "TRANSFER", amount_cents: 2000, occurred_on: hoy, account_id: Y, to_account_id: Z });

  // Reembolso cruzado 1: gasto en X, reembolsado por un ingreso en Y.
  const gX = await tx({ type: "EXPENSE", amount_cents: 4000, occurred_on: hoy, account_id: X, category_id: cGasto, category_type: "EXPENSE" });
  const iY = await tx({ type: "INCOME", amount_cents: 4000, occurred_on: hoy, account_id: Y, reimburses_id: gX, reimburses_target_type: "EXPENSE" });
  // Reembolso cruzado 2: gasto en Y, reembolsado por un ingreso en X.
  const gY = await tx({ type: "EXPENSE", amount_cents: 2500, occurred_on: hoy, account_id: Y, category_id: cGasto, category_type: "EXPENSE" });
  await tx({ type: "INCOME", amount_cents: 2500, occurred_on: hoy, account_id: X, reimburses_id: gY, reimburses_target_type: "EXPENSE" });

  // Tarjetas.
  await q("insert into public.card (user_id,account_id,last4) values ($1,$2,'4321')", [uid, X]);
  await q("insert into public.card (user_id,account_id,last4) values ($1,$2,'8765')", [uid, Y]);

  // Suscripción de X, con un cargo en X y otro antiguo en Y (se le cambió la cuenta).
  const S = (await q(
    `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,started_at,account_id)
     values ($1,'Prueba',999,'MENSUAL',current_date + 10,current_date - 100,$2) returning id::text as id`,
    [uid, X],
  ))[0].id;
  await tx({ type: "EXPENSE", amount_cents: 999, occurred_on: hoy, account_id: X, subscription_id: S, source: "RECURRING" });
  const subEnY = await tx({ type: "EXPENSE", amount_cents: 999, occurred_on: (await q("select (current_date - 40)::text as d"))[0].d, account_id: Y, subscription_id: S, source: "RECURRING" });

  // Ingreso recurrente de X.
  await q(
    `insert into public.recurring_income (user_id,description,amount_cents,periodicity,next_income_date,started_at,account_id)
     values ($1,'Alquiler',70000,'MENSUAL',current_date + 3,current_date - 30,$2)`,
    [uid, X],
  );

  // Metas: una en X, otra en Y.
  await q("insert into public.savings_goal (user_id,name,target_cents,account_id) values ($1,'Meta X',100000,$2)", [uid, X]);
  await q("insert into public.savings_goal (user_id,name,target_cents,account_id) values ($1,'Meta Y',100000,$2)", [uid, Y]);

  // Regla y límite (cuelgan de categorías: no se tocan).
  await q("insert into public.merchant_rule (user_id,match_text,category_id,category_type) values ($1,'mercadona',$2,'EXPENSE')", [uid, cGasto]);
  await q("insert into public.budget (user_id,category_id,monthly_cap_cents) values ($1,$2,50000)", [uid, cGasto]);

  // Atajo: X es la cuenta por defecto, con un dispositivo activo.
  await q("update public.profile set default_ingest_account_id = $2 where user_id = $1", [uid, X]);
  await q(
    "insert into public.ingest_device (user_id,name,token_hash,token_prefix) values ($1,'iPhone prueba',extensions.gen_random_bytes(32),'tst_')",
    [uid],
  );

  return { uid, X, Y, Z, P, iY, gY, subEnY };
}

async function pruebasSembradas(s) {
  console.log("\n— Datos sembrados —\n");
  const p = await comoUsuario(s.uid, () => preview(s.X));

  check("preview: nombre y tipo", p.name === "Bróker Prueba" && p.type === "INVERSION");
  // En X: 3000+1500+20000+999(desc.)+4000+2500+999 y 4 traspasos.
  check(
    "preview: 11 movimientos (5 gastos, 2 ingresos, 4 traspasos; incluye el descartado)",
    n(p.transactions.total) === 11 && n(p.transactions.expenses) === 5 && n(p.transactions.incomes) === 2 && n(p.transactions.transfers) === 4,
    JSON.stringify(p.transactions),
  );
  check(
    "preview: traspasos con otras cuentas = solo Y, 4 traspasos, saldo de Y −15000",
    p.external_transfers.length === 1 &&
      p.external_transfers[0].account_id === s.Y &&
      p.external_transfers[0].name === "Otra cuenta" &&
      n(p.external_transfers[0].transfers) === 4 &&
      n(p.external_transfers[0].balance_delta_cents) === -15000,
    JSON.stringify(p.external_transfers),
  );
  check(
    "preview: 1 tarjeta, 1 posición, 1 valoración, 1 suscripción, 1 ingreso recurrente, 1 meta",
    [p.cards, p.positions, p.valuations, p.subscriptions, p.recurring_incomes, p.goals].every((v) => n(v) === 1),
    JSON.stringify([p.cards, p.positions, p.valuations, p.subscriptions, p.recurring_incomes, p.goals]),
  );
  check(
    "preview: reembolsos cruzados (1 ingreso ajeno de 4000; 1 gasto ajeno de 2500)",
    n(p.cross_reimbursements.incomes_elsewhere.count) === 1 &&
      n(p.cross_reimbursements.incomes_elsewhere.cents) === 4000 &&
      n(p.cross_reimbursements.expenses_elsewhere.count) === 1 &&
      n(p.cross_reimbursements.expenses_elsewhere.cents) === 2500,
    JSON.stringify(p.cross_reimbursements),
  );
  check("preview: es la cuenta por defecto del Atajo, con 1 dispositivo activo", p.shortcut_default === true && n(p.active_devices) === 1);
  // Saldo de X: 10000 −3000 −1500 +20000 −30000 +5000 +10000 −4000 +2500 −999 = 8001.
  check("preview: saldo de X = 8001 (el descartado no cuenta)", n(p.balance_cents) === 8001, String(p.balance_cents));
  // Valor: saldo − aportado (10000) + valor de la posición. La aportación es
  // POSTERIOR a la última valoración, así que la posición vale 12000 + 10000
  // (20261005090300_valor_de_posicion_con_aportes_posteriores.sql).
  const [w] = await comoUsuario(s.uid, () => q("select worth_cents from public.v_account_worth where account_id = $1", [s.X]));
  check(
    "preview: valor de X (inversión) = 8001 − 10000 + (12000 + 10000) = 20001 = v_account_worth",
    n(p.worth_cents) === 20001 && n(w.worth_cents) === 20001,
    String(p.worth_cents),
  );
  const enteros = JSON.stringify(p).match(/"\w*cents":-?\d+(\.\d+)?/g) ?? [];
  check("preview: todo importe es entero", enteros.length > 0 && enteros.every((s) => !s.includes(".")));

  // El preview no borra nada.
  check("preview: no borra nada", n((await restos(s.X)).movimientos) === 11);

  // DELETE directo: la política sigue cerrada fuera de delete_account.
  const directo = await comoUsuario(s.uid, async () => ({
    cuenta: (await client.query("delete from public.account where id = $1", [s.X])).rowCount,
    posicion: (await client.query("delete from public.investment_position where id = $1", [s.P])).rowCount,
  }));
  check("DELETE directo sobre account y investment_position: 0 filas (la política sigue cerrada)", directo.cuenta === 0 && directo.posicion === 0, JSON.stringify(directo));

  // Nombre equivocado: error y nada borrado.
  for (const malo of ["bróker prueba", "Broker Prueba", "Bróker", "", null]) {
    const e = await intentoComo(s.uid, () => borrar(s.X, malo));
    check(`nombre ${JSON.stringify(malo)}: rechazado (22023) y nada borrado`, e?.code === "22023" && n((await restos(s.X)).cuentas) === 1, e?.message);
  }
  const noExiste = await intentoComo(s.uid, () => borrar("00000000-0000-0000-0000-000000000000", "x"));
  check("cuenta inexistente: «no encontrada» (P0002)", noExiste?.code === "P0002", noExiste?.message);

  // El borrado de verdad, con espacios alrededor del nombre.
  const otros = await q(
    `select (select count(*) from public.card where account_id <> $1 and user_id = $2) as tarjetas,
            (select count(*) from public.savings_goal where account_id <> $1 and user_id = $2) as metas,
            (select count(*) from public.merchant_rule where user_id = $2) as reglas,
            (select count(*) from public.budget where user_id = $2) as limites,
            (select count(*) from public.ingest_device where user_id = $2) as dispositivos,
            (select count(*) from public.category where user_id = $2) as categorias,
            (select count(*) from public.transaction where user_id = $2 and account_id <> $1 and coalesce(to_account_id, account_id) <> $1) as movs`,
    [s.X, s.uid],
  );
  const saldoAntes = await comoUsuario(s.uid, saldos);
  const r = await comoUsuario(s.uid, () => borrar(s.X, "  Bróker Prueba  "));
  check(
    "delete_account devuelve los recuentos (11 movs, 1 de cada resto)",
    n(r.transactions) === 11 && [r.cards, r.positions, r.valuations, r.subscriptions, r.recurring_incomes, r.goals].every((v) => n(v) === 1),
    JSON.stringify(r),
  );
  const resto = await restos(s.X);
  check("no queda nada de X (cuenta, movimientos, tarjetas, posiciones, suscripciones, ingresos, metas, Atajo)", todoCero(resto), JSON.stringify(resto));
  const [val] = await q("select count(*) as n from public.valuation where position_id = $1", [s.P]);
  check("las valoraciones de la posición se fueron con ella", n(val.n) === 0);

  const saldoDespues = await comoUsuario(s.uid, saldos);
  check(
    "saldo de Y: exactamente −15000, lo que dijo el preview",
    saldoDespues.get(s.Y) - saldoAntes.get(s.Y) === -15000,
    `${saldoAntes.get(s.Y)} → ${saldoDespues.get(s.Y)}`,
  );
  check("saldo de Z: no cambia (su traspaso con Y no tocaba X)", saldoDespues.get(s.Z) === saldoAntes.get(s.Z));

  const [despues] = await q(
    `select (select count(*) from public.card where account_id <> $1 and user_id = $2) as tarjetas,
            (select count(*) from public.savings_goal where account_id <> $1 and user_id = $2) as metas,
            (select count(*) from public.merchant_rule where user_id = $2) as reglas,
            (select count(*) from public.budget where user_id = $2) as limites,
            (select count(*) from public.ingest_device where user_id = $2) as dispositivos,
            (select count(*) from public.category where user_id = $2) as categorias,
            (select count(*) from public.transaction where user_id = $2) as movs`,
    [s.X, s.uid],
  );
  check(
    "NADA de otras cuentas se borra (tarjeta y meta de Y, regla, límite, dispositivo, categorías, movimientos ajenos)",
    JSON.stringify(Object.values(despues).map(n)) === JSON.stringify(Object.values(otros[0]).map(n)),
    `${JSON.stringify(otros[0])} → ${JSON.stringify(despues)}`,
  );

  // Reembolso cruzado 1: el ingreso de Y sobrevive, desenganchado, como ingreso normal.
  const [iY] = await q("select reimburses_id, reimburses_target_type, amount_cents from public.transaction where id = $1", [s.iY]);
  check("el ingreso de Y que reembolsaba un gasto de X sigue ahí, sin enlace", iY && iY.reimburses_id === null && iY.reimburses_target_type === null && n(iY.amount_cents) === 4000);
  const [eY] = await comoUsuario(s.uid, () =>
    q("select real_income_cents, net_expense_cents, is_reimbursement from public.v_transaction_econ where id = $1", [s.iY]),
  );
  check("…y ahora cuenta como ingreso real (4000), no como reembolso", n(eY.real_income_cents) === 4000 && n(eY.net_expense_cents) === 0 && eY.is_reimbursement === false);
  // Reembolso cruzado 2: el gasto de Y pierde su rebaja.
  const [gY] = await comoUsuario(s.uid, () =>
    q(
      `select sum(net_expense_cents) as neto from public.v_transaction_econ e
       where e.id = $1 or e.id in (select id from public.transaction where reimburses_id = $1)`,
      [s.gY],
    ),
  );
  check("el gasto de Y que reembolsaba un ingreso de X vuelve a valer 2500 netos", n(gY.neto) === 2500);
  const [sub] = await q("select subscription_id from public.transaction where id = $1", [s.subEnY]);
  check("el cargo antiguo de la suscripción en Y sobrevive sin enlace", sub && sub.subscription_id === null);

  const [guc] = await q("select coalesce(current_setting('cartera.cuenta_a_borrar', true), '') as v");
  check("la variable que abre la política queda vacía al terminar", guc.v === "");

  const [perfil] = await q("select default_ingest_account_id from public.profile where user_id = $1", [s.uid]);
  check("el Atajo se queda sin cuenta por defecto (set null)", perfil.default_ingest_account_id === null);
}

// --------------------------------------------------------------------------
// 3. Aislamiento y permisos
// --------------------------------------------------------------------------
async function aislamiento() {
  console.log("\n— Aislamiento y permisos —\n");
  const s = await sembrar();
  const otro = (await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id"))[0].id;
  const suya = (await q("insert into public.account (user_id,name,type) values ($1,'Suya','BANCO') returning id::text as id", [otro]))[0].id;

  const e1 = await intentoComo(otro, () => preview(s.X));
  check("otro usuario no puede previsualizar la cuenta ajena («no encontrada»)", e1?.code === "P0002", e1?.message);
  const e2 = await intentoComo(otro, () => borrar(s.X, "Bróker Prueba"));
  check("otro usuario no puede borrarla, ni con el nombre correcto", e2?.code === "P0002" && n((await restos(s.X)).movimientos) === 11, e2?.message);

  // Con el 2FA opcional (20261019090000) solo se exige aal2 a quien tiene un
  // factor verificado: se le da uno (con la regla anterior da igual).
  await q(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (gen_random_uuid(), $1, 'prueba', 'totp', 'verified', now(), now())`,
    [s.uid],
  );
  const e3 = await intentoComo(s.uid, () => preview(s.X), "aal1");
  check("sesión sin aal2: no puede previsualizar (42501)", e3?.code === "42501", e3?.message);
  const e4 = await intentoComo(s.uid, () => borrar(s.X, "Bróker Prueba"), "aal1");
  check("sesión sin aal2: no puede borrar (42501), nada borrado", e4?.code === "42501" && n((await restos(s.X)).cuentas) === 1, e4?.message);

  // El dueño borra la suya; la del otro usuario sigue intacta.
  await comoUsuario(s.uid, () => borrar(s.X, "Bróker Prueba"));
  const [suyaSigue] = await q("select count(*) as n from public.account where id = $1", [suya]);
  check("borrar una cuenta no toca las del otro usuario", n(suyaSigue.n) === 1);

  // Tras un borrado en la misma transacción, la política vuelve a estar cerrada:
  // un DELETE directo sobre otra cuenta del mismo usuario no borra nada.
  const directo = await comoUsuario(s.uid, async () => (await client.query("delete from public.account where id = $1", [s.Z])).rowCount);
  check("tras delete_account, un DELETE directo sigue sin borrar nada", directo === 0);

  for (const f of ["public.account_delete_preview(uuid)", "public.delete_account(uuid, text)"]) {
    const [p] = await q(
      "select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth, has_function_privilege('public', $1, 'execute') as pub",
      [f],
    );
    check(`${f}: authenticated sí, anon y public no`, p.auth === true && p.anon === false && p.pub === false);
  }
  const [cfg] = await q(
    `select count(*) filter (where p.prosecdef) as definer,
            count(*) filter (where not coalesce(p.proconfig, '{}') @> array['search_path=""']) as sin_path
     from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname in ('account_delete_preview', 'delete_account')`,
  );
  check("las dos son security invoker y con search_path = ''", n(cfg.definer) === 0 && n(cfg.sin_path) === 0, JSON.stringify(cfg));
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const [ya] = await q("select count(*) as n from pg_proc where proname = 'delete_account'");
    if (n(ya.n) === 0) {
      await client.query(sqlMigracion);
      console.log(`(migración ${MIGRACION} aplicada dentro de la transacción)`);
    } else {
      console.log(`(migración ${MIGRACION} ya presente en la base)`);
    }

    const reales = await q(
      "select u.id::text as id from auth.users u order by u.created_at",
    );
    console.log(`\n— Datos reales: ${reales.length} usuarios (solo se informa si cuadra) —\n`);
    for (const [i, u] of reales.entries()) await datosReales(u.id, `real ${i + 1}`);

    const s = await sembrar();
    await pruebasSembradas(s);
    await aislamiento();
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
