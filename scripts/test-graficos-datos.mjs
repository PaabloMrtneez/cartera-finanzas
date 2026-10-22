/**
 * Prueba de los datos de los gráficos nuevos:
 *
 *   20261005090000_patrimonio_diario_y_por_cuenta.sql
 *     net_worth_daily, net_worth_monthly, account_balance_monthly,
 *     savings_goal_projection (y private.account_worth_on, su base común)
 *   20261005090100_gasto_por_comercio_y_por_hora.sql
 *     merchant_spend, spend_heatmap
 *   20261005090200_gasto_por_tarjeta_ingresos_y_compromiso.sql
 *     account_card_spend, income_breakdown, commitment_by_subscription
 *   20261005090300_valor_de_posicion_con_aportes_posteriores.sql
 *     v_position_value, net_worth_history, position_return (criterio de valor)
 *
 *   node --env-file=.env.local scripts/test-graficos-datos.mjs
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): los
 * usuarios de prueba se insertan en auth.users ahí dentro, y no persiste nada.
 *
 * Prueba el esquema ACTUAL de la base. Antes reaplicaba esas cuatro migraciones
 * dentro de la transacción para comparar el antes y el después; desde que
 * migraciones posteriores cambiaron la firma de net_worth_monthly/daily (la
 * columna debt_cents de los préstamos), reaplicarlas falla con 42P13 («cannot
 * change return type of existing function»). Una migración aplicada no vuelve a
 * correrse: se prueba lo que hay.
 *
 * Tres bloques:
 *
 *   1. DATOS REALES. Para cada usuario de la base, simulando su sesión (rol
 *      authenticated, aal2), se comprueban los cuadres contra las cifras que ya
 *      enseña la app: el patrimonio diario al cierre de cada mes contra
 *      net_worth_history, el de hoy contra v_net_worth, las líneas por cuenta
 *      contra account_balance_history, y el gasto por comercio, por hora y por
 *      tarjeta —y el ingreso por categoría— contra v_month_summary, mes a mes.
 *      No se imprime ninguna cifra de nadie: solo si cuadra o no.
 *   2. DATOS SEMBRADOS. Un usuario con casos escogidos (reembolso en otra cuenta,
 *      comercio con espacios, gasto sin hora, aportación posterior a la última
 *      valoración, suscripción pausada…) y los resultados esperados a mano.
 *   3. AISLAMIENTO Y PERMISOS. Un segundo usuario no ve nada del primero, una
 *      sesión sin 2FA no ve nada, y anon no puede ejecutar las funciones.
 *
 * Las fechas se piden a la base con ::text: el driver pg convierte un `date` a
 * medianoche local y toISOString() devolvería el día anterior.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

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

/** Compara dos listas de filas por clave; devuelve las discrepancias. */
function diferencias(a, b, clave, campos) {
  const mapa = new Map(b.map((f) => [f[clave], f]));
  const malas = [];
  for (const fa of a) {
    const fb = mapa.get(fa[clave]);
    if (!fb) {
      malas.push(`${fa[clave]}: falta`);
      continue;
    }
    for (const c of campos) {
      if (n(fa[c]) !== n(fb[c])) malas.push(`${fa[clave]}.${c}: ${n(fa[c])} ≠ ${n(fb[c])}`);
    }
  }
  if (a.length !== b.length) malas.push(`filas: ${a.length} ≠ ${b.length}`);
  return malas;
}

