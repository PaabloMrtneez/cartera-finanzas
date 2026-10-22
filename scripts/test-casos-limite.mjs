/**
 * Casos límite de cálculo de la capa de datos (fase 1 del cierre de la v1).
 *
 *   node --env-file=.env.local scripts/test-casos-limite.mjs
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): los
 * usuarios sintéticos se insertan en auth.users ahí dentro y no persiste nada.
 * No se lee ningún dato de los usuarios reales.
 *
 * Cada comprobación dice lo que DEBERÍA pasar. Un FALLO aquí es un hallazgo
 * (cifra incorrecta o error donde no debería haberlo), no un fallo del script:
 * el informe docs/pruebas/informe-datos.md los recoge. Los marcados
 * «(arreglado, X)» eran los «hallazgos conocidos» de la fase 1, ya corregidos
 * por las migraciones del cierre (20261020*): la prueba aplica las que falten
 * dentro de su transacción.
 *
 * Bloques: importes extremos · fechas (fin de mes, 29 de febrero, día de cobro)
 * · préstamos (TIN 0, plazo 1/480, cuotas vencidas) · posiciones sin precio,
 * con precio viejo o sin tipo de cambio · cuenta archivada con saldo · borrados
 * con préstamo y con reembolsos · reembolsos raros · idempotencia de los
 * generadores.
 *
 * Las fechas se piden con ::text (el driver pg + toISOString resta un día).
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
const n = (v) => (v === null || v === undefined ? null : Number(v));

let ok = 0;
let mal = 0;
const hallazgos = [];
function check(nombre, condicion, detalle = "") {
  if (condicion) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    mal++;
    hallazgos.push(nombre);
    console.log(`  FALLO ${nombre}${detalle ? `\n        ${detalle}` : ""}`);
  }
}

async function comoUsuario(uid, trabajo) {
  await q("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
  ]);
  await q("set local role authenticated");
  try {
    return await trabajo();
  } finally {
    await q("reset role").catch(() => {});
  }
}

/** Ejecuta en un savepoint que se deshace siempre; devuelve { filas, error }. */
async function intento(uid, sql, params = []) {
  await q("savepoint intento");
  let filas = null;
  let error = null;
  try {
    if (uid) {
      await q("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
      ]);
      await q("set local role authenticated");
    }
    filas = await q(sql, params);
  } catch (e) {
    error = e;
  }
  await q("rollback to savepoint intento");
  await q("release savepoint intento");
  return { filas, error };
}

async function usuario() {
  const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  return u.id;
}
const cuenta = (uid, nombre, tipo = "BANCO", inicial = 0) =>
  q("insert into public.account (user_id,name,type,initial_balance_cents) values ($1,$2,$3,$4) returning id::text as id", [
    uid, nombre, tipo, inicial,
  ]).then((r) => r[0].id);
const categoria = (uid, nombre, tipo = "EXPENSE") =>
  q("insert into public.category (user_id,name,type) values ($1,$2,$3) returning id::text as id", [uid, nombre, tipo]).then(
    (r) => r[0].id,
  );
const gasto = (uid, cta, cents, fecha, cat = null, status = "CONFIRMED") =>
  q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
     values ($1,'EXPENSE',$2,'g',${fecha},$3,$4,case when $4::uuid is null then null else 'EXPENSE'::public.entry_type end,'MANUAL',$5)
     returning id::text as id`,
    [uid, cents, cta, cat, status],
  ).then((r) => r[0].id);
const reembolso = (uid, cta, cents, fecha, de) =>
  q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,source,status,reimburses_id,reimburses_target_type)
     values ($1,'INCOME',$2,'r',${fecha},$3,'MANUAL','CONFIRMED',$4,'EXPENSE') returning id::text as id`,
    [uid, cents, cta, de],
  ).then((r) => r[0].id);
const MES = "date_trunc('month', current_date)::date";

