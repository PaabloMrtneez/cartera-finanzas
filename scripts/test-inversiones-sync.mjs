/**
 * Prueba de las inversiones que se actualizan solas:
 *   20261007110000_instrumentos_y_participaciones.sql
 *   20261007110100_valor_de_mercado_de_las_posiciones.sql
 *
 *   node --env-file=.env.local scripts/test-inversiones-sync.mjs
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): las
 * migraciones se aplican ahí dentro (si aún no lo están), los usuarios de
 * prueba se insertan en auth.users ahí dentro, y no persiste nada. Así se
 * prueba contra la base real sin aplicar nada a producción.
 *
 * Cuatro bloques:
 *
 *   1. DATOS REALES, ANTES Y DESPUÉS. Para cada usuario real se fotografían,
 *      con las definiciones vigentes, todas las cifras que dependen del valor de
 *      una posición (patrimonio diario, mensual e histórico, v_net_worth,
 *      v_account_worth, v_position_value, position_return, portfolio_return,
 *      position_performance, metas, saldo por cuenta, valoraciones pendientes);
 *      se aplican las migraciones y se vuelve a fotografiar. Ninguna posición
 *      real sigue un instrumento, así que TODO tiene que salir idéntico. No se
 *      imprime ninguna cifra de nadie: solo si coincide.
 *   2. CURVA DIARIA. Un usuario sembrado con un fondo en euros y precios
 *      distintos cada día: el patrimonio de cada día, calculado a mano.
 *   3. CASOS. Redondeo al céntimo (empate hacia arriba), divisa USD con cambio
 *      del BCE, posición sin precio, respaldo manual que manda y deja de mandar,
 *      aportación con participaciones y sin ellas (estimación neutra), ajuste
 *      de participaciones, dejar de seguir, desactualizado, qué hay que
 *      refrescar.
 *   4. AISLAMIENTO Y PERMISOS. Un usuario no ve ni toca el libro de otro; el
 *      catálogo y los precios los ve cualquier autenticado con 2FA y no los
 *      escribe ninguno; anon no tiene acceso; vistas security_invoker,
 *      funciones con search_path vacío y ninguna security definer.
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
const MIGRACIONES = [
  "20261007110000_instrumentos_y_participaciones.sql",
  "20261007110100_valor_de_mercado_de_las_posiciones.sql",
];

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
 * Ejecuta `trabajo` con el rol `rol` dentro de un savepoint y devuelve el error
 * de Postgres (o null). Pase lo que pase, deshace hasta el savepoint.
 */