// --------------------------------------------------------------------------
// 1. Cuadres contra los datos reales de un usuario
// --------------------------------------------------------------------------
async function cuadresReales(etiqueta) {
  // Patrimonio mensual = net_worth_history, y las partes suman el total.
  const historia = await q("select period_month::text as k, net_worth_cents from public.net_worth_history(24)");
  const mensual = await q(
    "select period_month::text as k, net_worth_cents, cash_cents, invested_cents, idle_cents, debt_cents from public.net_worth_monthly(24)",
  );
  const dm = diferencias(historia, mensual, "k", ["net_worth_cents"]);
  check(`${etiqueta}: net_worth_monthly = net_worth_history (24 meses)`, dm.length === 0, dm.slice(0, 4).join(" · "));
  check(
    `${etiqueta}: caja + invertido + sin desplegar + deuda = patrimonio, cada mes`,
    mensual.every((f) => n(f.cash_cents) + n(f.invested_cents) + n(f.idle_cents) + n(f.debt_cents) === n(f.net_worth_cents)),
  );

  // Patrimonio diario: al cierre de cada mes ya cerrado = net_worth_history.
  const diario = await q(
    `select fecha::text as fecha, net_worth_cents, cash_cents, invested_cents, idle_cents, debt_cents
     from public.net_worth_daily((date_trunc('month', current_date) - interval '23 months')::date, current_date)`,
  );
  const cierres = await q(
    `select period_month::text as k,
            (period_month + interval '1 month' - interval '1 day')::date::text as fin
     from public.net_worth_history(24)
     where period_month < date_trunc('month', current_date)::date`,
  );
  const porFecha = new Map(diario.map((f) => [f.fecha, f]));
  const malasCierre = cierres.filter((c) => {
    const d = porFecha.get(c.fin);
    const h = historia.find((x) => x.k === c.k);
    return !d || n(d.net_worth_cents) !== n(h.net_worth_cents);
  });
  check(
    `${etiqueta}: net_worth_daily al cierre de los ${cierres.length} meses cerrados = net_worth_history`,
    malasCierre.length === 0,
    malasCierre.map((c) => c.fin).join(", "),
  );
  check(
    `${etiqueta}: net_worth_daily trae un punto por día hasta hoy (${diario.length})`,
    diario.length > 600 && diario[diario.length - 1].fecha === (await q("select current_date::text as d"))[0].d,
  );
  check(
    `${etiqueta}: en el diario, las partes suman el total cada día`,
    diario.every((f) => n(f.cash_cents) + n(f.invested_cents) + n(f.idle_cents) + n(f.debt_cents) === n(f.net_worth_cents)),
  );

  // Hoy = v_net_worth, con sus tres partes (si no hay movimientos con fecha
  // futura, que v_net_worth sí cuenta y la curva diaria no).
  const [vnw] = await q("select * from public.v_net_worth");
  const [futuros] = await q("select count(*)::int as c from public.transaction where occurred_on > current_date");
  const hoy = diario[diario.length - 1];
  if (futuros.c === 0 && vnw) {
    check(
      `${etiqueta}: net_worth_daily(hoy) = v_net_worth (total, caja, invertido, sin desplegar)`,
      n(hoy.net_worth_cents) === n(vnw.net_worth_cents) &&
        n(hoy.cash_cents) === n(vnw.cash_cents) &&
        n(hoy.invested_cents) === n(vnw.invested_cents) &&
        n(hoy.idle_cents) === n(vnw.idle_cents) &&
        n(hoy.debt_cents) === n(vnw.debt_cents),
      `diario ${n(hoy.net_worth_cents) - n(vnw?.net_worth_cents)} de diferencia en el total`,
    );
  } else {
    console.log(`  (omitido: hay ${futuros.c} movimientos con fecha futura o ninguna cuenta)`);
  }

  // Líneas por cuenta: suma de saldos = account_balance_history; suma de
  // valores = patrimonio mensual.
  const lineas = await q(
    "select account_id, period_month::text as k, balance_cents, worth_cents from public.account_balance_monthly(12)",
  );
  const totalCuentas = await q("select period_month::text as k, cents from public.account_balance_history(12)");
  const sumaPorMes = (campo) => {
    const m = new Map();
    for (const f of lineas) m.set(f.k, (m.get(f.k) ?? 0) + n(f[campo]));
    return [...m.entries()].map(([k, v]) => ({ k, v }));
  };
  const saldos = sumaPorMes("balance_cents");
  const ds = totalCuentas
    .filter((t) => (saldos.find((s) => s.k === t.k)?.v ?? 0) !== n(t.cents))
    .map((t) => t.k);
  check(`${etiqueta}: Σ saldos por cuenta = account_balance_history (12 meses)`, ds.length === 0, ds.join(", "));
  const valores = sumaPorMes("worth_cents");
  const mensual12 = mensual.slice(-12);
  const dv = mensual12.filter((m) => (valores.find((s) => s.k === m.k)?.v ?? 0) !== n(m.net_worth_cents)).map((m) => m.k);
  check(`${etiqueta}: Σ valor por cuenta = patrimonio mensual (12 meses)`, dv.length === 0, dv.join(", "));

  // Gasto e ingreso, mes a mes, contra v_month_summary.
  const meses = await q(
    `select period_month::text as mes,
            (period_month + interval '1 month' - interval '1 day')::date::text as fin,
            coalesce(net_expense_cents, 0) as gasto, coalesce(income_cents, 0) as ingreso
     from public.v_month_summary order by period_month`,
  );
  const malos = { comercio: [], calor: [], tarjeta: [], bruto: [], ingreso: [] };
  for (const m of meses) {
    const [c] = await q("select coalesce(sum(net_cents),0) as s from public.merchant_spend($1,$2,5)", [m.mes, m.fin]);
    if (n(c.s) !== n(m.gasto)) malos.comercio.push(m.mes);
    const [h] = await q("select coalesce(sum(net_cents),0) as s, count(*)::int as celdas from public.spend_heatmap($1,$2)", [m.mes, m.fin]);
    if (n(h.s) !== n(m.gasto) || h.celdas !== 175) malos.calor.push(m.mes);
    const [t] = await q("select coalesce(sum(net_cents),0) as s from public.account_card_spend($1)", [m.mes]);
    if (n(t.s) !== n(m.gasto)) malos.tarjeta.push(m.mes);
    const [i] = await q("select coalesce(sum(income_cents),0) as s from public.income_breakdown($1)", [m.mes]);
    if (n(i.s) !== n(m.ingreso)) malos.ingreso.push(m.mes);
    // El bruto por cuenta de account_card_spend = account_spend_history, si el
    // mes cae en su ventana de 12.
    const brutoCuenta = await q(
      "select account_id, sum(gross_cents) as s from public.account_card_spend($1) group by account_id",
      [m.mes],
    );
    const historico = await q(
      "select account_id, gasto_cents from public.account_spend_history(12) where period_month = $1::date",
      [m.mes],
    );
    for (const hcta of historico) {
      const b = brutoCuenta.find((x) => x.account_id === hcta.account_id);
      if (n(b?.s ?? 0) !== n(hcta.gasto_cents)) malos.bruto.push(`${m.mes}`);
    }
  }
  check(`${etiqueta}: Σ merchant_spend = gasto neto de v_month_summary (${meses.length} meses)`, malos.comercio.length === 0, malos.comercio.join(", "));
  check(`${etiqueta}: Σ spend_heatmap = gasto neto, rejilla de 175 celdas`, malos.calor.length === 0, malos.calor.join(", "));
  check(`${etiqueta}: Σ account_card_spend = gasto neto`, malos.tarjeta.length === 0, malos.tarjeta.join(", "));
  check(`${etiqueta}: bruto por cuenta de account_card_spend = account_spend_history`, malos.bruto.length === 0, malos.bruto.join(", "));
  check(`${etiqueta}: Σ income_breakdown = ingresos de v_month_summary`, malos.ingreso.length === 0, malos.ingreso.join(", "));

  // Compromiso por suscripción = commitment_history.
  const comp = await q("select period_month::text as k, monthly_cents, cuantas from public.commitment_history(12)");
  const det = await q(
    `select period_month::text as k,
            coalesce(sum(monthly_cents) filter (where cuenta), 0) as monthly_cents,
            count(*) filter (where cuenta) as cuantas
     from public.commitment_by_subscription(12) group by 1`,
  );
  const dc = comp.filter((c) => {
    const d = det.find((x) => x.k === c.k);
    return n(d?.monthly_cents ?? 0) !== n(c.monthly_cents) || n(d?.cuantas ?? 0) !== n(c.cuantas);
  });
  check(`${etiqueta}: commitment_by_subscription = commitment_history (12 meses)`, dc.length === 0, dc.map((c) => c.k).join(", "));

  // Proyección de metas: una fila por meta, y saved = la barra de progreso.
  const proy = await q("select goal_id, saved_cents from public.savings_goal_projection(6)");
  const prog = await q("select id as goal_id, saved_cents from public.v_savings_goal_progress");
  check(
    `${etiqueta}: savings_goal_projection, una fila por meta y saved = v_savings_goal_progress (${prog.length})`,
    proy.length === prog.length && prog.every((p) => n(proy.find((x) => x.goal_id === p.goal_id)?.saved_cents) === n(p.saved_cents)),
  );
}