// --------------------------------------------------------------------------
async function importes() {
  console.log("\n— Importes extremos —\n");
  const u = await usuario();
  const b = await cuenta(u, "Banco");
  for (const [cents, desc] of [[0, "cero"], [-1, "negativo"], [100_000_000_001, "mayor que 1.000 M€"]]) {
    const r = await intento(null, `insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id) values ($1,'EXPENSE',$2,current_date,$3)`, [u, cents, b]);
    check(`Movimiento de importe ${desc}: rechazado por CHECK (23514)`, r.error?.code === "23514", r.error?.code ?? "aceptado");
  }
  const r2 = await intento(null, "update public.account set initial_balance_cents = 100000000001 where id = $1", [b]);
  check("Saldo inicial > 1.000 M€: rechazado (23514)", r2.error?.code === "23514");

  // 1.000 movimientos de 1.000 M€ cada uno en el mismo mes: 10^14 céntimos.
  await q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,source,status)
     select $1, 'INCOME', 100000000000, 'x', current_date, $2, 'MANUAL', 'CONFIRMED' from generate_series(1, 1000)`,
    [u, b],
  );
  const esperado = 100_000_000_000n * 1000n;
  const [s] = await comoUsuario(u, () =>
    q(`select (select income_cents::text from public.v_month_summary where period_month = ${MES}) as ingreso,
              (select balance_cents::text from public.v_account_balance) as saldo,
              (select net_worth_cents::text from public.v_net_worth) as patrimonio,
              (select net_worth_cents::text from public.net_worth_monthly(1)) as mensual`),
  );
  check(
    "10^14 céntimos: mes, saldo, patrimonio y curva mensual exactos (sin coma flotante)",
    [s.ingreso, s.saldo, s.patrimonio, s.mensual].every((x) => BigInt(x) === esperado),
    JSON.stringify(s),
  );
  check(
    "… y 10^14 cabe en un Number de JS sin perder céntimos (< 2^53)",
    Number.isSafeInteger(Number(esperado)),
  );

  // Tablas SIN tope superior en la base: el tope solo lo pone Number.isSafeInteger en la app (~9·10^15).
  const sinTope = [];
  for (const [tabla, sql, params] of [
    ["subscription.amount_cents", "insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,account_id) values ($1,'s',9000000000000000,'MENSUAL',current_date+1,$2)", [u, b]],
    ["recurring_income.amount_cents", "insert into public.recurring_income (user_id,description,amount_cents,periodicity,next_income_date,account_id) values ($1,'s',9000000000000000,'MENSUAL',current_date+1,$2)", [u, b]],
    ["savings_goal.target_cents", "insert into public.savings_goal (user_id,name,target_cents,account_id) values ($1,'m',9000000000000000,$2)", [u, b]],
  ]) {
    const r = await intento(null, sql, params);
    if (!r.error) sinTope.push(tabla);
  }
  check(
    "(arreglado, M6) Importes de fijos/metas/valoraciones con el mismo tope de 1.000 M€ que los movimientos",
    sinTope.length === 0,
    `aceptan 9·10^15 céntimos: ${sinTope.join(", ")}`,
  );
  // Un importe enorme pero alcanzable por PostgREST desbordaba bigint en las vistas.
  const r3 = await intento(u, "select * from public.v_subscription_summary", []);
  const enorme = await intento(
    null,
    "insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,account_id) values ($1,'enorme',200000000000000000,'SEMANAL',current_date+1,$2)",
    [u, b],
  );
  let r4 = { error: null };
  if (!enorme.error) {
    await q("savepoint s1");
    await q(
      "insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,account_id) values ($1,'enorme',200000000000000000,'SEMANAL',current_date+1,$2)",
      [u, b],
    );
    r4 = await intento(u, "select * from public.v_subscription_summary", []);
    await q("rollback to savepoint s1");
  }
  check(
    "(arreglado, M6) Una suscripción semanal de 2·10^15 € no rompe v_subscription_summary (se rechaza al guardarla)",
    !r3.error && !r4.error && enorme.error?.code === "23514",
    r4.error ? `${r4.error.code} ${r4.error.message}` : enorme.error ? "" : "la suscripción enorme se aceptó",
  );
}

// --------------------------------------------------------------------------
async function fechas() {
  console.log("\n— Fechas: fin de mes, 29 de febrero, día de cobro —\n");
  const u = await usuario();
  const b = await cuenta(u, "Banco");
  const [s31] = await q(
    `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,started_at,account_id)
     values ($1,'día 31',1000,'MENSUAL','2026-01-31','2026-01-31',$2) returning id::text as id`,
    [u, b],
  );
  const [s29] = await q(
    `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,started_at,account_id)
     values ($1,'29 feb',1000,'ANUAL','2024-02-29','2024-02-29',$2) returning id::text as id`,
    [u, b],
  );
  await comoUsuario(u, () => q("select public.generate_subscription_charges()"));
  const fechas31 = (await q("select occurred_on::text as d from public.transaction where subscription_id = $1 order by 1", [s31.id])).map((r) => r.d);
  check(
    "(arreglado, M5) Suscripción del 31: se cobra el último día de cada mes (31 ene, 28 feb, 31 mar, 30 abr…)",
    fechas31.slice(0, 4).join() === "2026-01-31,2026-02-28,2026-03-31,2026-04-30",
    `cobros: ${fechas31.slice(0, 5).join(", ")} … (el día se queda en 28 para siempre)`,
  );
  const fechas29 = (await q("select occurred_on::text as d from public.transaction where subscription_id = $1 order by 1", [s29.id])).map((r) => r.d);
  check(
    "Suscripción anual del 29 feb 2024: 2024-02-29, 2025-02-28, 2026-02-28",
    fechas29.join() === "2024-02-29,2025-02-28,2026-02-28",
    fechas29.join(", "),
  );
  const [prox] = await q("select next_charge_date::text as d from public.subscription where id = $1", [s29.id]);
  check("… y el próximo cobro, el 28 de febrero de 2027", prox.d === "2027-02-28", `próximo: ${prox.d}`);

  // Un 29 de febrero en los agregados mensuales.
  await gasto(u, b, 2900, "'2024-02-29'");
  const [feb] = await comoUsuario(u, () =>
    q("select net_expense_cents from public.v_month_summary where period_month = '2024-02-01'"),
  );
  check("Un gasto del 29 feb 2024 cae en febrero", n(feb?.net_expense_cents) >= 2900);

  // Préstamos: día de cobro 29/30/31 no admitido; 28 con inicio el 31 de enero.
  for (const dia of [29, 31, 0]) {
    const r = await intento(u, "select public.create_loan('x', $1, 100000, 12, 5, null, 0, $2, '2026-01-31', null, true)", [b, dia]);
    check(`Préstamo con día de cobro ${dia}: rechazado con mensaje (22023)`, r.error?.code === "22023", r.error?.code ?? "aceptado");
  }
  const r28 = await intento(u, "select public.create_loan('x', $1, 100000, 12, 5, null, 0, 28, '2026-01-31', null, true) as r", [b]);
  check("Día 28 con inicio el 31 de enero: primera cuota el 28 de febrero", r28.filas?.[0]?.r?.first_charge_on === "2026-02-28", JSON.stringify(r28.filas?.[0]?.r ?? r28.error?.message));

  // Cambio de hora: la base trabaja en UTC; «hoy» tiene que ser el de Madrid en
  // todas partes (private.hoy(), 20261020090200). Prueba detallada:
  // scripts/test-reloj-madrid.mjs.
  const [reloj] = await q(`
    select to_regprocedure('private.hoy()') is not null as hay,
      (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
        where s.nspname in ('public','private') and p.prosrc ~* '\\mcurrent_date\\M')::int as funciones,
      (select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace
        where s.nspname in ('public','private') and c.relkind = 'v' and pg_get_viewdef(c.oid) ~* '\\mcurrent_date\\M')::int as vistas,
      (select count(*) from pg_constraint k where k.connamespace = 'public'::regnamespace
        and pg_get_constraintdef(k.oid) ~* 'current_date')::int as checks`);
  check(
    "(arreglado, M4) Una sola zona horaria para «hoy» en toda la capa de datos",
    reloj.hay && reloj.funciones === 0 && reloj.vistas === 0 && reloj.checks === 0,
    `private.hoy: ${reloj.hay}; con current_date (UTC): ${reloj.funciones} funciones, ${reloj.vistas} vistas, ${reloj.checks} CHECK`,
  );
}

// --------------------------------------------------------------------------
async function prestamos() {
  console.log("\n— Préstamos —\n");
  const plan = (P, plazo, tin, primera = "2026-12-05") =>
    q(
      `select period, due_on::text as due_on, payment_cents, interest_cents, principal_cents, balance_after_cents
       from public.loan_plan($1, $2, $3::numeric, $4::date) order by period`,
      [P, plazo, tin, primera],
    );
  const a = await plan(10000, 3, 0);
  check("TIN 0, 100 € a 3 meses: 33,33 + 33,33 + 33,34 y sin intereses", a.map((f) => n(f.payment_cents)).join() === "3333,3333,3334" && a.every((f) => n(f.interest_cents) === 0));
  const b = await plan(100000, 1, 6);
  check("Plazo 1 mes al 6 %: una cuota de 1.005,00 €", b.length === 1 && n(b[0].payment_cents) === 100500 && n(b[0].balance_after_cents) === 0, JSON.stringify(b[0]));
  // Al 50 % y 480 meses la cuota ya no amortiza: la última se aparta de las
  // demás más del 10 % (H-08, 20261020091000).
  const c50 = await intento(null, "select * from public.loan_plan(1000000000, 480, 50::numeric, '2026-12-05')", []);
  check("(arreglado, H-08) Plazo 480 al 50 % TIN con 10 M€: rechazado, la cuota no amortiza (22023)", c50.error?.code === "22023", c50.error?.code ?? "aceptado");
  const c = await plan(1_000_000_000, 480, 3);
  check(
    "Plazo 480 al 3 % TIN con 10 M€: el capital suma el principal y acaba en 0",
    c.length === 480 && c.reduce((s, f) => s + n(f.principal_cents), 0) === 1_000_000_000 && n(c[479].balance_after_cents) === 0,
  );
  check("… y ninguna cuota negativa ni con intereses negativos", c.every((f) => n(f.payment_cents) > 0 && n(f.interest_cents) >= 0 && n(f.principal_cents) >= 0));
  for (const [plazo, tin] of [[481, 3], [0, 3], [12, 50.0001], [12, -1]]) {
    const r = await intento(null, "select * from public.loan_plan(100000, $1, $2::numeric, '2026-12-05')", [plazo, tin]);
    check(`loan_plan(plazo ${plazo}, TIN ${tin}): rechazado (22023)`, r.error?.code === "22023", r.error?.code ?? "aceptado");
  }

  const u = await usuario();
  const banco = await cuenta(u, "Banco", "BANCO", 1_000_000);
  // Desembolsado hace 5 años y 2 meses: todas las cuotas vencidas, de golpe.
  const [l1] = await comoUsuario(u, () =>
    q("select public.create_loan('Viejo', $1, 2000000, 120, 4, null, 0, 10, (current_date - interval '62 months')::date, null, true) as r", [banco]),
  );
  const [vencidas] = await q(
    "select count(*)::int as n from public.loan_plan(2000000, 120, 4, $1::date) where due_on <= (now() at time zone 'Europe/Madrid')::date",
    [l1.r.first_charge_on],
  );
  check(`Cuotas ya vencidas al crear: se generan las ${vencidas.n}`, l1.r.generated === vencidas.n, `${l1.r.generated}`);
  const [st] = await comoUsuario(u, () => q("select * from public.v_loan_status where loan_id = $1", [l1.r.loan_id]));
  check("Pendiente según la cuenta-pasivo = pendiente según el cuadro", n(st.principal_pending_cents) === n(st.schedule_pending_cents), `${st.principal_pending_cents} / ${st.schedule_pending_cents}`);
  const [pat] = await comoUsuario(u, () => q("select debt_cents, net_worth_cents, cash_cents from public.v_net_worth"));
  check("La deuda del patrimonio es −pendiente", n(pat.debt_cents) === -n(st.principal_pending_cents));
  const otra = await comoUsuario(u, () => q("select public.generate_loan_installments() as n"));
  const [dup] = await q("select count(*)::int as n, count(distinct (loan_period, loan_part))::int as d from public.transaction where loan_id = $1 and loan_period is not null", [l1.r.loan_id]);
  check("Generar otra vez no duplica (idempotente)", n(otra[0].n) === 0 && dup.n === dup.d, JSON.stringify(dup));

  // «Ya lo tenía apuntado», empezado hace 5 años: nada vencido, deuda = pendiente del cuadro.
  const [l2] = await comoUsuario(u, () =>
    q("select public.create_loan('Apuntado', $1, 2000000, 120, 4, null, 0, 10, (current_date - interval '60 months')::date, null, false) as r", [banco]),
  );
  const [st2] = await comoUsuario(u, () => q("select * from public.v_loan_status where loan_id = $1", [l2.r.loan_id]));
  check("Préstamo apuntado: 0 cuotas generadas, deuda = pendiente del cuadro", l2.r.generated === 0 && n(st2.principal_pending_cents) === n(st2.schedule_pending_cents));
  const r = await intento(u, "select public.create_loan('Pagado', $1, 100000, 12, 4, null, 0, 10, (current_date - interval '3 years')::date, null, false)", [banco]);
  check("Apuntado con todas las cuotas ya pasadas: rechazado con mensaje", r.error?.code === "22023", r.error?.message);

  // Liquidar hoy: la deuda queda a 0 y el patrimonio no cambia (traspaso).
  const antes = await comoUsuario(u, () => q("select net_worth_cents from public.v_net_worth"));
  const liq = await comoUsuario(u, () => q("select public.settle_loan($1, null, 0) as r", [l2.r.loan_id]));
  const [st3] = await comoUsuario(u, () => q("select status, principal_pending_cents from public.v_loan_status where loan_id = $1", [l2.r.loan_id]));
  const despues = await comoUsuario(u, () => q("select net_worth_cents from public.v_net_worth"));
  check(
    "Liquidar: pendiente 0, LIQUIDADO, y el patrimonio no cambia",
    st3.status === "LIQUIDADO" && n(st3.principal_pending_cents) === 0 && n(antes[0].net_worth_cents) === n(despues[0].net_worth_cents),
    JSON.stringify({ liq: liq[0].r, st3 }),
  );

  // Borrado de la cuenta de pago de un préstamo vivo.
  const [nombre] = await q("select name from public.account where id = $1", [banco]);
  const prev = await intento(u, "select public.account_delete_preview($1) as r", [banco]);
  const del = await intento(u, "select public.delete_account($1, $2) as r", [banco, nombre.name]);
  check(
    "(arreglado, B1) Borrar la cuenta de pago de un préstamo: la vista previa lo avisa antes de pedir el nombre",
    JSON.stringify(prev.filas?.[0]?.r ?? {}).includes("loan"),
    "account_delete_preview no trae los préstamos: el aviso llega después, como error del borrado",
  );
  // La FK (RESTRICT) lo impide y la app traduce el 23503 (friendlyDelete en cuentas/actions.ts).
  check(
    "… y el borrado se rechaza entero sin borrar nada (FK loan_payment_account_fk)",
    del.error?.code === "23503" && /loan_payment_account_fk/.test(del.error.message),
    del.error ? `${del.error.code} ${del.error.message}` : "¡se borró!",
  );
  const pasivo = l1.r.liability_account_id;
  const [np] = await q("select name from public.account where id = $1", [pasivo]);
  const delP = await intento(u, "select public.delete_account($1, $2) as r", [pasivo, np.name]);
  check(
    "Borrar a mano la cuenta-pasivo de un préstamo: rechazado (FK loan_liability_account_fk)",
    delP.error?.code === "23503" && /loan_liability_account_fk/.test(delP.error.message),
    delP.error ? `${delP.error.code} ${delP.error.message}` : "¡se borró!",
  );
  // Borrar el préstamo (delete_loan) sí se lleva sus movimientos y su cuenta-pasivo.
  const [ln] = await q("select name from public.loan where id = $1", [l1.r.loan_id]);
  const dl = await intento(
    u,
    `select public.delete_loan($1, $2) as r,
            (select count(*) from public.account where id = $3) as cuentas`,
    [l1.r.loan_id, ln.name, pasivo],
  );
  check("delete_loan: borra sus movimientos y su cuenta-pasivo", !dl.error, dl.error?.message);
}

// --------------------------------------------------------------------------
async function posiciones() {
  console.log("\n— Posiciones: sin precio, precio viejo, divisa sin cambio —\n");
  const u = await usuario();
  const banco = await cuenta(u, "Banco", "BANCO", 1_000_000);
  const broker = await cuenta(u, "Broker", "INVERSION");
  const instrumento = async (sim, divisa) =>
    (await q("insert into public.instrument (kind, yahoo_symbol, name, currency) values ('FONDO', $1, $1, $2) returning id::text as id", [sim, divisa]))[0].id;
  const posicion = async (nombre, inst, unidades, aportado) => {
    const [p] = await q("insert into public.investment_position (user_id,name,account_id,since) values ($1,$2,$3,current_date - 100) returning id::text as id", [u, nombre, broker]);
    await q(
      "insert into public.position_unit_event (user_id, position_id, kind, date, instrument_id, units, contributed_cents) values ($1,$2,'ALTA',current_date - 100,$3,$4,$5)",
      [u, p.id, inst, unidades, aportado],
    );
    return p.id;
  };
  const sinPrecio = await instrumento("ZZLIM-SINPRECIO", "EUR");
  const viejo = await instrumento("ZZLIM-VIEJO", "EUR");
  const gbp = await instrumento("ZZLIM-GBP", "GBP");
  await q("insert into public.instrument_price (instrument_id, date, close) values ($1, current_date - 30, 10)", [viejo]);
  await q("insert into public.instrument_price (instrument_id, date, close) select $1, current_date - g, 10 from generate_series(1, 5) g", [gbp]);
  const [hayGbp] = await q("select count(*)::int as n from public.fx_rate where currency = 'GBP'");
  const pSin = await posicion("Sin precio", sinPrecio, 100, 100000);
  const pViejo = await posicion("Precio viejo", viejo, 100, 100000);
  const pGbp = await posicion("En libras", gbp, 100, 100000);

  const m = await comoUsuario(u, () =>
    q("select position_id::text as id, value_cents, fuente, sin_precio, contributed_cents, gain_cents, desactualizado, dias_sin_precio from public.v_position_market"),
  );
  const de = (id) => m.find((x) => x.id === id);
  check("Precio viejo (hace 30 días): se usa y se marca desactualizado", n(de(pViejo).value_cents) === 100000 && de(pViejo).desactualizado === true && n(de(pViejo).dias_sin_precio) >= 15, JSON.stringify(de(pViejo)));
  check("Sin ningún precio: sin_precio = true", de(pSin).sin_precio === true);
  check(
    "(arreglado, A1) Sin precio: el valor no se hunde a 0 con 1.000 € aportados fuera de la app (debería valer lo aportado, no 0)",
    n(de(pSin).value_cents) >= 100000,
    `valor ${de(pSin).value_cents}, aportado ${de(pSin).contributed_cents}, ganancia ${de(pSin).gain_cents} (fuente ${de(pSin).fuente})`,
  );
  if (hayGbp.n === 0) {
    check("Divisa sin tipo de cambio (GBP): sin_precio = true", de(pGbp).sin_precio === true, JSON.stringify(de(pGbp)));
    check(
      "(arreglado, A1) Divisa sin cambio: el valor no se hunde a 0",
      n(de(pGbp).value_cents) >= 100000,
      `valor ${de(pGbp).value_cents}, ganancia ${de(pGbp).gain_cents}`,
    );
  }
  const [nw] = await comoUsuario(u, () => q("select invested_cents from public.v_net_worth"));
  check(
    "(arreglado, A1) El patrimonio invertido incluye las posiciones sin precio",
    n(nw.invested_cents) >= 300000,
    `invertido ${nw.invested_cents} (esperado ≥ 300000: tres posiciones de 1.000 €)`,
  );
  // Una aportación posterior sin participaciones y sin precio en su fecha: usa el primer precio posterior.
  await q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,position_id,source,status)
     values ($1,'TRANSFER',50000,'aporte',current_date - 40,$2,$3,$4,'MANUAL','CONFIRMED')`,
    [u, banco, broker, pViejo],
  );
  const [v2] = await comoUsuario(u, () => q("select value_cents, units::text from public.v_position_market where position_id = $1", [pViejo]));
  check("Aportación sin precio previo: estima participaciones con el primer precio posterior (500 € / 10 € = 50 → 150 participaciones, 1.500 €)", Number(v2.units) === 150 && n(v2.value_cents) === 150000, JSON.stringify(v2));
}