async function intento(rol, uid, trabajo, aal = "aal2") {
  await q("savepoint intento");
  let error = null;
  try {
    if (uid) {
      await q("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: uid, role: rol, aal }),
      ]);
    }
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
// 1. Fotografía de todo lo que depende del valor de una posición
// --------------------------------------------------------------------------
const COLUMNAS_POSICION =
  "user_id, position_id, name, color, account_id, since::text, archived, contributed_cents, valued_on::text, value_cents, sin_valorar";

async function fotografia(uid) {
  return comoUsuario(uid, async () => {
    const f = {};
    f.net_worth_history = await q("select period_month::text, net_worth_cents from public.net_worth_history(24)");
    f.net_worth_monthly = await q("select period_month::text, net_worth_cents, cash_cents, invested_cents, idle_cents from public.net_worth_monthly(24)");
    f.net_worth_daily = await q("select fecha::text, net_worth_cents, cash_cents, invested_cents, idle_cents from public.net_worth_daily(current_date - 400, current_date)");
    f.v_net_worth = await q("select * from public.v_net_worth");
    f.v_account_worth = await q("select * from public.v_account_worth order by account_id");
    f.v_position_value = await q(`select ${COLUMNAS_POSICION} from public.v_position_value order by position_id`);
    f.account_balance_monthly = await q("select account_id, period_month::text, balance_cents, worth_cents from public.account_balance_monthly(24)");
    f.savings_goal_projection = await q("select * from public.savings_goal_projection(6)");
    f.v_savings_goal_progress = await q("select * from public.v_savings_goal_progress order by 1, 2");
    f.v_pending_valuation = await q("select position_id, last_valued_on::text from public.v_pending_valuation order by position_id");
    f.position_performance = await q("select position_id, fecha::text, value_cents, cost_cents, return_pct from public.position_performance(date '2025-01-01', current_date)");
    for (const [desde, hasta] of [
      ["date '2026-01-01'", "current_date"],
      ["date_trunc('month', current_date)::date", "current_date"],
      ["date '2026-05-31'", "date '2026-08-31'"],
      ["current_date - 7", "current_date"],
      ["date '2026-02-07'", "date '2026-02-07'"],
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

const posicion = async (uid, nombre, cuentaId, desde = "2026-08-01") =>
  (
    await q(
      "insert into public.investment_position (user_id,name,account_id,since) values ($1,$2,$3,$4) returning id::text as id",
      [uid, nombre, cuentaId, desde],
    )
  )[0].id;

const sufijo = Math.random().toString(36).slice(2, 7).toUpperCase();
/** Instrumento del catálogo, como lo insertaría el servidor (service_role). */
const instrumento = async (nombre, tipo, divisa) =>
  (
    await q(
      "insert into public.instrument (kind, yahoo_symbol, name, currency) values ($1,$2,$3,$4) returning id::text as id",
      [tipo, `ZZ${nombre}${sufijo}.T`, `Prueba ${nombre}`, divisa],
    )
  )[0].id;

const precio = (instId, fecha, cierre) =>
  q(
    "insert into public.instrument_price (instrument_id, date, close) values ($1,$2,$3) on conflict (instrument_id, date) do update set close = excluded.close",
    [instId, fecha, cierre],
  );

const cambio = (divisa, fecha, tasa) =>
  q("insert into public.fx_rate (currency, date, rate) values ($1,$2,$3) on conflict do nothing", [divisa, fecha, tasa]);

const evento = (uid, posId, kind, fecha, extra = {}) =>
  q(
    "insert into public.position_unit_event (user_id, position_id, kind, date, instrument_id, units, contributed_cents) values ($1,$2,$3,$4,$5,$6,$7)",
    [uid, posId, kind, fecha, extra.instrument ?? null, extra.units ?? null, extra.contributed ?? null],
  );

const aportar = (uid, desde, hacia, posId, cents, fecha, units = null) =>
  q(
    "insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,to_account_id,position_id,position_units) values ($1,'TRANSFER',$2,$3,$4,$5,$6,$7) returning id::text as id",
    [uid, cents, fecha, desde, hacia, posId, units],
  );

/** Valor de una posición en una fecha, con la sesión del dueño. */
const valorEn = (uid, posId, fecha) =>
  comoUsuario(uid, async () => {
    const [r] = await q(
      `select value_cents, fuente, valued_on::text as valued_on, units::text as units, units_estimadas,
              price::text as price, price_date::text as price_date, sin_valorar
         from private.position_value_on(array[$2::date]) where position_id = $1`,
      [posId, fecha],
    );
    return r ? { ...r, value_cents: n(r.value_cents) } : null;
  });

// --------------------------------------------------------------------------
// 2. Curva diaria
// --------------------------------------------------------------------------
async function curvaDiaria() {
  console.log("\n— Curva diaria (usuario sembrado, fondo en euros) —\n");
  const uid = await nuevoUsuario();
  const banco = await cuenta(uid, "Banco", "BANCO", 500000);
  const inv = await cuenta(uid, "Bróker", "INVERSION", 0);
  const pos = await posicion(uid, "Indexado", inv);
  const fondo = await instrumento("CURVA", "FONDO", "EUR");

  await aportar(uid, banco, inv, pos, 100000, "2026-09-01");
  await evento(uid, pos, "ALTA", "2026-09-01", { instrument: fondo, units: "100", contributed: 100000 });
  for (const [d, p] of [
    ["2026-09-01", "10"],
    ["2026-09-02", "10.5"],
    ["2026-09-03", "9.75"],
    ["2026-09-07", "10.1"],
  ]) {
    await precio(fondo, d, p);
  }

  const dias = await comoUsuario(uid, () =>
    q(
      "select fecha::text as fecha, net_worth_cents, cash_cents, invested_cents, idle_cents from public.net_worth_daily(date '2026-08-31', date '2026-09-08')",
    ),
  );
  const esperado = {
    "2026-08-31": [500000, 500000, 0, 0], // antes de todo: solo el banco
    "2026-09-01": [500000, 400000, 100000, 0], // 100 × 10,00
    "2026-09-02": [505000, 400000, 105000, 0], // 100 × 10,50
    "2026-09-03": [497500, 400000, 97500, 0], // 100 × 9,75
    "2026-09-04": [497500, 400000, 97500, 0], // sin precio nuevo: se arrastra
    "2026-09-05": [497500, 400000, 97500, 0],
    "2026-09-06": [497500, 400000, 97500, 0],
    "2026-09-07": [501000, 400000, 101000, 0], // 100 × 10,10
    "2026-09-08": [501000, 400000, 101000, 0],
  };
  const fallos = [];
  for (const d of dias) {
    const e = esperado[d.fecha];
    const real = [n(d.net_worth_cents), n(d.cash_cents), n(d.invested_cents), n(d.idle_cents)];
    if (!e || e.join() !== real.join()) fallos.push(`${d.fecha}: ${real.join("/")} (esperado ${e?.join("/")})`);
  }
  check(
    "net_worth_daily día a día = banco + participaciones × precio de cada día",
    dias.length === 9 && fallos.length === 0,
    fallos.join("; "),
  );

  const mensual = await comoUsuario(uid, () =>
    q("select period_month::text as m, net_worth_cents, invested_cents from public.net_worth_monthly(600) where period_month = date '2026-09-01'"),
  );
  check(
    "el cierre de septiembre de net_worth_monthly usa el último precio del mes (10,10)",
    mensual.length === 1 && n(mensual[0].invested_cents) === 101000 && n(mensual[0].net_worth_cents) === 501000,
    JSON.stringify(mensual),
  );
  const [cuentaSep] = await comoUsuario(uid, () =>
    q("select worth_cents from public.account_balance_monthly(600) where account_id = $1 and period_month = date '2026-09-01'", [inv]),
  );
  check("account_balance_monthly: el bróker vale su posición a precio de mercado", n(cuentaSep?.worth_cents) === 101000);

  const perf = await comoUsuario(uid, () =>
    q("select fecha::text as fecha, value_cents, cost_cents, return_pct::text as pct from public.position_performance(date '2026-09-01', date '2026-09-07')"),
  );
  check(
    "position_performance dibuja un punto por cada precio (4) con su valor de mercado",
    perf.map((r) => `${r.fecha}:${r.value_cents}`).join() ===
      "2026-09-01:100000,2026-09-02:105000,2026-09-03:97500,2026-09-07:101000" &&
      perf.every((r) => n(r.cost_cents) === 100000),
    JSON.stringify(perf),
  );
  const [ret] = await comoUsuario(uid, () =>
    q("select start_cents, end_cents, contributions_cents, gain_cents, return_pct::text as pct from public.position_return(date '2026-09-01', date '2026-09-07')"),
  );
  check(
    "position_return del 1 al 7: de 1.000 a 1.010 sin aportaciones = +1,00 %",
    n(ret.start_cents) === 100000 && n(ret.end_cents) === 101000 && n(ret.gain_cents) === 1000 && ret.pct === "1.00",
    JSON.stringify(ret),
  );

  // Dejar de seguir el día 7: BAJA + valoración manual con el valor de mercado.
  const valorBaja = await comoUsuario(uid, () =>
    q("select public.unfollow_instrument($1, date '2026-09-07') as v", [pos]).then((r) => n(r[0].v)),
  );
  check("unfollow_instrument devuelve el valor con el que queda (1.010,00)", valorBaja === 101000, String(valorBaja));
  await precio(fondo, "2026-09-08", "20"); // un precio posterior ya no le afecta
  const tras = await comoUsuario(uid, () =>
    q("select fecha::text as fecha, net_worth_cents from public.net_worth_daily(date '2026-09-03', date '2026-09-08')"),
  );
  check(
    "tras dejar de seguir: el pasado sincronizado se conserva y desde la baja manda la valoración (sin salto)",
    tras.map((r) => n(r.net_worth_cents)).join() === "497500,497500,497500,497500,501000,501000",
    JSON.stringify(tras),
  );
  const [vpv] = await comoUsuario(uid, () =>
    q("select value_cents, fuente, instrument_id from public.v_position_value where position_id = $1", [pos]),
  );
  check(
    "v_position_value: vuelve a manual (fuente MANUAL, sin instrumento) con el valor de la baja",
    n(vpv.value_cents) === 101000 && vpv.fuente === "MANUAL" && vpv.instrument_id === null,
    JSON.stringify(vpv),
  );
  const libro = await q("select kind::text from public.position_unit_event where position_id = $1 order by seq", [pos]);
  check("el libro conserva el ALTA y añade la BAJA", libro.map((r) => r.kind).join() === "ALTA,BAJA");

  // Volver a seguir: un ALTA nuevo abre otro periodo.
  await evento(uid, pos, "ALTA", "2026-09-08", { instrument: fondo, units: "100", contributed: 100000 });
  const re = await valorEn(uid, pos, "2026-09-08");
  check("volver a seguir (ALTA nuevo) recupera el valor de mercado: 100 × 20,00", re.value_cents === 200000 && re.fuente === "MERCADO", JSON.stringify(re));
  return uid;
}

// --------------------------------------------------------------------------
// 3. Casos
// --------------------------------------------------------------------------
async function casos(hoy) {
  console.log("\n— Casos —\n");
  const uid = await nuevoUsuario();
  const banco = await cuenta(uid, "Banco", "BANCO", 10000000);
  const inv = await cuenta(uid, "Bróker", "INVERSION", 0);

  // ── Redondeo ──────────────────────────────────────────────────────────────
  const fRed = await instrumento("RED", "FONDO", "EUR");
  const pRed = await posicion(uid, "Redondeo", inv);
  await evento(uid, pRed, "ALTA", "2026-09-01", { instrument: fRed, units: "0.5", contributed: 60 });
  await precio(fRed, "2026-09-01", "1.25"); // 0,5 × 1,25 € = 62,5 céntimos
  await precio(fRed, "2026-09-02", "1.249999"); // 62,49995 céntimos
  await precio(fRed, "2026-09-03", "1.230001"); // 61,50005 céntimos
  check("empate exacto de medio céntimo: 0,5 × 1,25 € = 62,5 → 63 (hacia arriba)", (await valorEn(uid, pRed, "2026-09-01")).value_cents === 63);
  check("62,49995 céntimos → 62", (await valorEn(uid, pRed, "2026-09-02")).value_cents === 62);
  check("61,50005 céntimos → 62", (await valorEn(uid, pRed, "2026-09-03")).value_cents === 62);

  // ── Fondo en euros con aportaciones, respaldo y ajuste ────────────────────
  const fondo = await instrumento("FONDO", "FONDO", "EUR");
  const p1 = await posicion(uid, "Fondo", inv);
  await aportar(uid, banco, inv, p1, 100000, "2026-09-01"); // mismo día que el ALTA: incluida
  await evento(uid, p1, "ALTA", "2026-09-01", { instrument: fondo, units: "100", contributed: 100000 });
  for (const [d, p] of [
    ["2026-09-01", "10"],
    ["2026-09-02", "10.123457"],
    ["2026-09-03", "10.5"],
    ["2026-09-04", "11"],
    ["2026-09-08", "12.345678"],
  ]) {
    await precio(fondo, d, p);
  }

  let v = await valorEn(uid, p1, "2026-09-02");
  check(
    "valor = round(participaciones × precio): 100 × 10,123457 € = 101.234,57 c → 101.235",
    v.value_cents === 101235 && v.fuente === "MERCADO" && v.price_date === "2026-09-02",
    JSON.stringify(v),
  );

  // Aportación CON participaciones (210 € = 20 participaciones a 10,50).
  await aportar(uid, banco, inv, p1, 21000, "2026-09-03", "20");
  v = await valorEn(uid, p1, "2026-09-03");
  check(
    "aportación con participaciones: 120 × 10,50 = 1.260,00 €, no estimada",
    v.value_cents === 126000 && v.units === "120.00000000" && v.units_estimadas === false,
    JSON.stringify(v),
  );

  // Aportación SIN participaciones (110 € a 11,00 → 10 estimadas).
  await aportar(uid, banco, inv, p1, 11000, "2026-09-04");
  v = await valorEn(uid, p1, "2026-09-04");
  check(
    "aportación sin participaciones: se estiman con el precio de su fecha (110 € / 11,00 = 10) y se marca",
    v.value_cents === 143000 && v.units === "130.00000000" && v.units_estimadas === true,
    JSON.stringify(v),
  );

  // Estimación con un precio que no da cuenta redonda, y neutralidad.
  const [antes] = await comoUsuario(uid, () =>
    q("select value_cents from private.position_value_on(array[date '2026-09-08']) where position_id = $1", [p1]),
  );
  await aportar(uid, banco, inv, p1, 10000, "2026-09-08");
  const [{ est }] = await q("select round(10000::numeric / (100 * 12.345678), 8)::text as est");
  v = await valorEn(uid, p1, "2026-09-08");
  const [{ esperado, u }] = await q(
    "select round((130 + $1::numeric) * 12.345678 * 100)::bigint as esperado, (130 + $1::numeric)::text as u",
    [est],
  );
  check(
    `estimación con decimales: 100 € / 12,345678 = ${est} participaciones (130 + ${est} = ${u})`,
    est === "8.10000066" && v.units === u && v.units_estimadas === true,
    JSON.stringify(v),
  );
  check(
    "la aportación estimada entra NEUTRA: el valor sube lo aportado (±1 céntimo de redondeo)",
    v.value_cents === n(esperado) && Math.abs(v.value_cents - n(antes.value_cents) - 10000) <= 1,
    `antes ${antes.value_cents} · después ${v.value_cents} · esperado ${esperado}`,
  );

  // Una aportación DESCARTADA no suma participaciones.
  const [desc] = await aportar(uid, banco, inv, p1, 50000, "2026-09-08", "40");
  await q("update public.transaction set status = 'DISCARDED' where id = $1", [desc.id]);
  check("una aportación descartada no suma participaciones", (await valorEn(uid, p1, "2026-09-08")).value_cents === v.value_cents);

  // Respaldo: valoración manual del 9, posterior al último precio (día 8).
  await q("insert into public.valuation (user_id, position_id, date, value_cents) values ($1,$2,'2026-09-09',170000)", [uid, p1]);
  v = await valorEn(uid, p1, "2026-09-08");
  check("el día 8 la valoración del 9 aún no existe: manda el mercado", v.fuente === "MERCADO");
  v = await valorEn(uid, p1, "2026-09-09");
  check(
    "respaldo: la valoración manual del 9, posterior al último precio (8), manda",
    v.value_cents === 170000 && v.fuente === "RESPALDO" && v.valued_on === "2026-09-09",
    JSON.stringify(v),
  );
  await aportar(uid, banco, inv, p1, 5000, "2026-09-10");
  v = await valorEn(uid, p1, "2026-09-10");
  check("y suma lo aportado después de ella, al coste", v.value_cents === 175000 && v.fuente === "RESPALDO", JSON.stringify(v));
  await precio(fondo, "2026-09-09", "13");
  v = await valorEn(uid, p1, "2026-09-09");
  check(
    "al llegar un precio de esa misma fecha, el respaldo deja de mandar",
    v.fuente === "MERCADO" && v.price_date === "2026-09-09",
    JSON.stringify(v),
  );

  // Ajuste: MyInvestor dice 140,5 participaciones el día 10.
  await comoUsuario(uid, () => evento(uid, p1, "AJUSTE", "2026-09-10", { units: "140.5" }));
  v = await valorEn(uid, p1, "2026-09-10");
  check(
    "ajuste: 140,5 participaciones × 13,00 = 1.826,50 € (la aportación del mismo día va incluida)",
    v.value_cents === 182650 && v.units === "140.50000000" && v.units_estimadas === false,
    JSON.stringify(v),
  );
  await aportar(uid, banco, inv, p1, 2600, "2026-09-11", "2");
  await precio(fondo, "2026-09-11", "13");
  v = await valorEn(uid, p1, "2026-09-11");
  check("después del ajuste suman las aportaciones posteriores: 142,5 × 13 = 1.852,50 €", v.value_cents === 185250, JSON.stringify(v));
  v = await valorEn(uid, p1, "2026-09-08");
  check("el ajuste no reescribe el pasado: el día 8 sigue igual", v.value_cents === n(esperado), JSON.stringify(v));

  // ── Acción en dólares ─────────────────────────────────────────────────────
  const accion = await instrumento("USD", "ACCION", "USD");
  const p2 = await posicion(uid, "Acción", inv);
  await evento(uid, p2, "ALTA", "2026-09-01", { instrument: accion, units: "10", contributed: 90909 });
  await precio(accion, "2026-09-01", "100");
  await precio(accion, "2026-09-02", "101.5");
  await cambio("USD", "2026-09-01", "1.1");
  await cambio("USD", "2026-09-02", "1.12");
  v = await valorEn(uid, p2, "2026-09-01");
  check("USD: 10 × 100 $ / 1,10 = 909,0909 € → 909,09 €", v.value_cents === 90909, JSON.stringify(v));
  v = await valorEn(uid, p2, "2026-09-02");
  check("USD: 10 × 101,50 $ / 1,12 = 906,25 € exactos", v.value_cents === 90625, JSON.stringify(v));
  v = await valorEn(uid, p2, "2026-09-03");
  check("USD: sin precio ni cambio nuevos se arrastran los del día 2", v.value_cents === 90625 && v.price_date === "2026-09-02");
  await precio(accion, "2026-09-04", "102");
  v = await valorEn(uid, p2, "2026-09-04");
  check("USD: precio nuevo con el último cambio anterior (1,12): 10 × 102 / 1,12 = 910,71 €", v.value_cents === 91071, JSON.stringify(v));

  // ── Sin precio todavía ────────────────────────────────────────────────────
  const sinDatos = await instrumento("NADA", "ETF", "EUR");
  const p3 = await posicion(uid, "Sin precio", inv);
  await aportar(uid, banco, inv, p3, 50000, "2026-09-01");
  await evento(uid, p3, "ALTA", "2026-09-01", { instrument: sinDatos, units: "5", contributed: 50000 });
  v = await valorEn(uid, p3, "2026-09-05");
  check("sin precio todavía: vale lo aportado, como una manual (fuente MANUAL)", v.value_cents === 50000 && v.fuente === "MANUAL", JSON.stringify(v));

  // Divisa sin tipo de cambio: tampoco se valora a mercado.
  const enYenes = await instrumento("JPY", "ACCION", "JPY");
  const p4 = await posicion(uid, "Yenes", inv);
  await aportar(uid, banco, inv, p4, 30000, "2026-09-01");
  await evento(uid, p4, "ALTA", "2026-09-01", { instrument: enYenes, units: "1", contributed: 30000 });
  await precio(enYenes, "2026-09-01", "5000");
  v = await valorEn(uid, p4, "2026-09-02");
  check("precio en JPY sin tipo de cambio del BCE: no se inventa, vale lo aportado", v.value_cents === 30000 && v.fuente === "MANUAL", JSON.stringify(v));

  // ── v_position_market ─────────────────────────────────────────────────────
  const mercado = await comoUsuario(uid, () =>
    q(`select position_id::text as id, seguida, yahoo_symbol, units::text as units, units_estimadas,
              price::text as price, price_date::text as price_date, value_cents, fuente, sin_precio,
              contributed_cents, gain_cents, return_pct::text as return_pct, dias_sin_precio, desactualizado
         from public.v_position_market`),
  );
  const m = Object.fromEntries(mercado.map((r) => [r.id, r]));
  // Días hábiles entre el último precio y hoy, calculados aquí.
  const habiles = (desde) => {
    let d = new Date(`${desde}T12:00:00Z`);
    const fin = new Date(`${hoy}T12:00:00Z`);
    let c = 0;
    for (;;) {
      d = new Date(d.getTime() + 86400000);
      if (d > fin) break;
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) c++;
    }
    return c;
  };
  const r1 = m[p1];
  check(
    "v_position_market: participaciones, último precio con SU fecha y valor de mercado",
    r1.seguida && r1.units === "142.50000000" && r1.price === "13.000000" && r1.price_date === "2026-09-11" &&
      n(r1.value_cents) === 185250 && r1.fuente === "MERCADO" && r1.sin_precio === false,
    JSON.stringify(r1),
  );
  check(
    "v_position_market: coste = aportado del ALTA + aportado después (1.000 + 210 + 110 + 100 + 50 + 26), ganancia = valor − coste",
    n(r1.contributed_cents) === 100000 + 21000 + 11000 + 10000 + 5000 + 2600 &&
      n(r1.gain_cents) === 185250 - (100000 + 21000 + 11000 + 10000 + 5000 + 2600),
    JSON.stringify(r1),
  );
  // 1.852,50 − 1.496,00 = 356,50 → 356,50 / 1.496,00 = 23,830… %
  check("v_position_market: el % se deriva de ganancia y coste (23,83 %)", r1.return_pct === "23.83", r1.return_pct);
  check(
    `v_position_market: días hábiles sin precio = ${habiles("2026-09-11")} y desactualizado si pasan de 3`,
    r1.dias_sin_precio === habiles("2026-09-11") && r1.desactualizado === habiles("2026-09-11") > 3,
    JSON.stringify(r1),
  );
  check("v_position_market: la posición sin precio sale como sin_precio", m[p3].sin_precio === true && m[p3].seguida === true);
  check("v_position_market: la de yenes sin cambio también", m[p4].sin_precio === true);

  // v_position_value = v_position_market, y v_net_worth los suma.
  const vpv = await comoUsuario(uid, () => q("select position_id::text as id, value_cents, fuente from public.v_position_value"));
  check(
    "v_position_value enseña el mismo valor que v_position_market",
    vpv.every((r) => n(r.value_cents) === n(m[r.id].value_cents) && r.fuente === m[r.id].fuente),
  );
  const [nw] = await comoUsuario(uid, () => q("select invested_cents from public.v_net_worth"));
  check(
    "v_net_worth.invested = suma del valor de las posiciones",
    n(nw.invested_cents) === vpv.reduce((s, r) => s + n(r.value_cents), 0),
  );
  const [hoyDiario] = await comoUsuario(uid, () => q("select invested_cents, net_worth_cents from public.net_worth_daily(current_date, current_date)"));
  const [nwHoy] = await comoUsuario(uid, () => q("select net_worth_cents from public.v_net_worth"));
  check(
    "net_worth_daily de hoy = v_net_worth (el mismo cálculo)",
    n(hoyDiario.net_worth_cents) === n(nwHoy.net_worth_cents),
    `${hoyDiario.net_worth_cents} vs ${nwHoy.net_worth_cents}`,
  );

  // Una posición sincronizada no pide valoración mensual.
  const pend = await comoUsuario(uid, () => q("select position_id::text as id from public.v_pending_valuation"));
  check("v_pending_valuation no pide valorar las que siguen un instrumento", !pend.some((r) => [p1, p2, p3, p4, pRed].includes(r.id)));

  // ── Qué hay que refrescar (como service_role) ─────────────────────────────
  await q("update public.investment_position set archived = true where id = $1", [p4]);
  await q("set local role service_role");
  const refrescar = await q("select yahoo_symbol, currency, last_price_date::text as ultimo, desde::text as desde from public.instruments_to_refresh()");
  await q("reset role");
  const simbolos = refrescar.map((r) => r.yahoo_symbol);
  check(
    "instruments_to_refresh: los seguidos por posiciones activas, no los de una archivada",
    simbolos.includes(`ZZFONDO${sufijo}.T`) && simbolos.includes(`ZZUSD${sufijo}.T`) && !simbolos.includes(`ZZJPY${sufijo}.T`),
    simbolos.join(", "),
  );
  const fila = refrescar.find((r) => r.yahoo_symbol === `ZZUSD${sufijo}.T`);
  check("con su último precio y desde cuándo rellenar", fila?.ultimo === "2026-09-04" && fila?.desde === "2026-09-01", JSON.stringify(fila));

  // ── Ajuste o baja sin seguimiento ─────────────────────────────────────────
  const pManual = await posicion(uid, "Manual", inv);
  const e1 = await intento("authenticated", uid, () => evento(uid, pManual, "AJUSTE", "2026-09-05", { units: "3" }));
  check("un AJUSTE en una posición que no sigue nada se rechaza (23514)", e1?.code === "23514", e1?.message);
  const e2 = await intento("authenticated", uid, () => q("select public.unfollow_instrument($1, date '2026-09-05')", [pManual]));
  check("dejar de seguir una posición que no sigue nada se rechaza", e2?.code === "23514", e2?.message);
  const e3 = await intento("authenticated", uid, () => evento(uid, p1, "AJUSTE", "2026-08-15", { units: "3" }));
  check("un AJUSTE con fecha anterior al ALTA se rechaza", e3?.code === "23514", e3?.message);
  const e4 = await intento("authenticated", uid, () => evento(uid, p1, "ALTA", "2026-09-05", { units: "3", contributed: 0 }));
  check("un ALTA sin instrumento se rechaza (CHECK)", e4?.code === "23514", e4?.message);
  const e5 = await intento("authenticated", uid, () =>
    q("insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,to_account_id,position_units) values ($1,'TRANSFER',100,'2026-09-05',$2,$3,1)", [uid, banco, inv]),
  );
  check("participaciones en un movimiento sin posición se rechazan (CHECK)", e5?.code === "23514", e5?.message);

  return { uid, p1, banco, inv, fondo };
}

// --------------------------------------------------------------------------
// 4. Aislamiento y permisos
// --------------------------------------------------------------------------
async function aislamiento(s) {
  console.log("\n— Aislamiento y permisos —\n");
  const otro = await nuevoUsuario();
  const suInv = await cuenta(otro, "Su bróker", "INVERSION");
  const suPos = await posicion(otro, "Suya", suInv);

  const visto = await comoUsuario(otro, () =>
    q("select count(*) as c from public.position_unit_event where position_id = $1", [s.p1]),
  );
  check("otro usuario no ve el libro de participaciones ajeno", n(visto[0].c) === 0);
  const suMercado = await comoUsuario(otro, () => q("select count(*) as c from public.v_position_market where position_id = $1", [s.p1]));
  check("ni la posición ajena en v_position_market", n(suMercado[0].c) === 0);
  const suValor = await comoUsuario(otro, () => q("select count(*) as c from private.position_value_on(array[current_date]) where position_id = $1", [s.p1]));
  check("ni en private.position_value_on", n(suValor[0].c) === 0);

  const e1 = await intento("authenticated", otro, () => evento(otro, s.p1, "ALTA", "2026-09-05", { instrument: s.fondo, units: "1", contributed: 0 }));
  check("con su user_id no puede anotar en una posición ajena (FK compuesta, 23503)", e1?.code === "23503", e1?.message);
  const e2 = await intento("authenticated", otro, () => evento(s.uid, s.p1, "ALTA", "2026-09-05", { instrument: s.fondo, units: "1", contributed: 0 }));
  check("con el user_id ajeno, la RLS lo rechaza (42501)", e2?.code === "42501", e2?.message);
  const e3 = await intento("authenticated", otro, () => q("select public.unfollow_instrument($1, date '2026-09-20')", [s.p1]));
  check("no puede dejar de seguir una posición ajena («no encontrada»)", e3?.code === "P0002", e3?.message);

  const e4 = await intento("authenticated", s.uid, () => q("update public.position_unit_event set units = 1 where position_id = $1", [s.p1]));
  check("el dueño no puede EDITAR su libro (solo crece)", e4?.code === "42501", e4?.message);
  const e5 = await intento("authenticated", s.uid, () => q("delete from public.position_unit_event where position_id = $1", [s.p1]));
  check("ni BORRARLO", e5?.code === "42501", e5?.message);

  // Catálogo y precios: lectura sí, escritura no.
  const lee = await comoUsuario(otro, () =>
    q("select (select count(*) from public.instrument where id = $1) as i, (select count(*) from public.instrument_price where instrument_id = $1) as p", [s.fondo]),
  );
  check("cualquier autenticado con 2FA ve el catálogo y los precios", n(lee[0].i) === 1 && n(lee[0].p) > 0);
  // Con el 2FA opcional (20261019090000) solo se exige aal2 a quien tiene un
  // factor verificado: se le da uno (con la regla anterior da igual).
  await q(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (gen_random_uuid(), $1, 'prueba', 'totp', 'verified', now(), now())`,
    [otro],
  );
  const sinAal2 = await comoUsuario(otro, () => q("select count(*) as c from public.instrument"), "aal1");
  check("sin el segundo factor (aal1) no ve el catálogo", n(sinAal2[0].c) === 0);
  for (const [nombre, sql] of [
    ["insertar un instrumento", "insert into public.instrument (kind, yahoo_symbol, name, currency) values ('ACCION', 'ZZMALO.T', 'Malo', 'EUR')"],
    ["insertar un precio", `insert into public.instrument_price (instrument_id, date, close) values ('${s.fondo}', '2026-09-20', 1)`],
    ["cambiar un precio", `update public.instrument_price set close = 1 where instrument_id = '${s.fondo}'`],
    ["borrar un precio", `delete from public.instrument_price where instrument_id = '${s.fondo}'`],
    ["insertar un tipo de cambio", "insert into public.fx_rate (currency, date, rate) values ('GBP', '2026-09-20', 1)"],
    ["cambiar el catálogo", `update public.instrument set name = 'x' where id = '${s.fondo}'`],
  ]) {
    const e = await intento("authenticated", otro, () => q(sql));
    check(`un autenticado no puede ${nombre} (42501)`, e?.code === "42501", e?.message);
  }
  const eSr = await intento("service_role", null, () =>
    q(`insert into public.instrument_price (instrument_id, date, close) values ('${s.fondo}', '2026-09-21', 14.5) on conflict (instrument_id, date) do update set close = excluded.close`),
  );
  check("service_role sí escribe precios (upsert)", eSr === null, eSr?.message);
  const eRef = await intento("authenticated", otro, () => q("select * from public.instruments_to_refresh()"));
  check("instruments_to_refresh no es para authenticated", eRef?.code === "42501", eRef?.message);

  // anon
  const priv = await q(`
    select has_table_privilege('anon', 'public.instrument', 'select') as a1,
           has_table_privilege('anon', 'public.instrument_price', 'select') as a2,
           has_table_privilege('anon', 'public.fx_rate', 'select') as a3,
           has_table_privilege('anon', 'public.position_unit_event', 'select') as a4,
           has_table_privilege('anon', 'public.v_position_market', 'select') as a5,
           has_function_privilege('anon', 'private.position_value_on(date[])', 'execute') as f1,
           has_function_privilege('anon', 'public.unfollow_instrument(uuid, date)', 'execute') as f2,
           has_function_privilege('anon', 'public.instruments_to_refresh()', 'execute') as f3,
           has_function_privilege('public', 'public.unfollow_instrument(uuid, date)', 'execute') as f4,
           has_function_privilege('authenticated', 'public.unfollow_instrument(uuid, date)', 'execute') as f5,
           has_function_privilege('authenticated', 'private.position_value_on(date[])', 'execute') as f6`);
  const p = priv[0];
  check(
    "anon no lee catálogo, precios, cambios ni libro, ni ejecuta las funciones nuevas",
    !p.a1 && !p.a2 && !p.a3 && !p.a4 && !p.f1 && !p.f2 && !p.f3 && !p.f4,
    JSON.stringify(p),
  );
  const eAnon = await intento("anon", null, () => q("select count(*) from public.v_position_market"));
  check("anon no puede consultar v_position_market", eAnon !== null, eAnon?.message);
  check("authenticated sí ejecuta unfollow_instrument y position_value_on", p.f5 && p.f6);

  const vistas = await q(`
    select c.relname, coalesce(c.reloptions, '{}') @> array['security_invoker=true'] as invoker
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relname in ('v_position_value', 'v_position_market', 'v_pending_valuation')`);
  check("las vistas tocadas son security_invoker", vistas.length === 3 && vistas.every((r) => r.invoker), JSON.stringify(vistas));
  const [cfg] = await q(`
    select count(*) filter (where p.prosecdef) as definer,
           count(*) filter (where not coalesce(p.proconfig, '{}') @> array['search_path=""']) as sin_path,
           count(*) as total
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where (s.nspname, p.proname) in (('private','position_value_on'), ('private','account_worth_on'),
           ('private','tg_unit_event_coherente'), ('public','unfollow_instrument'), ('public','instruments_to_refresh'),
           ('public','position_return'), ('public','position_performance'))`);
  check(
    "funciones nuevas y redefinidas: ninguna security definer, todas con search_path = ''",
    n(cfg.definer) === 0 && n(cfg.sin_path) === 0 && n(cfg.total) === 7,
    JSON.stringify(cfg),
  );

  // Borrar la cuenta con delete_account se lleva el libro en cascada.
  const nombre = (await q("select name from public.account where id = $1", [suInv]))[0].name;
  await comoUsuario(otro, () => evento(otro, suPos, "ALTA", "2026-09-05", { instrument: s.fondo, units: "1", contributed: 0 }));
  const eBorrar = await intento("authenticated", otro, async () => {
    await q("select public.delete_account($1, $2)", [suInv, nombre]);
    const [r] = await q("select count(*) as c from public.position_unit_event where position_id = $1", [suPos]);
    if (n(r.c) !== 0) throw new Error("quedan eventos");
  });
  check("delete_account sigue funcionando y se lleva el libro de la posición", eBorrar === null, eBorrar?.message);
}

// --------------------------------------------------------------------------
async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const [{ hoy }] = await q("select current_date::text as hoy");
    const reales = await q("select u.id::text as id from auth.users u order by u.created_at");
    const [ya] = await q("select to_regclass('public.instrument') is not null as esta");

    console.log(`— Datos reales: ${reales.length} usuarios, antes y después (solo se informa si coincide) —\n`);
    const antes = [];
    for (const u of reales) antes.push(await fotografia(u.id));

    if (ya.esta) {
      console.log("(las migraciones ya están en la base: la comparación antes/después es trivial)");
    } else {
      for (const m of MIGRACIONES) {
        await client.query(readFileSync(join(raiz, "supabase", "migrations", m), "utf8"));
      }
      console.log("(migraciones aplicadas dentro de la transacción)\n");
    }

    for (const [i, u] of reales.entries()) {
      const despues = await fotografia(u.id);
      const distintas = Object.keys(antes[i]).filter(
        (k) => JSON.stringify(antes[i][k]) !== JSON.stringify(despues[k]),
      );
      const filas = Object.values(despues).reduce((s, v) => s + v.length, 0);
      check(
        `real ${i + 1}: ${Object.keys(despues).length} consultas (${filas} filas) idénticas antes y después`,
        distintas.length === 0,
        `distintas: ${distintas.join(", ")}`,
      );
    }
    // Antes de publicar se exigía que ninguna posición real siguiera un
    // instrumento (era la razón de que nada pudiera cambiar). Ya publicado, los
    // usuarios dan de alta sus fondos: ese recuento solo se informa. Lo que
    // protege sus cifras es la comparación antes/después de arriba.
    const [sync] = await q("select count(*) as c from public.position_unit_event");
    console.log(`  (eventos de participaciones reales en la base: ${n(sync.c)})`);

    await curvaDiaria();
    const s = await casos(hoy);
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
