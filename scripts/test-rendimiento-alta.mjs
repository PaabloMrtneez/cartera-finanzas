/**
 * Prueba del capital aportado fuera de la app (el aportado declarado en el ALTA):
 *   20261008090000_capital_aportado_fuera_de_la_app.sql
 *
 *   node --env-file=.env.local scripts/test-rendimiento-alta.mjs
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): la
 * migración se aplica ahí dentro si aún no está en la base, los usuarios de
 * prueba se insertan ahí dentro, y no persiste nada.
 *
 * Bloques:
 *
 *   1. DATOS REALES, ANTES Y DESPUÉS. Se fotografía con las definiciones
 *      vigentes todo lo que depende del valor o del coste de una posición
 *      (patrimonio diario, mensual e histórico, v_net_worth, v_account_worth,
 *      metas, saldo por cuenta, v_position_value, v_position_market,
 *      position_return, portfolio_return, position_performance); se aplica la
 *      migración y se vuelve a fotografiar. Ninguna posición real tiene ALTA,
 *      así que todo tiene que salir idéntico. No se imprime ninguna cifra de
 *      nadie: solo si coincide.
 *   2. CASOS, con cifras calculadas a mano: posición nueva sincronizada sin
 *      traspasos, convertida con traspasos que cuadran, declarado mayor y
 *      menor que los traspasos, ajuste posterior, baja y vuelta a seguir
 *      (mismo total y total mayor), manual que ya se valoraba y se convierte,
 *      la cartera entera (portfolio_return) mezclando manuales y
 *      sincronizadas, y que el patrimonio no cambia.
 *   3. AISLAMIENTO Y PERMISOS de la función nueva.
 *
 * Las fechas se piden a la base con ::text: el driver pg convierte un `date` a
 * medianoche local y toISOString() daría el día anterior.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACION = "20261008090000_capital_aportado_fuera_de_la_app.sql";

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

/** Ejecuta `trabajo` con la sesión de `uid` (authenticated + aal2) y vuelve a postgres. */
async function comoUsuario(uid, trabajo) {
  await q("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
  ]);
  await q("set local role authenticated");
  try {
    return await trabajo();
  } finally {
    await q("reset role");
  }
}

/** Ejecuta `trabajo` con el rol `rol` dentro de un savepoint y devuelve el error (o null). */
async function intento(rol, trabajo) {
  await q("savepoint intento");
  let error = null;
  try {
    await q(`set local role ${rol}`);
    await trabajo();
  } catch (e) {
    error = e;
  }
  await q("rollback to savepoint intento");
  await q("release savepoint intento");
  return error;
}

// --------------------------------------------------------------------------
// 1. Fotografía
// --------------------------------------------------------------------------
const PATRIMONIO = [
  "net_worth_history",
  "net_worth_monthly",
  "net_worth_daily",
  "v_net_worth",
  "v_account_worth",
  "account_balance_monthly",
  "savings_goal_projection",
  "v_savings_goal_progress",
  "v_position_value",
];