// --------------------------------------------------------------------------
async function archivadaYReembolsos() {
  console.log("\n— Cuenta archivada con saldo y reembolsos —\n");
  const u = await usuario();
  const b = await cuenta(u, "Banco", "BANCO", 100000);
  const vieja = await cuenta(u, "Vieja", "BANCO", 55500);
  await q("update public.account set archived = true, archived_at = now() where id = $1", [vieja]);
  const [r] = await comoUsuario(u, () =>
    q(`select (select net_worth_cents from public.v_net_worth) as nw,
              (select sum(worth_cents) from public.v_account_worth) as suma,
              (select net_worth_cents from public.net_worth_monthly(1)) as mensual,
              (select net_worth_cents from public.net_worth_daily(current_date, current_date)) as diario`),
  );
  check(
    "Cuenta archivada con saldo: cuenta igual en v_net_worth, Σ v_account_worth, mensual y diario (155.500)",
    [r.nw, r.suma, r.mensual, r.diario].every((x) => n(x) === 155500),
    JSON.stringify(r),
  );

  const cat = await categoria(u, "Ropa");
  const t = await q("insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,to_account_id) values ($1,'TRANSFER',1000,current_date,$2,$3) returning id::text as id", [u, b, vieja]);
  const rt = await intento(null, "insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,reimburses_id,reimburses_target_type) values ($1,'INCOME',500,current_date,$2,$3,'EXPENSE')", [u, b, t[0].id]);
  check("Reembolso de un TRASPASO: imposible (FK compuesta con el tipo, 23503)", rt.error?.code === "23503", rt.error?.code);
  const rt2 = await intento(null, "insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,reimburses_id,reimburses_target_type) values ($1,'INCOME',500,current_date,$2,$3,'TRANSFER')", [u, b, t[0].id]);
  check("… ni declarándolo como reembolso de traspaso (23514)", rt2.error?.code === "23514", rt2.error?.code);

  // Reembolso mayor que el gasto.
  const g1 = await gasto(u, b, 1000, "current_date", cat);
  const rMayor = await intento(
    u,
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,source,status,reimburses_id,reimburses_target_type)
     values ($1,'INCOME',1500,'r',current_date,$2,'MANUAL','CONFIRMED',$3,'EXPENSE')`,
    [u, b, g1],
  );
  const [c1] = await comoUsuario(u, () => q("select net_cents from public.category_breakdown(date_trunc('month', current_date)::date) where category_id = $1", [cat]));
  check(
    "(arreglado, M2) Un reembolso no puede superar el gasto que reembolsa",
    rMayor.error?.code === "23514" && n(c1?.net_cents ?? 0) >= 0,
    `${rMayor.error ? rMayor.error.message : "aceptado"}; gasto neto de la categoría: ${c1?.net_cents}`,
  );

  // Reembolso de un gasto DESCARTADO.
  const u2 = await usuario();
  const b2 = await cuenta(u2, "Banco");
  const cat2 = await categoria(u2, "Viajes");
  const g2 = await gasto(u2, b2, 30000, "current_date", cat2, "DISCARDED");
  await reembolso(u2, b2, 30000, "current_date", g2);
  const [m2] = await comoUsuario(u2, () =>
    q(`select net_expense_cents, income_cents from public.v_month_summary where period_month = ${MES}`),
  );
  check(
    "(arreglado, M2) El reembolso de un gasto DESCARTADO no deja el gasto del mes en negativo",
    n(m2?.net_expense_cents ?? 0) >= 0,
    `gasto neto ${m2?.net_expense_cents}, ingreso ${m2?.income_cents}`,
  );

  // Borrar un gasto con reembolso: el reembolso se vuelve un INGRESO.
  const u3 = await usuario();
  const b3 = await cuenta(u3, "Banco");
  const cat3 = await categoria(u3, "Tech");
  const g3 = await gasto(u3, b3, 50000, "current_date", cat3);
  await reembolso(u3, b3, 50000, "current_date", g3);
  const antes = await comoUsuario(u3, () => q(`select income_cents, net_expense_cents from public.v_month_summary where period_month = ${MES}`));
  // Ahora el borrado se bloquea con un mensaje (M1): hay que borrar o
  // desenlazar antes el reembolso. El intento se hace sin deshacer si sale bien.
  await q("savepoint borrar");
  let errBorrar = null;
  try {
    await comoUsuario(u3, () => q("delete from public.transaction where id = $1", [g3]));
  } catch (e) {
    errBorrar = e;
    await q("rollback to savepoint borrar");
  }
  await q("release savepoint borrar");
  const despues = await comoUsuario(u3, () => q(`select income_cents, net_expense_cents from public.v_month_summary where period_month = ${MES}`));
  check(
    "(arreglado, M1) Borrar un gasto reembolsado no convierte su reembolso en ingreso (se bloquea con mensaje)",
    n(despues[0]?.income_cents ?? 0) === n(antes[0]?.income_cents ?? 0) && errBorrar?.code === "55000",
    `${errBorrar ? errBorrar.message : "se borró"}; ingreso del mes: ${antes[0]?.income_cents} → ${despues[0]?.income_cents}`,
  );
}

// --------------------------------------------------------------------------
async function main() {
  await client.connect();
  await client.query("begin");
  try {
    // Las migraciones del cierre que aún no estén en la base, dentro de la
    // transacción: los hallazgos «(arreglado, …)» las necesitan.
    const ap = await aplicarPendientes(client);
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})`);
    await importes();
    await fechas();
    await prestamos();
    await posiciones();
    await archivadaYReembolsos();
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
  console.log(`\n${ok} correctas · ${mal} fallidas`);
  if (hallazgos.length) console.log(`\nHallazgos (FALLO):\n - ${hallazgos.join("\n - ")}`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
  process.exit(2);
});