// --------------------------------------------------------------------------
// 2. Datos sembrados
// --------------------------------------------------------------------------
const MES = (k) => `(date_trunc('month', current_date) - interval '${k} months')::date`;
const DIA = (k, d) => `(${MES(k)} + ${d - 1})`;
const FIN = (k) => `(${MES(k - 1)} - 1)`;

async function sembrar() {
  const uid = (await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id"))[0].id;
  const cuenta = async (nombre, tipo, inicial = 0) =>
    (
      await q(
        "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,$2,$3,$4) returning id::text as id",
        [uid, nombre, tipo, inicial],
      )
    )[0].id;
  const banco = await cuenta("Banco", "BANCO", 1_000_000);
  const ahorro = await cuenta("Ahorro", "AHORRO");
  const inversion = await cuenta("Broker", "INVERSION");
  const credito = await cuenta("Crédito", "BANCO", -20_000);

  const categoria = async (nombre, tipo) =>
    (
      await q("insert into public.category (user_id,name,type) values ($1,$2,$3) returning id::text as id", [uid, nombre, tipo])
    )[0].id;
  const compras = await categoria("Compras", "EXPENSE");
  const nomina = await categoria("Nómina", "INCOME");

  const t1111 = (await q("insert into public.card (user_id,account_id,last4,type,nickname) values ($1,$2,'1111','DEBITO','Física') returning id::text as id", [uid, banco]))[0].id;
  const t2222 = (await q("insert into public.card (user_id,account_id,last4,type,nickname) values ($1,$2,'2222','DEBITO','Apple Pay') returning id::text as id", [uid, banco]))[0].id;

  const gasto = async ({ cents, fecha, hora = "00:00", comercio = null, tarjeta = null, cuentaId = banco, status = "CONFIRMED" }) =>
    (
      await q(
        `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,occurred_time,account_id,
           category_id,category_type,source,status,merchant_raw,card_last4,external_id)
         values ($1,'EXPENSE',$2,'g',${fecha},$3,$4,$5,'EXPENSE',
           case when $6::text is null then 'MANUAL' else 'SHORTCUT' end::public.tx_source,$7,$6,$8,
           case when $6::text is null then null else 'ext-' || gen_random_uuid() end)
         returning id::text as id`,
        [uid, cents, hora, cuentaId, compras, comercio, status, tarjeta],
      )
    )[0].id;

  // ── Mes −1: el mes de los cuadres de gasto ─────────────────────────────────
  await gasto({ cents: 3000, fecha: DIA(1, 3), hora: "10:15:12", comercio: " Mercadona ", tarjeta: "1111" });
  await gasto({ cents: 2000, fecha: DIA(1, 3), hora: "10:45:40", comercio: "MERCADONA", tarjeta: "2222" });
  const zara = await gasto({ cents: 5000, fecha: DIA(1, 6), hora: "18:30:05", comercio: "Zara", tarjeta: "1111" });
  await gasto({ cents: 1000, fecha: DIA(1, 8) }); // a mano: sin comercio, sin hora, sin tarjeta
  await gasto({ cents: 700, fecha: DIA(1, 9), hora: "22:10:00", comercio: "Bar  Pepe", tarjeta: "9999" }); // último4 ajeno
  await gasto({ cents: 4000, fecha: DIA(1, 9), hora: "12:00:00", comercio: "Mercadona", tarjeta: "1111", status: "DISCARDED" });
  // Reembolso parcial de Zara, cobrado en OTRA cuenta y sin hora.
  await q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,reimburses_id,reimburses_target_type,source,status)
     values ($1,'INCOME',1500,'devolución Zara',${DIA(1, 20)},$2,$3,'EXPENSE','MANUAL','CONFIRMED')`,
    [uid, ahorro, zara],
  );
  // Un traspaso: no es gasto.
  await q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,source,status)
     values ($1,'TRANSFER',10000,'a ahorro',${DIA(1, 10)},$2,$3,'MANUAL','CONFIRMED')`,
    [uid, banco, ahorro],
  );
  // Ingresos: nómina recurrente, una venta sin categoría, y la nómina del mes −2.
  const recurrente = (
    await q(
      `insert into public.recurring_income (user_id,description,amount_cents,periodicity,next_income_date,started_at,category_id,category_type,account_id)
       values ($1,'Nómina',200000,'MENSUAL',current_date + 30,${MES(3)},$2,'INCOME',$3) returning id::text as id`,
      [uid, nomina, banco],
    )
  )[0].id;
  await q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status,recurring_income_id)
     values ($1,'INCOME',200000,'nómina',${DIA(1, 1)},$2,$3,'INCOME','RECURRING','CONFIRMED',$4)`,
    [uid, banco, nomina, recurrente],
  );
  await q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,source,status)
     values ($1,'INCOME',5000,'venta',${DIA(1, 15)},$2,'MANUAL','CONFIRMED')`,
    [uid, banco],
  );
  await q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
     values ($1,'INCOME',3000,'nómina',${DIA(2, 1)},$2,$3,'INCOME','MANUAL','CONFIRMED')`,
    [uid, banco, nomina],
  );

  // ── Inversión: aportación, valoración, aportación POSTERIOR a la valoración ─
  const posicion = (
    await q(
      "insert into public.investment_position (user_id,name,account_id,since) values ($1,'Fondo',$2,(current_date - 400)) returning id::text as id",
      [uid, inversion],
    )
  )[0].id;
  const aportar = (cents, fecha) =>
    q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,position_id,source,status)
       values ($1,'TRANSFER',$2,'aporte',${fecha},$3,$4,$5,'MANUAL','CONFIRMED')`,
      [uid, cents, banco, inversion, posicion],
    );
  const valorar = (cents, fecha) =>
    q(`insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,${fecha},$3)`, [uid, posicion, cents]);
  await aportar(50000, DIA(4, 5));
  await valorar(55000, FIN(4));
  await aportar(20000, DIA(3, 10)); // a mitad de mes, después de la valoración
  await valorar(80000, FIN(3));
  // Caja sin desplegar: dinero en el broker que no está en ninguna posición.
  await q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,source,status)
     values ($1,'TRANSFER',7000,'al broker',${DIA(3, 12)},$2,$3,'MANUAL','CONFIRMED')`,
    [uid, banco, inversion],
  );

  // ── Suscripciones: una activa desde el mes −2, una pausada desde el −1 ────
  await q(
    `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,started_at,account_id,active)
     values ($1,'Música',1299,'MENSUAL',current_date + 20,${MES(2)},$2,true),
            ($1,'Nube',12000,'ANUAL',current_date + 200,${DIA(1, 15)},$2,false)`,
    [uid, banco],
  );

  // ── Meta sobre Ahorro ──────────────────────────────────────────────────────
  const meta = (
    await q(
      "insert into public.savings_goal (user_id,name,target_cents,account_id,deadline) values ($1,'Colchón',100000,$2,current_date + 365) returning id::text as id",
      [uid, ahorro],
    )
  )[0].id;

  return { uid, banco, ahorro, inversion, credito, t1111, t2222, posicion, meta, aportar };
}

async function pruebasSembradas(s) {
  const { uid } = s;
  const [mesM1] = await q(`select ${MES(1)}::text as m, ${FIN(1)}::text as fin`);

  await comoUsuario(uid, async () => {
    console.log("\n— Gasto por comercio (mes −1) —\n");
    const com = await q("select * from public.merchant_spend($1,$2,2)", [mesM1.m, mesM1.fin]);
    const fila = (g, k) => com.find((f) => f.grupo === g && (k === undefined || f.merchant_key === k));
    check("Top 1 = mercadona (« Mercadona » y «MERCADONA» juntos), 5000 netos en 2 cargos", fila("COMERCIO", "mercadona")?.puesto === 1 && n(fila("COMERCIO", "mercadona").net_cents) === 5000 && fila("COMERCIO", "mercadona").cargos === 2, JSON.stringify(fila("COMERCIO", "mercadona")));
    check("El descartado de Mercadona no cuenta", n(fila("COMERCIO", "mercadona")?.gross_cents) === 5000);
    const z = fila("COMERCIO", "zara");
    check("Top 2 = zara: 5000 brutos − 1500 de reembolso = 3500 netos", z?.puesto === 2 && n(z.net_cents) === 3500 && n(z.gross_cents) === 5000 && n(z.reimbursed_cents) === 1500, JSON.stringify(z));
    const otros = fila("OTROS");
    check("OTROS = «Bar  Pepe» (espacios normalizados), 700 en 1 comercio", n(otros?.net_cents) === 700 && otros.comercios === 1, JSON.stringify(otros));
    check("SIN_COMERCIO = el gasto a mano, 1000", n(fila("SIN_COMERCIO")?.net_cents) === 1000);
    const total = com.reduce((a, f) => a + n(f.net_cents), 0);
    const [ms] = await q("select net_expense_cents from public.v_month_summary where period_month = $1::date", [mesM1.m]);
    check("Σ = 10200 = gasto neto de v_month_summary (sin traspaso ni descartado)", total === 10200 && n(ms.net_expense_cents) === 10200, `${total} / ${ms?.net_expense_cents}`);
    check("Los share suman 100", Math.abs(com.reduce((a, f) => a + Number(f.share), 0) - 100) < 0.5);

    console.log("\n— Mapa de calor (mes −1) —\n");
    const calor = await q("select * from public.spend_heatmap($1,$2)", [mesM1.m, mesM1.fin]);
    const [dows] = await q(
      `select extract(isodow from ${DIA(1, 3)})::int as d3, extract(isodow from ${DIA(1, 6)})::int as d6,
              extract(isodow from ${DIA(1, 8)})::int as d8, extract(isodow from ${DIA(1, 9)})::int as d9`,
    );
    const celda = (d, h) => calor.find((c) => c.dia_semana === d && c.hora === h);
    check("175 celdas (7 × (24 + sin hora))", calor.length === 175);
    check("Las 10:xx de Mercadona en su día: 5000 en 2 cargos", n(celda(dows.d3, 10)?.net_cents) === 5000 && celda(dows.d3, 10).cargos === 2);
    check("El reembolso resta en la celda del GASTO (18 h de Zara): 3500", n(celda(dows.d6, 18)?.net_cents) === 3500 && celda(dows.d6, 18).cargos === 1, JSON.stringify(celda(dows.d6, 18)));
    check("El gasto a mano de las 00:00 va a «sin hora» (hora NULL)", n(celda(dows.d8, null)?.net_cents) === 1000 && n(celda(dows.d8, 0)?.net_cents) === 0);
    check("Σ del mapa = 10200", calor.reduce((a, c) => a + n(c.net_cents), 0) === 10200);
    check("Cargos del mapa = 5 (el reembolso no es un cargo)", calor.reduce((a, c) => a + c.cargos, 0) === 5);

    console.log("\n— Gasto por cuenta y tarjeta (mes −1) —\n");
    const tar = await q("select * from public.account_card_spend($1)", [mesM1.m]);
    const deTarjeta = (id) => tar.find((f) => f.card_id === id);
    check("Tarjeta 1111: 3000 + 5000 − 1500 (el reembolso cobrado en Ahorro resta en la tarjeta del gasto) = 6500", n(deTarjeta(s.t1111)?.net_cents) === 6500, JSON.stringify(deTarjeta(s.t1111)));
    check("Tarjeta 2222: 2000", n(deTarjeta(s.t2222)?.net_cents) === 2000);
    const sin = tar.find((f) => f.account_id === s.banco && f.card_id === null);
    check("Banco «sin tarjeta»: 1000 a mano + 700 con un último4 ajeno = 1700", n(sin?.net_cents) === 1700 && sin.cargos === 2, JSON.stringify(sin));
    check("Ahorro (donde se cobró el reembolso) no aparece", !tar.some((f) => f.account_id === s.ahorro));
    check("account_net_cents de Banco = 10200 y la suma total = 10200", tar.every((f) => n(f.account_net_cents) === 10200) && tar.reduce((a, f) => a + n(f.net_cents), 0) === 10200);
    check("«sin tarjeta» va al final de su cuenta", tar[tar.length - 1].card_id === null);

    console.log("\n— Fuentes de ingreso (mes −1) —\n");
    const ing = await q("select * from public.income_breakdown($1)", [mesM1.m]);
    const nom = ing.find((f) => f.name === "Nómina");
    const sinCat = ing.find((f) => f.category_id === null);
    check("Nómina: 200000 este mes, 3000 el anterior, 200000 recurrente", n(nom?.income_cents) === 200000 && n(nom.previo_cents) === 3000 && n(nom.recurrente_cents) === 200000, JSON.stringify(nom));
    check("Sin categoría: 5000 (la venta)", n(sinCat?.income_cents) === 5000);
    check("El reembolso de 1500 NO es ingreso: Σ = 205000 = v_month_summary", ing.reduce((a, f) => a + n(f.income_cents), 0) === 205000);

    console.log("\n— Compromiso por suscripción —\n");
    const cs = await q("select period_month::text as k, description, monthly_cents, cuenta, alta, pausada from public.commitment_by_subscription(3)");
    const [m2, m1, m0] = (await q(`select ${MES(2)}::text a, ${MES(1)}::text b, ${MES(0)}::text c`)).map((r) => [r.a, r.b, r.c])[0];
    const fila2 = (k, d) => cs.find((f) => f.k === k && f.description === d);
    check("Mes −2: Música entra (alta) con 1299", fila2(m2, "Música")?.alta === true && n(fila2(m2, "Música").monthly_cents) === 1299 && !fila2(m2, "Nube"));
    check("Mes −1: Nube entra (alta, pausada hoy, pero entonces contaba) con 1000/mes", fila2(m1, "Nube")?.alta === true && fila2(m1, "Nube").cuenta === true && n(fila2(m1, "Nube").monthly_cents) === 1000);
    check("Mes en curso: Nube sale (cuenta = false) — el escalón hacia abajo", fila2(m0, "Nube")?.cuenta === false && fila2(m0, "Nube").pausada === true);
    const hist = await q("select period_month::text as k, monthly_cents from public.commitment_history(3)");
    check("Cuadra con commitment_history mes a mes", hist.every((h) => cs.filter((f) => f.k === h.k && f.cuenta).reduce((a, f) => a + n(f.monthly_cents), 0) === n(h.monthly_cents)));

    console.log("\n— Patrimonio diario y criterio de valor —\n");
    const [d] = await q(
      `select ${DIA(3, 9)}::text as antes, ${DIA(3, 10)}::text as aporte, ${DIA(3, 20)}::text as despues, ${FIN(3)}::text as fin3`,
    );
    const diario = await q(
      `select fecha::text as fecha, net_worth_cents, cash_cents, invested_cents, idle_cents, debt_cents from public.net_worth_daily(${MES(4)}, current_date)`,
    );
    const en = (f) => diario.find((x) => x.fecha === f);
    check(
      "La aportación posterior a la valoración NO hunde el patrimonio (día antes = día de la aportación)",
      n(en(d.antes).net_worth_cents) === n(en(d.aporte).net_worth_cents),
      `${en(d.antes).net_worth_cents} → ${en(d.aporte).net_worth_cents}`,
    );
    check("Ese día, invertido = valoración 55000 + aportado después 20000", n(en(d.aporte).invested_cents) === 75000, en(d.aporte).invested_cents);
    check("Tras el traspaso de 7000 al broker sin posición: sin desplegar = 7000", n(en(d.despues).idle_cents) === 7000);
    check("Al cierre del mes −3 manda la nueva valoración (80000)", n(en(d.fin3).invested_cents) === 80000);
    check("Partes = total todos los días", diario.every((f) => n(f.cash_cents) + n(f.invested_cents) + n(f.idle_cents) + n(f.debt_cents) === n(f.net_worth_cents)));
    const vacio = await q("select * from public.net_worth_daily(current_date, current_date - 1)");
    check("Rango al revés: vacío", vacio.length === 0);
    const futuro = await q("select fecha::text as f from public.net_worth_daily(current_date - 2, current_date + 30)");
    check("El rango se recorta a hoy (3 días)", futuro.length === 3);

    console.log("\n— Líneas por cuenta —\n");
    const lineas = await q("select account_id, name, period_month::text as k, balance_cents, worth_cents from public.account_balance_monthly(6)");
    check("4 cuentas × 6 meses", lineas.length === 24);
    const broker = lineas.find((l) => l.account_id === s.inversion && l.k === m1);
    check("Broker en el mes −1: saldo 77000 (70000 aportado + 7000), valor 80000 + 7000 = 87000", n(broker?.balance_cents) === 77000 && n(broker.worth_cents) === 87000, JSON.stringify(broker));
    const cred = lineas.find((l) => l.account_id === s.credito && l.k === m1);
    check("La cuenta en negativo conserva su saldo (−20000)", n(cred?.balance_cents) === -20000);

    console.log("\n— Proyección de la meta —\n");
    const [p] = await q("select * from public.savings_goal_projection(6)");
    // Ahorro: 10000 (traspaso) + 1500 (reembolso) en el mes −1; 0 seis cierres antes.
    const ritmo = Math.round(11500 / 6);
    const falta = 100000 - 11500;
    check(`saved = 11500, ritmo = ${ritmo}/mes`, n(p?.saved_cents) === 11500 && n(p.ritmo_cents) === ritmo, JSON.stringify(p));
    check(`meses = ⌈${falta}/${ritmo}⌉ = ${Math.ceil(falta / ritmo)}`, p.meses_para_meta === Math.ceil(falta / ritmo));
    check("necesario al mes = la cuenta de la tarjeta de la meta", n(p.necesario_mensual_cents) === Math.round((falta * 30.44) / 365), `${p.necesario_mensual_cents}`);
  });
}

// --------------------------------------------------------------------------
// 3. Aislamiento y permisos
// --------------------------------------------------------------------------
async function aislamiento(s) {
  console.log("\n— Aislamiento —\n");
  const otro = (await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id"))[0].id;
  await q("insert into public.account (user_id,name,type,initial_balance_cents) values ($1,'Suya','BANCO',123)", [otro]);
  const [r] = await q(`select ${MES(1)}::text as m, ${FIN(1)}::text as fin`);

  const llamadas = async () => ({
    diario: await q("select * from public.net_worth_daily(current_date - 400, current_date)"),
    mensual: await q("select * from public.net_worth_monthly(12)"),
    lineas: await q("select * from public.account_balance_monthly(12)"),
    metas: await q("select * from public.savings_goal_projection(6)"),
    comercio: await q("select * from public.merchant_spend($1,$2,10)", [r.m, r.fin]),
    calor: await q("select * from public.spend_heatmap($1,$2)", [r.m, r.fin]),
    tarjeta: await q("select * from public.account_card_spend($1)", [r.m]),
    ingreso: await q("select * from public.income_breakdown($1)", [r.m]),
    compromiso: await q("select * from public.commitment_by_subscription(12)"),
  });

  const ajeno = await comoUsuario(otro, llamadas);
  check("Otro usuario: su patrimonio diario es solo su cuenta (123)", ajeno.diario.every((f) => n(f.net_worth_cents) === 123));
  check("Otro usuario: patrimonio mensual 123", ajeno.mensual.every((f) => n(f.net_worth_cents) === 123));
  check("Otro usuario: solo su cuenta en las líneas", ajeno.lineas.every((f) => !Object.values(s).includes(f.account_id)) && ajeno.lineas.length === 12);
  check("Otro usuario: ni metas, ni comercios, ni tarjetas, ni ingresos, ni suscripciones ajenas",
    ajeno.metas.length === 0 && ajeno.comercio.length === 0 && ajeno.tarjeta.length === 0 && ajeno.ingreso.length === 0 && ajeno.compromiso.length === 0);
  check("Otro usuario: mapa de calor todo a cero", ajeno.calor.length === 175 && ajeno.calor.every((c) => n(c.net_cents) === 0));

  // Con el 2FA opcional (20261019090000) solo se exige aal2 a quien tiene un
  // factor verificado: se le da uno (con la regla anterior da igual).
  await q(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (gen_random_uuid(), $1, 'prueba', 'totp', 'verified', now(), now())`,
    [s.uid],
  );
  const sin2fa = await comoUsuario(s.uid, llamadas, "aal1");
  check("Sesión sin 2FA (aal1): nada (patrimonio 0, listas vacías)",
    sin2fa.diario.every((f) => n(f.net_worth_cents) === 0) && sin2fa.lineas.length === 0 && sin2fa.comercio.length === 0 &&
    sin2fa.tarjeta.length === 0 && sin2fa.ingreso.length === 0 && sin2fa.metas.length === 0 &&
    sin2fa.calor.every((c) => n(c.net_cents) === 0));

  console.log("\n— Permisos —\n");
  const firmas = [
    "public.net_worth_daily(date, date)",
    "public.net_worth_monthly(integer)",
    "public.account_balance_monthly(integer)",
    "public.savings_goal_projection(integer)",
    "public.merchant_spend(date, date, integer)",
    "public.spend_heatmap(date, date)",
    "public.account_card_spend(date)",
    "public.income_breakdown(date)",
    "public.commitment_by_subscription(integer)",
    "private.account_worth_on(date[])",
  ];
  for (const f of firmas) {
    const [p] = await q(
      "select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth",
      [f],
    );
    check(`${f}: authenticated sí, anon no`, p.auth === true && p.anon === false);
  }
  const [cfg] = await q(
    `select count(*) filter (where p.prosecdef) as definer,
            count(*) filter (where not coalesce(p.proconfig, '{}') @> array['search_path=""']) as sin_path
     from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where (s.nspname, p.proname) in (('public','net_worth_daily'),('public','net_worth_monthly'),('public','account_balance_monthly'),
       ('public','savings_goal_projection'),('public','merchant_spend'),('public','spend_heatmap'),('public','account_card_spend'),
       ('public','income_breakdown'),('public','commitment_by_subscription'),('private','account_worth_on'))`,
  );
  check("Todas security invoker y con search_path = ''", n(cfg.definer) === 0 && n(cfg.sin_path) === 0, JSON.stringify(cfg));
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const reales = await q("select id::text as id from auth.users order by created_at");

    console.log(`— Datos reales: ${reales.length} usuarios (solo se informa si cuadra) —`);
    for (const [i, u] of reales.entries()) {
      console.log(`\n  usuario ${i + 1}`);
      await comoUsuario(u.id, () => cuadresReales(`real ${i + 1}`));
    }

    const s = await sembrar();

    // Una aportación HOY, sin valoración posterior: el criterio de valor de
    // 20261005090300 la suma a la última valoración (antes desaparecía).
    await s.aportar(10000, "current_date");

    console.log("\n— Criterio de valor (20261005090300) con datos sembrados —\n");
    await comoUsuario(s.uid, async () => {
      const [pv] = await q("select value_cents, contributed_cents from public.v_position_value where position_id = $1", [s.posicion]);
      check("v_position_value: 80000 valorado + 10000 aportado hoy = 90000", n(pv.value_cents) === 90000 && n(pv.contributed_cents) === 80000);
      const [rt] = await q(
        "select start_cents, end_cents, contributions_cents, gain_cents from public.position_return(date_trunc('month', current_date)::date - 1, current_date)",
      );
      check("position_return del mes: fin 90000, aportado 10000, ganancia 0 (antes salía −10000)", n(rt.end_cents) === 90000 && n(rt.contributions_cents) === 10000 && n(rt.gain_cents) === 0, JSON.stringify(rt));
      const [rt2] = await q(`select start_cents, end_cents, contributions_cents, gain_cents from public.position_return(${DIA(3, 15)}, ${FIN(3)})`);
      check("position_return con inicio entre valoración y aportación: inicio 75000, fin 80000, ganancia 5000", n(rt2.start_cents) === 75000 && n(rt2.end_cents) === 80000 && n(rt2.gain_cents) === 5000, JSON.stringify(rt2));
      const [nw] = await q("select net_worth_cents, invested_cents from public.v_net_worth");
      const [hoy] = await q("select net_worth_cents, invested_cents from public.net_worth_daily(current_date, current_date)");
      check("v_net_worth = net_worth_daily(hoy) también con la aportación de hoy", n(nw.net_worth_cents) === n(hoy.net_worth_cents) && n(nw.invested_cents) === n(hoy.invested_cents));
      const [h] = await q("select h.net_worth_cents as a, m.net_worth_cents as b from public.net_worth_history(1) h join public.net_worth_monthly(1) m using (period_month)");
      check("net_worth_history = net_worth_monthly", n(h.a) === n(h.b));
    });

    await pruebasSembradas(s);
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