async function fotografia(uid) {
  return comoUsuario(uid, async () => {
    const f = {};
    f.net_worth_history = await q("select period_month::text, net_worth_cents from public.net_worth_history(24)");
    f.net_worth_monthly = await q("select period_month::text, net_worth_cents, cash_cents, invested_cents, idle_cents from public.net_worth_monthly(24)");
    f.net_worth_daily = await q("select fecha::text, net_worth_cents, cash_cents, invested_cents, idle_cents from public.net_worth_daily(current_date - 400, current_date)");
    f.v_net_worth = await q("select * from public.v_net_worth");
    f.v_account_worth = await q("select * from public.v_account_worth order by account_id");
    f.account_balance_monthly = await q("select account_id, period_month::text, balance_cents, worth_cents from public.account_balance_monthly(24)");
    f.savings_goal_projection = await q("select * from public.savings_goal_projection(6)");
    f.v_savings_goal_progress = await q("select * from public.v_savings_goal_progress order by 1, 2");
    f.v_position_value = await q("select position_id, contributed_cents, valued_on::text, value_cents, sin_valorar, fuente from public.v_position_value order by position_id");
    f.v_position_market = await q("select position_id, value_cents, contributed_cents, gain_cents, return_pct from public.v_position_market order by position_id");
    f.position_performance = await q("select position_id, fecha::text, value_cents, cost_cents, return_pct from public.position_performance(date '2025-01-01', current_date)");
    for (const [desde, hasta] of [
      ["date '2024-12-31'", "current_date"],
      ["date '2026-01-01'", "current_date"],
      ["date_trunc('month', current_date)::date", "current_date"],
      ["date '2026-05-31'", "date '2026-08-31'"],
      ["current_date - 7", "current_date"],
    ]) {
      const clave = `${desde}..${hasta}`;
      f[`position_return ${clave}`] = await q(
        `select position_id, start_cents, end_cents, contributions_cents, gain_cents, return_pct, valued_on::text, sin_valorar from public.position_return(${desde}, ${hasta}) order by position_id`,
      );
      f[`portfolio_return ${clave}`] = await q(`select * from public.portfolio_return(${desde}, ${hasta})`);
    }
    return f;
  });
}

