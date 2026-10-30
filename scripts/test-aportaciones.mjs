/**
 * Prueba de 20261030090000_aportaciones_extra.sql: aportaciones extra a un
 * préstamo (amortización anticipada parcial).
 *
 *   node --env-file=.env.local scripts/test-aportaciones.mjs
 *
 *  1. Usuarios reales: sus cifras, idénticas (solo huellas; ninguna cifra).
 *  2. Esquema: RLS, search_path, permisos.
 *  3. EL CUADRO AL CÉNTIMO: `public.loan_plan_aportaciones` contra
 *     `cuadroConAportaciones` de src/lib/prestamos.ts en cientos de casos
 *     aleatorios, también en lo que rechazan.
 *  4. Funcional: registrar, generar con el cuadro nuevo, deshacer, liquidar,
 *     borrar, avisos, cuota entera y todas las protecciones.
 *
 * OJO: redefine `v_transaction_econ` y `v_loan_status` y cambia CHECK de
 * `transaction` dentro de su transacción: mientras dura, BLOQUEA esas vistas y
 * esa tabla a la app (pruebas-bd-bloquean-prod). Lanzarla con aviso.
 *
 * TODO dentro de UNA transacción que se deshace. Las fechas, con ::text.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";
import {
  APORTACION_MINIMA,
  CuadroInvalido,
  cuadroAmortizacion,
  cuadroConAportaciones,
  sumarMeses,
  tipoComoDecimal,
} from "../src/lib/prestamos.ts";

const VERSION = "20261030090000";
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

/** Como el usuario (aal2), en un savepoint que se deshace solo si falla. Devuelve { filas, error }. */
async function como(uid, sql, params) {
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

/** Lo mismo como service_role (el cron). */
async function comoServicio(sql, params) {
  await q("savepoint s");
  try {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await q("set local role service_role");
    const filas = await q(sql, params);
    await q("reset role");
    await q("release savepoint s");
    return { filas, error: null };
  } catch (e) {
    await q("rollback to savepoint s");
    await q("release savepoint s");
    return { filas: null, error: e };
  }
}

// Huellas extra de lo que la migración toca y foto-cifras no cubre.
const huella = (sql) => `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from (${sql}) x`;
const EXTRA = {
  // v_loan_status SIN las columnas nuevas (foto-cifras usa `select *`).
  prestamos: `select loan_id, payment_cents, last_payment_cents, remaining_count, principal_pending_cents,
                     schedule_pending_cents, interest_total_cents, interest_paid_cents, interest_pending_cents,
                     fees_paid_cents, total_cost_cents, next_period, next_due_on, next_payment_cents, end_on
              from public.v_loan_status`,
  cuadros: `select s.* from public.loan l cross join lateral (
              select period, due_on, payment_cents, interest_cents, principal_cents, balance_after_cents, state, has_movement
              from public.loan_schedule(l.id)) s`,
  prevision_categoria: "select * from public.category_forecast(date_trunc('month', current_date)::date)",
  busqueda_gastos: "select id, total_count, total_net_cents from public.search_transactions(p_type => 'EXPENSE', p_limit => 100000)",
};
async function fotoExtra(uid) {
  const foto = {};
  for (const [nombre, sql] of Object.entries(EXTRA)) {
    const r = await como(uid, huella(sql));
    foto[nombre] = r.error ? `ERROR ${r.error.code ?? r.error.message}` : r.filas[0].h;
  }
  return foto;
}

/** El cuadro de la base con aportaciones, en el formato de TS. Null si lo rechaza. */
async function cuadroSql(e, aps) {
  await q("savepoint c");
  try {
    const filas = await q(
      `select period, due_on::text as due_on, payment_cents, interest_cents, principal_cents, balance_after_cents, prepaid_cents
       from public.loan_plan_aportaciones($1, $2, $3::numeric, $4::date, $5::jsonb) order by period`,
      [
        e.principalCents,
        e.plazoMeses,
        tipoComoDecimal(e.tin),
        e.primeraCuota,
        JSON.stringify(aps.map((a) => ({ despues_de: a.despuesDe, importe: a.importe, modo: a.modo }))),
      ],
    );
    await q("release savepoint c");
    return filas.map((f) => ({
      periodo: f.period,
      fecha: f.due_on,
      cuota: n(f.payment_cents),
      intereses: n(f.interest_cents),
      capital: n(f.principal_cents),
      pendiente: n(f.balance_after_cents),
      aportado: n(f.prepaid_cents),
    }));
  } catch (e2) {
    await q("rollback to savepoint c");
    await q("release savepoint c");
    if (e2.code === "22023") return null;
    throw e2;
  }
}

function cuadroTs(e, aps) {
  try {
    return cuadroConAportaciones(e, aps);
  } catch (e2) {
    if (e2 instanceof CuadroInvalido) return null;
    throw e2;
  }
}

function semilla(s0) {
  let s = s0;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

async function alCentimo() {
  console.log("\n— El cuadro al céntimo: SQL contra TypeScript —\n");
  const azar = semilla(7);
  let iguales = 0;
  let rechazosIguales = 0;
  let casos = 0;
  const distintos = [];
  for (let caso = 0; caso < 400; caso++) {
    const e = {
      principalCents: 10_000 + Math.floor(azar() * 20_000_000),
      plazoMeses: 2 + Math.floor(azar() * 240),
      tin: Math.floor(azar() * 200_000),
      primeraCuota: `2026-0${1 + Math.floor(azar() * 9)}-${String(1 + Math.floor(azar() * 28)).padStart(2, "0")}`,
    };
    try {
      cuadroAmortizacion(e);
    } catch {
      continue;
    }
    // Aportaciones válidas, construidas en orden, con algún caso inválido a propósito.
    const aps = [];
    let c = cuadroConAportaciones(e, aps);
    const cuantas = Math.floor(azar() * 5);
    for (let i = 0; i < cuantas; i++) {
      const ultimaK = aps.length ? aps[aps.length - 1].despuesDe : 0;
      const k = ultimaK + Math.floor(azar() * Math.max(1, c.length - 1 - ultimaK));
      if (k >= c.length) break;
      const pend = k === 0 ? e.principalCents - aps.filter((a) => a.despuesDe === 0).reduce((s, a) => s + a.importe, 0) : c[k - 1].pendiente;
      const malo = azar() < 0.08;
      const importe = malo ? pend + Math.floor(azar() * 3) : APORTACION_MINIMA + Math.floor(azar() * Math.max(1, pend - APORTACION_MINIMA - 1));
      aps.push({ despuesDe: k, importe, modo: azar() < 0.5 ? "PLAZO" : "CUOTA" });
      const siguiente = cuadroTs(e, aps);
      if (!siguiente) break;
      c = siguiente;
    }
    casos++;
    const ts = cuadroTs(e, aps);
    const sql = await cuadroSql(e, aps);
    if (ts === null && sql === null) rechazosIguales++;
    else if (JSON.stringify(ts) === JSON.stringify(sql)) iguales++;
    else if (distintos.length < 3) distintos.push(JSON.stringify({ e, aps, ts: ts?.slice(0, 2), sql: sql?.slice(0, 2) }).slice(0, 600));
  }
  check(
    `${casos} cuadros con aportaciones al azar: idénticos fila a fila (${iguales}) o rechazados en los dos lados (${rechazosIguales})`,
    iguales + rechazosIguales === casos && iguales > 250 && rechazosIguales > 0,
    distintos.join("\n        "),
  );

  // Sin aportaciones, el del contrato.
  const e = { principalCents: 1_000_000, plazoMeses: 52, tin: 70_000, primeraCuota: "2026-12-01" };
  const [{ iguales: mismo }] = await q(
    `select count(*) = 52 and bool_and(a is not distinct from b) as iguales from (
       select row(p.period, p.due_on, p.payment_cents, p.interest_cents, p.principal_cents, p.balance_after_cents) as a,
              row(x.period, x.due_on, x.payment_cents, x.interest_cents, x.principal_cents, x.balance_after_cents) as b
       from public.loan_plan(1000000, 52, 7, '2026-12-01') p
       join public.loan_plan_aportaciones(1000000, 52, 7, '2026-12-01', '[]'::jsonb) x using (period)) t`,
  );
  check("sin aportaciones, loan_plan_aportaciones = loan_plan", mismo === true);
  void e;
}

async function funcional(hoy) {
  console.log("\n— Funcional —\n");
  const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  const [u2] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  const uid = u.id;
  const [banco] = await q("insert into public.account (user_id, name, type, initial_balance_cents) values ($1, 'Banco', 'BANCO', 5000000) returning id::text as id", [uid]);
  const [coche] = await q("insert into public.category (user_id, name, type) values ($1, 'Coche', 'EXPENSE') returning id::text as id", [uid]);

  const crear = async (nombre, o) => {
    const r = await como(
      uid,
      `select public.create_loan($1, $2, $3, $4, $5::numeric, null, 0, $6, $7::date, $8::date, true, $9::uuid, $10) as r`,
      [nombre, banco.id, o.principal, o.plazo, o.tin, o.dia ?? 1, o.inicio, o.primera ?? null, o.categoria ?? null, o.entera ?? false],
    );
    if (r.error) throw r.error;
    return r.filas[0].r;
  };
  const estado = async (id) => (await como(uid, "select *, next_due_on::text as next_txt, end_on::text as fin_txt from public.v_loan_status where loan_id = $1", [id])).filas[0];
  const registrar = (id, on, cents, modo, fee = 0) =>
    como(uid, "select public.register_loan_prepayment($1, $2::date, $3, $4, $5) as r", [id, on, cents, modo, fee]);
  const saldo = async (cuenta) => n((await como(uid, "select balance_cents from public.v_account_balance where account_id = $1", [cuenta])).filas[0]?.balance_cents);

  // Préstamo 1: 10.000 € a 52 meses al 7 %, empezado hace 4 meses (3-4 cuotas cobradas).
  const inicio = `${sumarMeses(hoy, -4).slice(0, 7)}-10`;
  const l1 = await crear("Coche", { principal: 1_000_000, plazo: 52, tin: "7", inicio });
  const e1 = { principalCents: 1_000_000, plazoMeses: 52, tin: 70_000, primeraCuota: l1.first_charge_on };
  const antes = await estado(l1.loan_id);
  check("préstamo de prueba creado con cuotas cobradas", antes.paid_count >= 3, `${antes.paid_count}`);

  // Aportación en PLAZO, hoy.
  const r1 = await registrar(l1.loan_id, hoy, 300_000, "PLAZO");
  check("register_loan_prepayment: registra", !r1.error, r1.error?.message);
  const k1 = r1.filas?.[0]?.r?.after_period;
  check("… tras la última cuota cobrada", k1 === antes.paid_count, `${k1} vs ${antes.paid_count}`);
  const [tx] = await q("select type, amount_cents, account_id::text as a, to_account_id::text as b, loan_period from public.transaction where loan_id = $1 and loan_part = 'AMORTIZACION'", [l1.loan_id]);
  check("… con un TRASPASO banco → cuenta del préstamo, sin número de cuota", tx?.type === "TRANSFER" && n(tx.amount_cents) === 300_000 && tx.a === banco.id && tx.b === l1.liability_account_id && tx.loan_period === null);
  const desp = await estado(l1.loan_id);
  check("v_loan_status: sin descuadre (lo que se debe = lo del cuadro)", n(desp.principal_pending_cents) === n(desp.schedule_pending_cents), `${desp.principal_pending_cents} vs ${desp.schedule_pending_cents}`);
  check("… la cuota no cambia, el fin se acorta y se ahorran intereses",
    n(desp.payment_cents) === n(antes.payment_cents) && desp.effective_term_months < 52 && n(desp.interest_saved_cents) > 0 && n(desp.prepaid_total_cents) === 300_000,
    JSON.stringify({ cuota: desp.payment_cents, fin: desp.effective_term_months, ahorro: desp.interest_saved_cents }));
  check("… term_months sigue siendo el del contrato", desp.term_months === 52);
  check("… restantes = fin efectivo − cobradas", desp.remaining_count === desp.effective_term_months - desp.paid_count);
  const ts1 = cuadroConAportaciones(e1, [{ despuesDe: k1, importe: 300_000, modo: "PLAZO" }]);
  const sched = (await como(uid, "select period, payment_cents, balance_after_cents, prepaid_cents, state from public.loan_schedule($1) order by period", [l1.loan_id])).filas;
  check("loan_schedule = el cuadro de TS (cuotas, pendiente, aportado)",
    sched.length === ts1.length && sched.every((f, i) => n(f.payment_cents) === ts1[i].cuota && n(f.balance_after_cents) === ts1[i].pendiente && n(f.prepaid_cents) === ts1[i].aportado),
    `${sched.length} vs ${ts1.length}`);
  check("… la aportación sale en la fila de su cuota", n(sched[k1 - 1]?.prepaid_cents) === 300_000);

  // Protecciones del movimiento.
  const [{ id: txId }] = await q("select id::text from public.transaction where loan_id = $1 and loan_part = 'AMORTIZACION'", [l1.loan_id]);
  const borrar = await como(uid, "delete from public.transaction where id = $1", [txId]);
  check("borrar a mano el movimiento de una aportación: bloqueado (55000, en español)", borrar.error?.code === "55000" && /deshazla/.test(borrar.error.message), borrar.error?.message);
  const cambiar = await como(uid, "update public.transaction set amount_cents = 1 where id = $1", [txId]);
  check("cambiarle el importe: bloqueado", cambiar.error?.code === "55000");
  const nota = await como(uid, "update public.transaction set note = 'pedida al banco' where id = $1 returning id", [txId]);
  check("cambiarle la nota: sí", !nota.error && nota.filas.length === 1, nota.error?.message);

  // Validaciones.
  const pend = n(desp.principal_pending_cents);
  for (const [nombre, args, patron] of [
    ["lo que se debe entero → liquidar", [l1.loan_id, hoy, pend, "PLAZO"], /Pagar todo/],
    ["más de lo que se debe", [l1.loan_id, hoy, pend + 100, "CUOTA"], /Pagar todo/],
    ["menos de 1 €", [l1.loan_id, hoy, 99, "PLAZO"], /1 €/],
    ["modo inventado", [l1.loan_id, hoy, 1000, "TODO"], /plazo o la cuota/],
    ["fecha futura", [l1.loan_id, sumarMeses(hoy, 1), 1000, "PLAZO"], /entre el inicio/],
    ["antes del inicio", [l1.loan_id, "2000-01-01", 1000, "PLAZO"], /entre el inicio/],
    ["antes de la última cuota cobrada", [l1.loan_id, inicio, 1000, "PLAZO"], /cuota cobrada después/],
  ]) {
    const r = await registrar(...args);
    check(`rechaza: ${nombre}`, r.error?.code === "22023" && patron.test(r.error.message), r.error?.message ?? "aceptado");
  }
  const ajeno = await como(u2.id, "select public.register_loan_prepayment($1, $2::date, 1000, 'PLAZO', 0)", [l1.loan_id, hoy]);
  check("otro usuario no puede aportar a este préstamo", ajeno.error?.code === "P0002", ajeno.error?.message);
  const verAjeno = await como(u2.id, "select count(*)::int as c from public.loan_prepayment");
  check("otro usuario no ve sus aportaciones", verAjeno.filas?.[0]?.c === 0);
  const veCuadro = await como(u2.id, "select count(*)::int as c from public.loan_cuadro($1)", [l1.loan_id]);
  check("ni su cuadro", veCuadro.filas?.[0]?.c === 0);

  // El doble envío no apunta dos veces (now() es fijo en una transacción: la
  // primera aportación cuenta como «hace menos de dos minutos»).
  const doble = await registrar(l1.loan_id, hoy, 300_000, "PLAZO");
  const [{ c: amortizaciones }] = await q("select count(*)::int as c from public.transaction where loan_id = $1 and loan_part = 'AMORTIZACION'", [l1.loan_id]);
  check("la misma aportación otra vez, enseguida: rechazada, no apunta nada", doble.error?.code === "23514" && /ya está registrada/.test(doble.error.message) && amortizaciones === 1, doble.error?.message ?? "aceptada");

  // Índice: siguen siendo únicos el desembolso y la liquidación.
  const dosDesembolsos = await como(uid, "insert into public.transaction (user_id, type, amount_cents, occurred_on, account_id, to_account_id, loan_id, loan_part) values ($1, 'TRANSFER', 100, $2::date, $3, $4, $5, 'DESEMBOLSO')", [uid, hoy, l1.liability_account_id, banco.id, l1.loan_id]);
  check("un segundo desembolso sigue sin caber", dosDesembolsos.error?.code === "23505", dosDesembolsos.error?.message);

  // Deshacer: la última, sin cuotas desde entonces.
  const [{ id: apId }] = await q("select id::text from public.loan_prepayment where loan_id = $1", [l1.loan_id]);
  const r2 = await registrar(l1.loan_id, hoy, 50_000, "CUOTA", 1_500);
  check("una segunda aportación (en CUOTA, con comisión)", !r2.error, r2.error?.message);
  const tras2 = await estado(l1.loan_id);
  check("… baja la cuota y mantiene el fin vigente", n(tras2.payment_cents) < n(desp.payment_cents) && tras2.effective_term_months === desp.effective_term_months,
    JSON.stringify({ cuota: [desp.payment_cents, tras2.payment_cents], fin: [desp.effective_term_months, tras2.effective_term_months] }));
  check("… y la comisión cuenta en las comisiones del préstamo", n(tras2.fees_paid_cents) === n(desp.fees_paid_cents) + 1_500);
  const viejo = await como(uid, "select public.undo_loan_prepayment($1)", [apId]);
  check("deshacer una que no es la última: rechazado", viejo.error?.code === "23514", viejo.error?.message);
  const [{ id: ap2 }] = await q("select id::text from public.loan_prepayment where loan_id = $1 order by created_at desc, id desc limit 1", [l1.loan_id]);
  const des = await como(uid, "select public.undo_loan_prepayment($1)", [ap2]);
  check("deshacer la última: sí", !des.error, des.error?.message);
  const tras3 = await estado(l1.loan_id);
  const [{ c: restos }] = await q("select count(*)::int as c from public.transaction where loan_id = $1 and loan_part in ('COMISION_AMORTIZACION') ", [l1.loan_id]);
  check("… vuelve a como estaba (cuota, fin, comisiones) y se lleva su comisión",
    n(tras3.payment_cents) === n(desp.payment_cents) && tras3.effective_term_months === desp.effective_term_months && n(tras3.fees_paid_cents) === n(desp.fees_paid_cents) && restos === 0);

  // Generar con el cuadro nuevo: se «retrocede» el préstamo 2 cuotas y se aporta entre medias.
  const l2 = await crear("Moto", { principal: 600_000, plazo: 24, tin: "9", inicio });
  const e2 = { principalCents: 600_000, plazoMeses: 24, tin: 90_000, primeraCuota: l2.first_charge_on };
  const st2 = await estado(l2.loan_id);
  const kAtras = st2.paid_count - 2;
  await q("delete from public.transaction where loan_id = $1 and loan_period > $2", [l2.loan_id, kAtras]);
  await q("update public.loan set last_generated_period = $2, notified_period = $2 where id = $1", [l2.loan_id, kAtras]);
  const fechaK = cuadroAmortizacion(e2)[kAtras - 1].fecha;
  const dia = sumarMeses(fechaK, 0).slice(0, 8) + String(Math.min(Number(fechaK.slice(8)) + 1, 28)).padStart(2, "0");
  const r3 = await registrar(l2.loan_id, dia, 200_000, "CUOTA");
  check("aportación con fecha pasada, entre dos cuotas aún sin cobrar", !r3.error, r3.error?.message);
  const ts2 = cuadroConAportaciones(e2, [{ despuesDe: kAtras, importe: 200_000, modo: "CUOTA" }]);
  const gen = await q("select loan_period, loan_part, amount_cents from public.transaction where loan_id = $1 and loan_period > $2 order by loan_period, loan_part", [l2.loan_id, kAtras]);
  const esperado = ts2.filter((f) => f.periodo > kAtras && f.fecha <= hoy).flatMap((f) => [
    { loan_period: f.periodo, loan_part: "CAPITAL", amount_cents: f.capital },
    { loan_period: f.periodo, loan_part: "INTERESES", amount_cents: f.intereses },
  ]);
  check("las cuotas que vencieron después se cobran ya con el cuadro nuevo",
    gen.length === esperado.length && gen.length > 0 && gen.every((g, i) => g.loan_period === esperado[i].loan_period && g.loan_part === esperado[i].loan_part && n(g.amount_cents) === esperado[i].amount_cents),
    JSON.stringify({ gen: gen.slice(0, 4), esperado: esperado.slice(0, 4) }));
  const [{ id: ap3 }] = await q("select id::text from public.loan_prepayment where loan_id = $1", [l2.loan_id]);
  const tarde = await como(uid, "select public.undo_loan_prepayment($1)", [ap3]);
  check("deshacerla con cuotas ya cobradas con ella: rechazado", tarde.error?.code === "23514", tarde.error?.message);
  const st2b = await estado(l2.loan_id);
  check("… y sin descuadre", n(st2b.principal_pending_cents) === n(st2b.schedule_pending_cents), `${st2b.principal_pending_cents} vs ${st2b.schedule_pending_cents}`);

  // Avisos de cuota: el importe del cuadro efectivo, y «k de N» con el fin efectivo.
  // (Registrar marca como avisado lo que genera: se deja pendiente de avisar.)
  await q("update public.loan set notified_period = $2 where id = $1", [l2.loan_id, kAtras]);
  const avisos = await comoServicio("select loan_id::text as id, from_period, to_period, term_months, amount_cents from public.claim_loan_installment_notices()");
  const deMoto = avisos.filas?.find((a) => a.id === l2.loan_id);
  const sumaEsperada = ts2.filter((f) => f.periodo >= (deMoto?.from_period ?? 0) && f.periodo <= (deMoto?.to_period ?? -1)).reduce((s, f) => s + f.cuota, 0);
  check("avisos de cuota: importe y número de cuotas del cuadro efectivo",
    deMoto && n(deMoto.amount_cents) === sumaEsperada && deMoto.term_months === ts2.length, JSON.stringify(deMoto));

  // Cambiar condiciones con aportaciones (préstamo sin cuotas aún).
  const l3 = await crear("Reforma", { principal: 500_000, plazo: 36, tin: "5", inicio: hoy });
  const r4 = await registrar(l3.loan_id, hoy, 100_000, "PLAZO");
  check("aportación antes de la primera cuota", !r4.error && r4.filas[0].r.after_period === 0, r4.error?.message);
  const st3 = await estado(l3.loan_id);
  check("… el cuadro ya la descuenta (sin descuadre)", n(st3.schedule_pending_cents) === 400_000 && n(st3.principal_pending_cents) === 400_000);
  const terms = await como(uid, "select public.update_loan_terms($1, $2, 500000, 24, 5::numeric, 0, 1, $3::date, null, true)", [l3.loan_id, banco.id, hoy]);
  check("cambiar las condiciones con aportaciones: rechazado", terms.error?.code === "23514" && /aportaciones/.test(terms.error.message), terms.error?.message);

  // Cuota entera: la aportación cuenta como gasto en la categoría del préstamo.
  const l4 = await crear("Portátil", { principal: 200_000, plazo: 12, tin: "0", inicio, categoria: coche.id, entera: true });
  await registrar(l4.loan_id, hoy, 30_000, "PLAZO");
  const [{ id: tx4 }] = await q("select id::text from public.transaction where loan_id = $1 and loan_part = 'AMORTIZACION'", [l4.loan_id]);
  const econ = (await como(uid, "select type, econ_category_id::text as c, net_expense_cents from public.v_transaction_econ where id = $1", [tx4])).filas[0];
  check("con la cuota entera, la aportación es gasto de su categoría", econ?.type === "EXPENSE" && econ.c === coche.id && n(econ.net_expense_cents) === 30_000, JSON.stringify(econ));
  const econ1 = (await como(uid, "select count(*)::int as c from public.v_transaction_econ where id = $1", [txId])).filas[0];
  check("sin ella, no (es un traspaso)", econ1.c === 0);

  // Liquidar después de aportar: paga lo que de verdad queda.
  const bancoAntes = await saldo(banco.id);
  const pendL1 = n((await estado(l1.loan_id)).principal_pending_cents);
  const liq = await como(uid, "select public.settle_loan($1, $2::date, 0) as r", [l1.loan_id, hoy]);
  const fin1 = await estado(l1.loan_id);
  check("liquidar tras aportar: paga lo que queda y la deuda queda a 0",
    !liq.error && n(liq.filas[0].r.settled_cents) === pendL1 && n(fin1.principal_pending_cents) === 0 && fin1.status === "LIQUIDADO" && (await saldo(banco.id)) === bancoAntes - pendL1,
    liq.error?.message);

  // Borrar un préstamo con aportaciones: todo fuera, sin restos.
  const del = await como(uid, "select public.delete_loan($1, 'Moto')", [l2.loan_id]);
  const [{ c: huerfanas }] = await q("select count(*)::int as c from public.loan_prepayment where loan_id = $1", [l2.loan_id]);
  const [{ c: movs }] = await q("select count(*)::int as c from public.transaction where loan_id = $1", [l2.loan_id]);
  check("delete_loan con aportaciones: se lleva movimientos y aportaciones", !del.error && huerfanas === 0 && movs === 0, del.error?.message);
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    await aplicarPendientes(client, { hasta: String(Number(VERSION) - 1) });
    const [{ hoy }] = await q("select private.hoy()::text as hoy");

    const reales = (await q("select id::text as id from auth.users order by created_at")).map((r) => r.id);
    const fotos = [];
    for (const r of reales) fotos.push({ base: await fotoUsuario(client, r), extra: await fotoExtra(r) });

    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})`);

    console.log("\n— Usuarios reales (solo huellas) —\n");
    const cambios = [];
    for (const [i, r] of reales.entries()) {
      const base = compararFotos(fotos[i].base, await fotoUsuario(client, r)).filter((k) => k !== "prestamos");
      const extra = compararFotos(fotos[i].extra, await fotoExtra(r));
      if (base.length || extra.length) cambios.push(`usuario ${i + 1}: ${[...base, ...extra].join(", ")}`);
    }
    check(`cifras de los ${reales.length} usuarios reales idénticas (gasto, saldos, previsión, búsqueda, préstamos, cuadros)`, cambios.length === 0, cambios.join("; "));

    console.log("\n— Esquema —\n");
    const [rls] = await q("select relrowsecurity and relforcerowsecurity as v from pg_class where oid = 'public.loan_prepayment'::regclass");
    check("loan_prepayment con RLS forzada", rls.v === true);
    const [inv] = await q(`select bool_and(coalesce(c.reloptions::text like '%security_invoker=true%', false)) as v
                           from pg_class c where c.oid in ('public.v_transaction_econ'::regclass, 'public.v_loan_status'::regclass)`);
    check("v_transaction_econ y v_loan_status siguen con security_invoker", inv.v === true);
    const sinRuta = await q(`select p.oid::regprocedure::text as f from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                             where s.nspname in ('public', 'private')
                               and p.proname in ('loan_cuota', 'loan_fin_previsto', 'loan_plan_aportaciones', 'loan_cuadro', 'loan_schedule',
                                                 'loan_generate', 'claim_loan_installment_notices', 'register_loan_prepayment',
                                                 'undo_loan_prepayment', 'tg_aportacion_protegida', 'delete_loan', 'update_loan_terms',
                                                 'month_forecast', 'category_forecast', 'search_transactions')
                               and (not coalesce(p.proconfig @> array['search_path=""'], false) or p.prosecdef)`);
    check("todas con search_path = '' y ninguna security definer", sinRuta.length === 0, sinRuta.map((r) => r.f).join(", "));
    const priv = async (f, rol) => (await q("select has_function_privilege($2, $1, 'execute') as p", [f, rol]))[0].p;
    for (const f of [
      "public.register_loan_prepayment(uuid, date, bigint, text, bigint)",
      "public.undo_loan_prepayment(uuid)",
      "public.loan_schedule(uuid)",
      "public.loan_cuadro(uuid)",
    ]) {
      check(`${f.split("(")[0]}: authenticated sí, anon y public no`, (await priv(f, "authenticated")) && !(await priv(f, "anon")) && !(await priv(f, "public")));
    }
    const [anon] = await q("select has_table_privilege('anon', 'public.loan_prepayment', 'select') as s");
    check("anon no lee loan_prepayment", anon.s === false);

    await alCentimo();
    await funcional(hoy);
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