// --------------------------------------------------------------------------
// Siembra
// --------------------------------------------------------------------------
const nuevoUsuario = async () =>
  (await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id"))[0].id;

const cuenta = async (uid, nombre, tipo, inicial = 0) =>
  (
    await q(
      "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,$2,$3,$4) returning id::text as id",
      [uid, nombre, tipo, inicial],
    )
  )[0].id;

const posicion = async (uid, nombre, cuentaId, desde) =>
  (
    await q(
      "insert into public.investment_position (user_id,name,account_id,since) values ($1,$2,$3,$4) returning id::text as id",
      [uid, nombre, cuentaId, desde],
    )
  )[0].id;

const sufijo = Math.random().toString(36).slice(2, 7).toUpperCase();
const instrumento = async (nombre) =>
  (
    await q(
      "insert into public.instrument (kind, yahoo_symbol, name, currency) values ('FONDO',$1,$2,'EUR') returning id::text as id",
      [`ZZ${nombre}${sufijo}.T`, `Prueba ${nombre}`],
    )
  )[0].id;

const precio = (instId, fecha, cierre) =>
  q("insert into public.instrument_price (instrument_id, date, close) values ($1,$2,$3)", [instId, fecha, cierre]);

const evento = (uid, posId, kind, fecha, extra = {}) =>
  q(
    "insert into public.position_unit_event (user_id, position_id, kind, date, instrument_id, units, contributed_cents) values ($1,$2,$3,$4,$5,$6,$7)",
    [uid, posId, kind, fecha, extra.instrument ?? null, extra.units ?? null, extra.contributed ?? null],
  );

const aportar = (uid, desde, hacia, posId, cents, fecha) =>
  q(
    "insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,to_account_id,position_id) values ($1,'TRANSFER',$2,$3,$4,$5,$6)",
    [uid, cents, fecha, desde, hacia, posId],
  );

const valorar = (uid, posId, fecha, cents) =>
  q("insert into public.valuation (user_id, position_id, date, value_cents) values ($1,$2,$3,$4)", [uid, posId, fecha, cents]);

/** position_return de una posición, con la sesión del dueño. */
const rendimiento = (uid, posId, desde, hasta) =>
  comoUsuario(uid, async () => {
    const [r] = await q(
      "select start_cents, end_cents, contributions_cents, gain_cents, return_pct::text as pct from public.position_return($2::date, $3::date) where position_id = $1",
      [posId, desde, hasta],
    );
    return r
      ? { inicio: n(r.start_cents), fin: n(r.end_cents), flujos: n(r.contributions_cents), ganancia: n(r.gain_cents), pct: r.pct }
      : null;
  });

const mercado = (uid, posId) =>
  comoUsuario(uid, async () => {
    const [r] = await q(
      "select seguida, value_cents, contributed_cents, gain_cents, return_pct::text as pct from public.v_position_market where position_id = $1",
      [posId],
    );
    return { seguida: r.seguida, valor: n(r.value_cents), coste: n(r.contributed_cents), ganancia: n(r.gain_cents), pct: r.pct };
  });

const externos = (uid, posId) =>
  comoUsuario(uid, () =>
    q(
      "select fecha::text as fecha, cents::int as cents from private.position_external_contributions() where position_id = $1 order by fecha",
      [posId],
    ),
  );

const fmt = (o) => JSON.stringify(o);

// --------------------------------------------------------------------------
// 2. Casos
// --------------------------------------------------------------------------
async function casos() {
  console.log("\n— Casos —\n");
  const uid = await nuevoUsuario();
  const banco = await cuenta(uid, "Banco", "BANCO", 1000000);
  const inv = await cuenta(uid, "Bróker", "INVERSION", 0);
  const fondo = await instrumento("ALTA");
  for (const [d, p] of [
    ["2026-09-01", "12"],
    ["2026-09-04", "12.5"],
    ["2026-09-10", "13"],
  ]) {
    await precio(fondo, d, p);
  }

  // ── A. Nueva sincronizada, sin traspasos ─────────────────────────────────
  // 100 participaciones; declara 1.000,00 € aportados. Vale 1.200 el día 1 y
  // 1.300 el día 10.
  const pA = await posicion(uid, "Nueva", inv, "2026-09-01");
  await evento(uid, pA, "ALTA", "2026-09-01", { instrument: fondo, units: "100", contributed: 100000 });

  check("A: el capital declarado es un flujo externo en la fecha del ALTA", fmt(await externos(uid, pA)) === fmt([{ fecha: "2026-09-01", cents: 100000 }]), fmt(await externos(uid, pA)));
  const rA = await rendimiento(uid, pA, "2026-08-31", "2026-09-10");
  check(
    "A: desde antes del ALTA, aportado = lo declarado y ganancia = valor − declarado (+300,00, +30,00 %)",
    rA.inicio === 0 && rA.flujos === 100000 && rA.fin === 130000 && rA.ganancia === 30000 && rA.pct === "30.00",
    fmt(rA),
  );
  const mA = await mercado(uid, pA);
  check("A: la ficha dice lo mismo (coste 1.000, ganancia +300, +30,00 %)", mA.coste === 100000 && mA.ganancia === 30000 && mA.pct === "30.00", fmt(mA));
  const rA2 = await rendimiento(uid, pA, "2026-09-01", "2026-09-10");
  check(
    "A: un periodo que empieza en el ALTA ya lo lleva en el valor de inicio (sin flujo: +100 sobre 1.200 = +8,33 %)",
    rA2.inicio === 120000 && rA2.flujos === 0 && rA2.ganancia === 10000 && rA2.pct === "8.33",
    fmt(rA2),
  );
  const perfA = await comoUsuario(uid, () =>
    q("select fecha::text as fecha, value_cents, cost_cents, return_pct::text as pct from public.position_performance(date '2026-08-31', date '2026-09-10') where position_id = $1", [pA]),
  );
  check(
    "A: position_performance cuesta 1.000 en cada punto (la curva «Aportado frente a valor»)",
    perfA.map((r) => `${r.fecha}:${r.value_cents}/${r.cost_cents}`).join() ===
      "2026-09-01:120000/100000,2026-09-04:125000/100000,2026-09-10:130000/100000",
    fmt(perfA),
  );

  // ── B. Convertida, con traspasos que ya suman lo declarado ───────────────
  const pB = await posicion(uid, "Convertida", inv, "2026-08-01");
  await aportar(uid, banco, inv, pB, 50000, "2026-08-01");
  await aportar(uid, banco, inv, pB, 30000, "2026-08-15");
  await evento(uid, pB, "ALTA", "2026-09-01", { instrument: fondo, units: "70", contributed: 80000 });
  check("B: traspasos que cuadran con lo declarado → ningún flujo externo", (await externos(uid, pB)).length === 0);
  const rB = await rendimiento(uid, pB, "2026-07-31", "2026-09-10");
  check(
    "B: aportado = los traspasos (800), ganancia = 70 × 13 − 800 = +110",
    rB.inicio === 0 && rB.flujos === 80000 && rB.fin === 91000 && rB.ganancia === 11000,
    fmt(rB),
  );
  const mB = await mercado(uid, pB);
  check("B: la ficha, igual (coste 800, ganancia +110)", mB.coste === 80000 && mB.ganancia === 11000, fmt(mB));

  // ── C. Declaró MÁS que sus traspasos ─────────────────────────────────────
  const pC = await posicion(uid, "Mas", inv, "2026-08-01");
  await aportar(uid, banco, inv, pC, 50000, "2026-08-01");
  await evento(uid, pC, "ALTA", "2026-09-01", { instrument: fondo, units: "60", contributed: 70000 });
  check("C: la diferencia (200) entra como capital externo el día del ALTA", fmt(await externos(uid, pC)) === fmt([{ fecha: "2026-09-01", cents: 20000 }]), fmt(await externos(uid, pC)));
  const rC = await rendimiento(uid, pC, "2026-07-31", "2026-09-10");
  check(
    "C: de toda la vida, aportado 700 (500 traspasados + 200 externos); 60 × 13 = 780 → +80",
    rC.flujos === 70000 && rC.fin === 78000 && rC.ganancia === 8000 && rC.pct === "11.43",
    fmt(rC),
  );
  const rC2 = await rendimiento(uid, pC, "2026-08-31", "2026-09-10");
  check(
    "C: desde el 31-ago: inicio 500 (lo traspasado), flujo 200 externo → +80",
    rC2.inicio === 50000 && rC2.flujos === 20000 && rC2.ganancia === 8000,
    fmt(rC2),
  );
  const mC = await mercado(uid, pC);
  check("C: la ficha, igual (coste 700)", mC.coste === 70000 && mC.ganancia === 8000, fmt(mC));

  // ── D. Declaró MENOS que sus traspasos ───────────────────────────────────
  const pD = await posicion(uid, "Menos", inv, "2026-08-01");
  await aportar(uid, banco, inv, pD, 50000, "2026-08-01");
  await evento(uid, pD, "ALTA", "2026-09-01", { instrument: fondo, units: "40", contributed: 40000 });
  check("D: declarado menor → ningún flujo (no se resta nada)", (await externos(uid, pD)).length === 0);
  const rD = await rendimiento(uid, pD, "2026-07-31", "2026-09-10");
  check("D: aportado = lo traspasado (500); 40 × 13 = 520 → +20", rD.flujos === 50000 && rD.ganancia === 2000, fmt(rD));
  const mD = await mercado(uid, pD);
  check("D: la ficha usa la misma regla (coste 500, no los 400 declarados)", mD.coste === 50000 && mD.ganancia === 2000, fmt(mD));

  // ── E. Ajuste posterior: no crea flujo ───────────────────────────────────
  const antesE = await rendimiento(uid, pA, "2026-08-31", "2026-09-10");
  await evento(uid, pA, "AJUSTE", "2026-09-05", { units: "101" });
  check("E: un AJUSTE no añade capital externo", fmt(await externos(uid, pA)) === fmt([{ fecha: "2026-09-01", cents: 100000 }]));
  const rE = await rendimiento(uid, pA, "2026-08-31", "2026-09-10");
  check(
    "E: tras el AJUSTE solo cambia el valor (101 × 13 = 1.313); el aportado sigue en 1.000",
    rE.flujos === antesE.flujos && rE.flujos === 100000 && rE.fin === 131300 && rE.ganancia === 31300,
    fmt(rE),
  );

  // ── F. Baja y vuelta a seguir ────────────────────────────────────────────
  const pF = await posicion(uid, "Vuelve", inv, "2026-09-01");
  await evento(uid, pF, "ALTA", "2026-09-01", { instrument: fondo, units: "100", contributed: 100000 });
  const valorBaja = await comoUsuario(uid, () =>
    q("select public.unfollow_instrument($1, date '2026-09-04') as v", [pF]).then((r) => n(r[0].v)),
  );
  check("F: la BAJA deja la posición en su valor de mercado (1.250)", valorBaja === 125000, String(valorBaja));
  const mF = await mercado(uid, pF);
  check(
    "F: ya manual, conserva como coste el capital declarado (antes volvía a 0 y todo era ganancia)",
    !mF.seguida && mF.coste === 100000 && mF.ganancia === 25000,
    fmt(mF),
  );
  await evento(uid, pF, "ALTA", "2026-09-08", { instrument: fondo, units: "100", contributed: 100000 });
  check(
    "F: volver a seguir declarando el mismo total no lo cuenta dos veces",
    fmt(await externos(uid, pF)) === fmt([{ fecha: "2026-09-01", cents: 100000 }]),
    fmt(await externos(uid, pF)),
  );
  const rF = await rendimiento(uid, pF, "2026-08-31", "2026-09-10");
  check("F: aportado 1.000, 100 × 13 = 1.300 → +300", rF.flujos === 100000 && rF.ganancia === 30000, fmt(rF));

  const pG = await posicion(uid, "VuelveConMas", inv, "2026-09-01");
  await evento(uid, pG, "ALTA", "2026-09-01", { instrument: fondo, units: "100", contributed: 100000 });
  await comoUsuario(uid, () => q("select public.unfollow_instrument($1, date '2026-09-04')", [pG]));
  await evento(uid, pG, "ALTA", "2026-09-08", { instrument: fondo, units: "120", contributed: 130000 });
  check(
    "F: volver a seguir declarando 300 más (puestos fuera de la app) añade solo esos 300, en la fecha del nuevo ALTA",
    fmt(await externos(uid, pG)) === fmt([{ fecha: "2026-09-01", cents: 100000 }, { fecha: "2026-09-08", cents: 30000 }]),
    fmt(await externos(uid, pG)),
  );
  const rG = await rendimiento(uid, pG, "2026-09-04", "2026-09-10");
  check(
    "F: desde la baja: inicio 1.250, flujo 300, fin 120 × 13 = 1.560 → +10",
    rG.inicio === 125000 && rG.flujos === 30000 && rG.fin === 156000 && rG.ganancia === 1000,
    fmt(rG),
  );
  const mG = await mercado(uid, pG);
  check("F: la ficha, coste 1.300", mG.coste === 130000 && mG.ganancia === 26000, fmt(mG));

  // ── H. Manual que ya se valoraba y se convierte ──────────────────────────
  // Sin traspasos apuntados; valorada a 1.000 (jul) y 1.030 (ago). Al seguirla
  // declara 900 aportados. Ese capital ya estaba dentro de las valoraciones:
  // entra el día de la PRIMERA, no el del ALTA.
  const pH = await posicion(uid, "Valorada", inv, "2026-07-01");
  await valorar(uid, pH, "2026-07-31", 100000);
  await valorar(uid, pH, "2026-08-31", 103000);
  await evento(uid, pH, "ALTA", "2026-09-01", { instrument: fondo, units: "80", contributed: 90000 });
  check(
    "H: el capital externo entra en la fecha de la primera valoración (31-jul)",
    fmt(await externos(uid, pH)) === fmt([{ fecha: "2026-07-31", cents: 90000 }]),
    fmt(await externos(uid, pH)),
  );
  const rH = await rendimiento(uid, pH, "2026-08-31", "2026-09-10");
  check(
    "H: un periodo que empieza entre la primera valoración y el ALTA no lo cuenta dos veces (1.030 → 80 × 13 = 1.040: +10)",
    rH.inicio === 103000 && rH.flujos === 0 && rH.fin === 104000 && rH.ganancia === 1000 && rH.pct === "0.97",
    fmt(rH),
  );
  const rH2 = await rendimiento(uid, pH, "2026-06-30", "2026-09-10");
  check("H: de toda la vida: aportado 900, ganancia 1.040 − 900 = +140", rH2.inicio === 0 && rH2.flujos === 90000 && rH2.ganancia === 14000, fmt(rH2));
  const perfH = await comoUsuario(uid, () =>
    q("select fecha::text as fecha, cost_cents from public.position_performance(date '2026-07-01', date '2026-09-10') where position_id = $1 order by fecha", [pH]),
  );
  check(
    "H: la curva de coste vale 900 desde la primera valoración",
    perfH.length > 0 && perfH.every((r) => n(r.cost_cents) === 90000) && perfH[0].fecha === "2026-07-31",
    fmt(perfH),
  );

  // ── I. La cartera entera (portfolio_return) con manuales y sincronizadas ─
  const uid2 = await nuevoUsuario();
  const banco2 = await cuenta(uid2, "Banco", "BANCO", 1000000);
  const inv2 = await cuenta(uid2, "Bróker", "INVERSION", 0);
  const pManual = await posicion(uid2, "Manual", inv2, "2026-08-01");
  await aportar(uid2, banco2, inv2, pManual, 200000, "2026-08-01");
  await valorar(uid2, pManual, "2026-09-10", 210000);
  const pSync = await posicion(uid2, "Sincronizada", inv2, "2026-09-01");
  await evento(uid2, pSync, "ALTA", "2026-09-01", { instrument: fondo, units: "100", contributed: 100000 });
  const filas = await comoUsuario(uid2, () => q("select gain_cents, start_cents, contributions_cents from public.position_return(date '2026-07-31', current_date)"));
  const [cartera] = await comoUsuario(uid2, () => q("select start_cents, end_cents, contributions_cents, gain_cents, return_pct::text as pct from public.portfolio_return(date '2026-07-31', current_date)"));
  const sumaG = filas.reduce((s, r) => s + n(r.gain_cents), 0);
  check(
    "I: portfolio_return = manual (2.000 → 2.100) + sincronizada (1.000 declarados → 1.300): aportado 3.000, +400, +13,33 %",
    n(cartera.contributions_cents) === 300000 && n(cartera.end_cents) === 340000 && n(cartera.gain_cents) === 40000 && cartera.pct === "13.33" && sumaG === 40000,
    fmt(cartera),
  );
  const cabecera = await comoUsuario(uid2, () => q("select coalesce(sum(contributed_cents), 0) as aportado, coalesce(sum(value_cents), 0) as valor from public.v_position_market where not archived"));
  check(
    "I: la cabecera (aportado de v_position_market) cuadra con la ganancia de la cartera: 3.400 − 3.000 = +400",
    n(cabecera[0].aportado) === 300000 && n(cabecera[0].valor) - n(cabecera[0].aportado) === n(cartera.gain_cents),
    fmt(cabecera),
  );

  // ── J. El patrimonio no cambia ───────────────────────────────────────────
  // Banco 10.000 − 2.000 traspasados = 8.000; bróker: 0 de caja sin desplegar
  // y posiciones 2.100 + 1.300. El capital externo NO se resta de nada.
  const [nw] = await comoUsuario(uid2, () => q("select net_worth_cents, cash_cents, invested_cents, idle_cents from public.v_net_worth"));
  check(
    "J: v_net_worth = caja 8.000 + posiciones 3.400 (el capital externo no se resta)",
    n(nw.net_worth_cents) === 1140000 && n(nw.cash_cents) === 800000 && n(nw.invested_cents) === 340000 && n(nw.idle_cents) === 0,
    fmt(nw),
  );
  const [dia] = await comoUsuario(uid2, () => q("select net_worth_cents from public.net_worth_daily(date '2026-09-10', date '2026-09-10')"));
  check("J: net_worth_daily del día 10, igual", n(dia.net_worth_cents) === 1140000, fmt(dia));
  const [acc] = await comoUsuario(uid2, () => q("select worth_cents from public.v_account_worth where account_id = $1", [inv2]));
  check("J: v_account_worth del bróker = 3.400 (sin restar el capital externo)", n(acc.worth_cents) === 340000, fmt(acc));

  return { uid, uid2, pA };
}

// --------------------------------------------------------------------------
// 3. Aislamiento y permisos
// --------------------------------------------------------------------------
async function aislamiento(s) {
  console.log("\n— Aislamiento y permisos —\n");
  const ajenos = await comoUsuario(s.uid2, () =>
    q("select count(*) as c from private.position_external_contributions() where position_id = $1", [s.pA]),
  );
  check("otro usuario no ve el capital externo ajeno", n(ajenos[0].c) === 0);
  const ajenosR = await comoUsuario(s.uid2, () =>
    q("select count(*) as c from public.v_position_market where position_id = $1", [s.pA]),
  );
  check("ni la posición ajena en v_position_market", n(ajenosR[0].c) === 0);

  const [p] = await q(`
    select has_function_privilege('anon', 'private.position_external_contributions()', 'execute') as anon,
           has_function_privilege('public', 'private.position_external_contributions()', 'execute') as publico,
           has_function_privilege('authenticated', 'private.position_external_contributions()', 'execute') as auth`);
  check("anon y public no ejecutan la función nueva; authenticated sí", !p.anon && !p.publico && p.auth, fmt(p));
  const eAnon = await intento("anon", () => q("select count(*) from public.v_position_market"));
  check("anon no consulta v_position_market", eAnon !== null);

  const [cfg] = await q(`
    select count(*) filter (where p.prosecdef) as definer,
           count(*) filter (where not coalesce(p.proconfig, '{}') @> array['search_path=""']) as sin_path,
           count(*) as total
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where (s.nspname, p.proname) in (('private','position_external_contributions'),
           ('public','position_return'), ('public','position_performance'), ('public','portfolio_return'))`);
  check(
    "funciones tocadas: ninguna security definer, todas con search_path = ''",
    n(cfg.definer) === 0 && n(cfg.sin_path) === 0 && n(cfg.total) === 4,
    fmt(cfg),
  );
  const [vista] = await q(`
    select coalesce(c.reloptions, '{}') @> array['security_invoker=true'] as invoker
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relname = 'v_position_market'`);
  check("v_position_market sigue siendo security_invoker", vista.invoker === true);
}

// --------------------------------------------------------------------------
async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const reales = await q("select u.id::text as id from auth.users u order by u.created_at");
    const [ya] = await q("select to_regprocedure('private.position_external_contributions()') is not null as esta");

    console.log(`— Datos reales: ${reales.length} usuarios, antes y después (solo se informa si coincide) —\n`);
    const [sync] = await q("select count(*) as c from public.position_unit_event");
    // Antes de publicar se exigía que no hubiera ningún ALTA real (no había
    // capital externo que contar). Ya publicado, los usuarios dan de alta sus
    // fondos: el recuento solo se informa; sus cifras las protege la
    // comparación antes/después de abajo.
    console.log(`  (eventos de participaciones reales en la base: ${n(sync.c)})`);

    const antes = [];
    for (const u of reales) antes.push(await fotografia(u.id));
    if (ya.esta) {
      console.log("  (la migración ya está en la base: la comparación antes/después es trivial)");
    } else {
      await client.query(readFileSync(join(raiz, "supabase", "migrations", MIGRACION), "utf8"));
      console.log("  (migración aplicada dentro de la transacción)");
    }
    for (const [i, u] of reales.entries()) {
      const despues = await fotografia(u.id);
      const distintas = Object.keys(antes[i]).filter((k) => fmt(antes[i][k]) !== fmt(despues[k]));
      const patrimonio = distintas.filter((k) => PATRIMONIO.includes(k));
      const filas = Object.values(despues).reduce((s, v) => s + v.length, 0);
      check(`real ${i + 1}: patrimonio, saldos y metas idénticos`, patrimonio.length === 0, `distintas: ${patrimonio.join(", ")}`);
      check(
        `real ${i + 1}: rendimiento, coste y fichas idénticos (${Object.keys(despues).length} consultas, ${filas} filas)`,
        distintas.length === 0,
        `distintas: ${distintas.join(", ")}`,
      );
    }

    const s = await casos();
    await aislamiento(s);
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
