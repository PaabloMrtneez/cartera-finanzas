/**
 * Banco de pruebas de VOLUMEN de la capa de datos.
 *
 *   node --env-file=.env.local scripts/bench-volumen.mjs [opciones]
 *
 *   --perfiles=normal,intenso   qué usuarios sintéticos sembrar (por defecto, los dos)
 *   --reps=3                    repeticiones cronometradas de cada consulta (mediana)
 *   --salida=DIR                guarda ahí los planes (auto_explain, anidados) y un JSON
 *   --solo=texto                mide solo las consultas cuyo nombre contenga «texto»
 *   --sin-analyze               no actualiza estadísticas tras sembrar (planes «en frío»)
 *   --propuesta=a.sql[,b.sql]   aplica esos ficheros DENTRO de la transacción tras sembrar,
 *                               comprueba que las cifras (patrimonio, posiciones,
 *                               rendimiento, búsqueda…) salen idénticas antes y después,
 *                               y mide ya con la propuesta. Para probar una migración de
 *                               rendimiento sin aplicarla a producción.
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): los
 * usuarios sintéticos (auth.users), sus cuentas, movimientos, precios… se
 * insertan ahí dentro y no persiste nada. No se lee ni se imprime ningún dato de
 * los usuarios reales: cada consulta corre con la sesión `authenticated` (aal2)
 * del usuario sintético, así que la RLS solo le deja ver lo suyo.
 *
 * Huellas fuera de la transacción (ningún dato, pero existen):
 *   · ANALYZE (salvo --sin-analyze) actualiza en el sitio `pg_class.reltuples`
 *     de las tablas sembradas; no se deshace. El autoanalyze lo corrige.
 *   · Las ~51.000 filas deshechas quedan como espacio muerto: el autovacuum lo
 *     deja reutilizable pero el fichero NO encoge. Seis ejecuciones llevaron la
 *     base de 16 a 83 MB (se recupera con `vacuum (full, analyze) public.transaction`).
 *     Mejor correrlo contra una rama o copia de Supabase que contra producción.
 *
 * Perfiles:
 *   normal   1 año, ~5 gastos/día (~2.000 movimientos), 5 cuentas, 1 fondo
 *            sincronizado + 1 manual, 4 suscripciones, sin préstamos.
 *   intenso  10 años, ~12 gastos/día (~50.000 movimientos), 15 cuentas (una
 *            archivada con saldo), 6 tarjetas, 10 límites, 3 metas, 15
 *            suscripciones, 5 fondos sincronizados con precios diarios de 10
 *            años (uno en USD), 1 manual con valoraciones mensuales, y 2
 *            préstamos (hipoteca a 30 años y coche a 7) con sus cuotas.
 *
 * Por cada consulta de pantalla se mide: el tiempo de servidor (auto_explain,
 * con los planes de las sentencias ANIDADAS dentro de las funciones SQL, que un
 * EXPLAIN normal no enseña), y la mediana del tiempo de reloj visto desde aquí
 * (incluye la ida y vuelta de red, que se mide aparte con `select 1`).
 *
 * Las fechas se piden siempre con ::text (el driver pg + toISOString resta un día).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const args = process.argv.slice(2);
const opcion = (n, def) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? def;
const PERFILES = opcion("perfiles", "normal,intenso").split(",");
const REPS = Number(opcion("reps", "3"));
const SALIDA = opcion("salida", null) ? resolve(opcion("salida")) : null;
const SOLO = opcion("solo", null);
const ANALIZAR = !args.includes("--sin-analyze");
const SIN_HUELLA = args.includes("--sin-huella");
const PROPUESTAS = (opcion("propuesta", "") || "").split(",").filter(Boolean).map((f) => resolve(f));

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

let avisos = [];
client.on("notice", (m) => avisos.push(m.message));

// --------------------------------------------------------------------------
// Siembra
// --------------------------------------------------------------------------
const CONFIG = {
  normal: {
    anios: 1, gastosDia: 5,
    cuentas: ["BANCO", "BANCO", "AHORRO", "EFECTIVO", "INVERSION"],
    tarjetas: 2, fondos: 1, subs: 4, limites: 3, metas: 1, reglas: 10, prestamos: false,
  },
  intenso: {
    anios: 10, gastosDia: 12.3,
    cuentas: ["BANCO", "BANCO", "BANCO", "BANCO", "BANCO", "AHORRO", "AHORRO", "EFECTIVO", "EFECTIVO",
      "INVERSION", "INVERSION", "INVERSION", "BANCO"],
    tarjetas: 6, fondos: 5, subs: 15, limites: 10, metas: 3, reglas: 50, prestamos: true,
  },
};

const COMERCIOS = [
  "MERCADONA", "CARREFOUR", "LIDL", "AMAZON", "REPSOL", "CEPSA", "ZARA", "EL CORTE INGLES", "IKEA", "DECATHLON",
  "BAR PEPE", "CAFETERIA LUNA", "FARMACIA CENTRO", "RENFE", "UBER", "GLOVO", "NETFLIX", "SPOTIFY", "APPLE.COM", "GOOGLE",
  ...Array.from({ length: 280 }, (_, i) => `COMERCIO ${String(i + 1).padStart(3, "0")}`),
];

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

async function sembrar(perfil, etiqueta) {
  const c = CONFIG[perfil];
  const t0 = Date.now();
  await q("select setseed($1)", [perfil === "normal" ? 0.11 : 0.42]);
  const [{ id: uid }] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  const [{ ini }] = await q("select (current_date - make_interval(years => $1))::date::text as ini", [c.anios]);

  // Cuentas
  const cuentas = await q(
    `insert into public.account (user_id, name, type, initial_balance_cents)
     select $1, format('Bench %s %s', x.t, x.o), x.t::public.account_type,
            case when x.t = 'INVERSION' then 0 else (random() * 500000)::bigint end
     from unnest($2::text[]) with ordinality as x(t, o)
     returning id::text as id, type::text as type`,
    [uid, c.cuentas],
  );
  const de = (t) => cuentas.filter((x) => x.type === t).map((x) => x.id);
  const bancos = de("BANCO");
  const gastables = [...bancos.slice(0, Math.max(1, bancos.length - 1)), ...de("EFECTIVO")];
  const inversion = de("INVERSION");
  const noInversion = cuentas.filter((x) => x.type !== "INVERSION").map((x) => x.id);

  // Categorías
  const gastoCats = (
    await q(
      `insert into public.category (user_id, name, type)
       select $1, format('Gasto %s', lpad(g::text, 2, '0')), 'EXPENSE' from generate_series(1, 20) g
       returning id::text as id`,
      [uid],
    )
  ).map((r) => r.id);
  const ingresoCats = (
    await q(
      `insert into public.category (user_id, name, type)
       select $1, format('Ingreso %s', g), 'INCOME' from generate_series(1, 5) g
       returning id::text as id`,
      [uid],
    )
  ).map((r) => r.id);

  // Tarjetas: dos por banco, hasta c.tarjetas
  const tarjetas = [];
  for (let i = 0; i < c.tarjetas; i++) {
    const last4 = String(1000 + i * 1111).slice(-4);
    await q("insert into public.card (user_id, account_id, last4, type) values ($1, $2, $3, 'DEBITO')", [
      uid, bancos[Math.floor(i / 2) % bancos.length], last4,
    ]);
    tarjetas.push(last4);
  }

  // Gastos: el grueso. Categorías y comercios sesgados (unas pocas concentran casi todo).
  const dias = c.anios * 365;
  const nGastos = Math.round(dias * c.gastosDia);
  await q(
    `with gen as (
       select g as n,
              $2::date + floor(random() * (current_date - $2::date + 1))::int as d,
              random() as r1, random() as r2, random() as r3, random() as r4, random() as r5, random() as r6
       from generate_series(1, $3) g)
     insert into public.transaction (user_id, type, amount_cents, description, occurred_on, occurred_time,
       account_id, category_id, category_type, source, status, merchant_raw, card_last4, external_id)
     select $1, 'EXPENSE',
            greatest(50, (power(r1, 3) * 30000)::bigint + 50),
            'Gasto ' || n,
            d,
            case when r4 < 0.7 then make_time(floor(r5 * 24)::int, floor(r2 * 60)::int, 0) else '00:00' end,
            ($4::uuid[])[1 + floor(r2 * array_length($4::uuid[], 1))::int],
            case when r3 < 0.03 then null else ($5::uuid[])[1 + floor(power(r3, 2) * array_length($5::uuid[], 1))::int] end,
            case when r3 < 0.03 then null else 'EXPENSE'::public.entry_type end,
            case when r4 < 0.7 then 'SHORTCUT' else 'MANUAL' end::public.tx_source,
            case when r6 < 0.01 then 'DISCARDED' when r4 < 0.7 and r3 < 0.005 then 'PENDING' else 'CONFIRMED' end::public.tx_status,
            case when r4 < 0.7 then ($6::text[])[1 + floor(power(r1, 2) * array_length($6::text[], 1))::int] end,
            case when r4 < 0.7 and r5 < 0.8 and array_length($7::text[], 1) > 0
                 then ($7::text[])[1 + floor(r6 * array_length($7::text[], 1))::int] end,
            case when r4 < 0.7 then 'bench-' || n end
     from gen`,
    [uid, ini, nGastos, gastables, gastoCats, COMERCIOS, tarjetas],
  );

  // Nóminas (ingreso recurrente) y otros ingresos
  const [{ id: nomina }] = await q(
    `insert into public.recurring_income (user_id, description, amount_cents, periodicity, next_income_date, started_at,
       category_id, category_type, account_id)
     values ($1, 'Nómina', 250000, 'MENSUAL', (date_trunc('month', current_date) + interval '1 month')::date, $2::date,
       $3, 'INCOME', $4) returning id::text as id`,
    [uid, ini, ingresoCats[0], bancos[0]],
  );
  await q(
    `insert into public.transaction (user_id, type, amount_cents, description, occurred_on, account_id,
       category_id, category_type, source, status, recurring_income_id)
     select $1, 'INCOME', 250000 + (random() * 20000)::bigint, 'Nómina', m::date, $3, $4, 'INCOME', 'RECURRING', 'CONFIRMED', $5
     from generate_series(date_trunc('month', $2::date) + interval '1 month', current_date, interval '1 month') m`,
    [uid, ini, bancos[0], ingresoCats[0], nomina],
  );
  await q(
    `insert into public.transaction (user_id, type, amount_cents, description, occurred_on, account_id,
       category_id, category_type, source, status)
     select $1, 'INCOME', (random() * 80000)::bigint + 100, 'Ingreso ' || g,
            $2::date + floor(random() * (current_date - $2::date + 1))::int,
            ($3::uuid[])[1 + floor(random() * array_length($3::uuid[], 1))::int],
            ($4::uuid[])[1 + floor(random() * array_length($4::uuid[], 1))::int], 'INCOME', 'MANUAL', 'CONFIRMED'
     from generate_series(1, $5) g`,
    [uid, ini, bancos, ingresoCats, c.anios * 24],
  );

  // Reembolsos: el 1 % de los gastos confirmados, a veces cobrados en otra cuenta.
  await q(
    `insert into public.transaction (user_id, type, amount_cents, description, occurred_on, account_id,
       source, status, reimburses_id, reimburses_target_type)
     select $1, 'INCOME', greatest(1, (t.amount_cents * (0.3 + random() * 0.7))::bigint), 'Devolución',
            least(t.occurred_on + floor(random() * 20)::int, current_date),
            case when random() < 0.3 then $2::uuid else t.account_id end,
            'MANUAL', 'CONFIRMED', t.id, 'EXPENSE'
     from public.transaction t
     where t.user_id = $1 and t.type = 'EXPENSE' and t.status = 'CONFIRMED' and random() < 0.01`,
    [uid, bancos[0]],
  );

  // Traspasos semanales entre cuentas de dinero
  await q(
    `insert into public.transaction (user_id, type, amount_cents, description, occurred_on, account_id, to_account_id, source, status)
     select $1, 'TRANSFER', (random() * 100000)::bigint + 1000, 'Traspaso', w::date, $3,
            ($4::uuid[])[1 + floor(random() * array_length($4::uuid[], 1))::int], 'MANUAL', 'CONFIRMED'
     from generate_series($2::date, current_date, interval '7 days') w`,
    [uid, ini, bancos[0], noInversion.filter((x) => x !== bancos[0])],
  );

  // Instrumentos con precios diarios (días hábiles) y uno en USD con su cambio.
  const instrumentos = [];
  for (let i = 0; i < c.fondos; i++) {
    const usd = perfil === "intenso" && i === c.fondos - 1;
    const [{ id }] = await q(
      `insert into public.instrument (kind, yahoo_symbol, name, currency)
       values ($1, $2, $3, $4) returning id::text as id`,
      [["FONDO", "ETF", "ACCION"][i % 3], `ZZBENCH-${perfil.slice(0, 3)}${i}`, `Bench ${perfil} ${i}`, usd ? "USD" : "EUR"],
    );
    await q(
      `insert into public.instrument_price (instrument_id, date, close)
       select $1, d::date, round((50 + 30 * $3 + 10 * sin(row_number() over (order by d) / 40.0)
                                  + row_number() over (order by d) * 0.01 + random())::numeric, 6)
       from generate_series($2::date - 10, current_date - 1, interval '1 day') d
       where extract(isodow from d) < 6`,
      [id, ini, i],
    );
    instrumentos.push({ id, usd });
  }
  if (instrumentos.some((x) => x.usd)) {
    await q(
      `insert into public.fx_rate (currency, date, rate)
       select 'USD', d::date, round((1.10 + 0.08 * sin(row_number() over (order by d) / 90.0))::numeric, 8)
       from generate_series(greatest($1::date - 10, date '1999-01-04'), current_date - 1, interval '1 day') d
       where extract(isodow from d) < 6
       on conflict (currency, date) do nothing`,
      [ini],
    );
  }

  // Posiciones: las sincronizadas (ALTA con instrumento) y una manual con valoraciones.
  const posiciones = [];
  for (let i = 0; i < c.fondos; i++) {
    const [{ id }] = await q(
      `insert into public.investment_position (user_id, name, account_id, since)
       values ($1, $2, $3, $4::date) returning id::text as id`,
      [uid, `Fondo ${i + 1}`, inversion[i % inversion.length], ini],
    );
    await q(
      `insert into public.position_unit_event (user_id, position_id, kind, date, instrument_id, units, contributed_cents)
       values ($1, $2, 'ALTA', $3::date + 2, $4, 100, 500000)`,
      [uid, id, ini, instrumentos[i].id],
    );
    posiciones.push({ id, cuenta: inversion[i % inversion.length] });
  }
  const [{ id: manual }] = await q(
    `insert into public.investment_position (user_id, name, account_id, since)
     values ($1, 'Plan de pensiones', $2, $3::date) returning id::text as id`,
    [uid, inversion[0], ini],
  );
  await q(
    `insert into public.valuation (user_id, position_id, date, value_cents)
     select $1, $2, (m + interval '1 month' - interval '1 day')::date, (row_number() over (order by m)) * 21000
     from generate_series(date_trunc('month', $3::date), date_trunc('month', current_date) - interval '1 month', interval '1 month') m`,
    [uid, manual, ini],
  );
  posiciones.push({ id: manual, cuenta: inversion[0] });

  // Aportaciones mensuales a cada posición: la mitad con participaciones, la otra estimadas.
  for (const p of posiciones) {
    await q(
      `insert into public.transaction (user_id, type, amount_cents, description, occurred_on, account_id, to_account_id,
         position_id, position_units, source, status)
       select $1, 'TRANSFER', 20000, 'Aportación', (m + interval '4 days')::date, $3, $4, $5,
              case when random() < 0.5 then round((random() * 3 + 1)::numeric, 8) end, 'MANUAL', 'CONFIRMED'
       from generate_series(date_trunc('month', $2::date) + interval '1 month', current_date - 5, interval '1 month') m`,
      [uid, ini, bancos[0], p.cuenta, p.id],
    );
  }

  // Suscripciones con sus cargos pasados (día ≤ 28: sin recortes de fin de mes).
  const subs = await q(
    `insert into public.subscription (user_id, description, amount_cents, periodicity, next_charge_date, started_at,
       category_id, category_type, account_id)
     select $1, 'Suscripción ' || g, 500 + (random() * 5000)::bigint,
            (case when g % 7 = 0 then 'ANUAL' when g % 5 = 0 then 'TRIMESTRAL' else 'MENSUAL' end)::public.periodicity,
            current_date + 1 + (g % 27), ($2::date + (g * 37) % 300), $3, 'EXPENSE', $4
     from generate_series(1, $5) g
     returning id::text as id, periodicity::text as p, started_at::text as s`,
    [uid, ini, gastoCats[3], bancos[0], c.subs],
  );
  for (const s of subs) {
    const paso = { MENSUAL: "1 month", TRIMESTRAL: "3 months", ANUAL: "1 year" }[s.p];
    await q(
      `insert into public.transaction (user_id, type, amount_cents, description, occurred_on, account_id, category_id,
         category_type, source, status, subscription_id)
       select $1, 'EXPENSE', s.amount_cents, s.description, d::date, s.account_id, s.category_id, 'EXPENSE',
              'RECURRING', 'CONFIRMED', s.id
       from public.subscription s, generate_series(s.started_at, current_date, $3::interval) d
       where s.id = $2`,
      [uid, s.id, paso],
    );
  }

  // Límites, metas y reglas
  await q(
    `insert into public.budget (user_id, category_id, monthly_cap_cents, rollover_unspent)
     select $1, c, 20000 + (o * 7000), o % 4 = 0 from unnest($2::uuid[]) with ordinality as x(c, o) where o <= $3`,
    [uid, gastoCats, c.limites],
  );
  const metaCuentas = [de("AHORRO")[0], inversion[0], bancos[1] ?? bancos[0]].slice(0, c.metas).filter(Boolean);
  for (const [i, cta] of metaCuentas.entries()) {
    await q(
      "insert into public.savings_goal (user_id, name, target_cents, account_id, deadline) values ($1, $2, $3, $4, current_date + 400)",
      [uid, `Meta ${i + 1}`, 5_000_000, cta],
    );
  }
  await q(
    `insert into public.merchant_rule (user_id, match_text, category_id, category_type)
     select $1, m, ($2::uuid[])[1 + (o % array_length($2::uuid[], 1))::int], 'EXPENSE'
     from unnest($3::text[]) with ordinality as x(m, o) where o <= $4`,
    [uid, gastoCats, COMERCIOS, c.reglas],
  );

  // Préstamos, con la función de verdad (genera el desembolso y las cuotas vencidas).
  const prestamos = [];
  if (c.prestamos) {
    await comoUsuario(uid, async () => {
      const crear = (nombre, principal, plazo, tin, inicioAnios, dia) =>
        q(
          `select public.create_loan($1, $2, $3, $4, $5::numeric, null, 0, $6,
             (current_date - make_interval(years => $7))::date, null, true) as r`,
          [nombre, bancos[0], principal, plazo, tin, dia, inicioAnios],
        ).then((r) => r[0].r);
      prestamos.push(await crear("Hipoteca", 25_000_000, 360, "2.5", 8, 5));
      prestamos.push(await crear("Coche", 3_000_000, 84, "6.5", 3, 28));
    });
  }

  // Una cuenta archivada CON saldo (la última de banco): sigue contando en el patrimonio.
  const archivada = bancos[bancos.length - 1];
  await q(
    `insert into public.transaction (user_id, type, amount_cents, description, occurred_on, account_id, source, status)
     values ($1, 'INCOME', 123456, 'Saldo que se queda', $2::date + 30, $3, 'MANUAL', 'CONFIRMED')`,
    [uid, ini, archivada],
  );
  await q("update public.account set archived = true, archived_at = now() where id = $1", [archivada]);

  const [cuenta] = await q(
    `select count(*)::int as movimientos,
            count(*) filter (where type = 'EXPENSE')::int as gastos,
            count(*) filter (where loan_id is not null)::int as de_prestamo
     from public.transaction where user_id = $1`,
    [uid],
  );
  const [precios] = await q(
    "select count(*)::int as n from public.instrument_price where instrument_id = any($1::uuid[])",
    [instrumentos.map((x) => x.id)],
  );
  console.log(
    `  ${etiqueta}: ${cuenta.movimientos} movimientos (${cuenta.gastos} gastos, ${cuenta.de_prestamo} de préstamo), ` +
      `${cuentas.length + prestamos.length} cuentas, ${posiciones.length} posiciones, ${precios.n} precios, ` +
      `${subs.length} suscripciones — ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );

  return {
    uid, ini, bancos, inversion, gastoCats, posiciones, prestamos, archivada,
    movimientos: cuenta.movimientos,
    cuentaGrande: bancos[0],
    categoriaGrande: gastoCats[0],
  };
}

// --------------------------------------------------------------------------
// Las consultas de cada pantalla (las mismas que hace src/app)
// --------------------------------------------------------------------------
function consultas(s, f) {
  const prestamo = s.prestamos[0]?.loan_id ?? "00000000-0000-0000-0000-000000000000";
  const posicion = s.posiciones[0].id;
  return [
    // Armazón (cada navegación)
    ["layout: pendientes (count)", "select count(*) from public.transaction where status = 'PENDING'"],
    ["layout: cuentas (count)", "select count(*) from public.account"],
    // Resumen
    ["resumen: v_month_summary 13", "select * from public.v_month_summary order by period_month desc limit 13"],
    ["resumen: category_breakdown", "select * from public.category_breakdown($1)", [f.mes]],
    ["resumen: month_pace", "select * from public.month_pace($1)", [f.mes]],
    ["resumen: category_comparison", "select * from public.category_comparison($1)", [f.mes]],
    ["resumen: últimos 5", "select * from public.transaction where status <> 'DISCARDED' order by occurred_on desc, occurred_time desc limit 5"],
    ["resumen: sin clasificar (count histórico)", "select count(*) from public.transaction where type = 'EXPENSE' and status <> 'DISCARDED' and category_id is null"],
    ["resumen: month_forecast", "select * from public.month_forecast($1)", [f.mes]],
    ["resumen: category_forecast", "select * from public.category_forecast($1)", [f.mes]],
    ["resumen: pending_recurring_income", "select public.pending_recurring_income($1)", [f.mes]],
    ["resumen: budget_status", "select * from public.budget_status($1)", [f.mes]],
    // Cuentas
    ["cuentas: v_account_balance", "select * from public.v_account_balance order by archived, name"],
    ["cuentas: v_account_worth", "select account_id, worth_cents from public.v_account_worth"],
    ["cuentas: v_position_value activas", "select account_id, value_cents from public.v_position_value where archived = false"],
    ["cuentas: account_card_spend", "select * from public.account_card_spend($1)", [f.mes]],
    ["cuentas: account_balance_monthly(12)", "select * from public.account_balance_monthly(12)"],
    ["cuentas: v_loan_status", "select loan_id, liability_account_id, paid_count, term_months, status from public.v_loan_status"],
    // Patrimonio
    ["patrimonio: v_net_worth", "select * from public.v_net_worth"],
    ["patrimonio: net_worth_monthly(24) [1A]", "select * from public.net_worth_monthly(24)"],
    ["patrimonio: net_worth_monthly(120) [Todo]", "select * from public.net_worth_monthly(120)"],
    ["patrimonio: net_worth_daily 3M+previo", "select * from public.net_worth_daily($1, $2)", [f.previo3m, f.hoy]],
    ["patrimonio: primer movimiento", "select occurred_on::text as primero from public.transaction where status <> 'DISCARDED' order by occurred_on limit 1"],
    ["patrimonio: monthly_savings(12)", "select * from public.monthly_savings(12)"],
    ["patrimonio: yearly_close", "select * from public.yearly_close()"],
    ["patrimonio: account_balance_monthly(2)", "select * from public.account_balance_monthly(2)"],
    // Inversiones
    ["inversiones: v_position_value", "select * from public.v_position_value order by value_cents desc"],
    ["inversiones: valoraciones previas", "select position_id, date::text, value_cents from public.valuation where date < $1", [f.mes]],
    ["inversiones: position_return [Todo]", "select * from public.position_return($1, $2)", [f.desdeTodo, f.hoy]],
    ["inversiones: portfolio_return [Todo]", "select * from public.portfolio_return($1, $2)", [f.desdeTodo, f.hoy]],
    ["inversiones: position_performance [Todo]", "select * from public.position_performance($1, $2)", [f.desdeTodo, f.hoy]],
    ["inversiones: position_performance [6M]", "select * from public.position_performance($1, $2)", [f.desde6m, f.hoy]],
    ["inversiones: position_performance [Año, por defecto]", "select * from public.position_performance($1, $2)", [f.desdeAnio, f.hoy]],
    ["inversiones: v_pending_valuation", "select * from public.v_pending_valuation"],
    ["inversiones: v_position_market", "select position_id, value_cents, units::text, price::text, gain_cents, return_pct from public.v_position_market where archived = false"],
    ["inversiones: aportaciones", "select id, position_id, occurred_on::text, amount_cents from public.transaction where position_id is not null and type = 'TRANSFER' and status <> 'DISCARDED' order by occurred_on"],
    // Análisis
    ["análisis: category_avg_6m", "select * from public.category_avg_6m($1)", [f.mes]],
    ["análisis: month_findings", "select * from public.month_findings($1)", [f.mes]],
    ["análisis: v_closed_months 24", "select * from public.v_closed_months order by period_month desc limit 24"],
    ["análisis: year_over_year(12)", "select * from public.year_over_year($1, 12)", [f.mes]],
    ["análisis: category_trend(12)", "select * from public.category_trend($1, 12)", [f.mes]],
    ["análisis: merchant_spend", "select * from public.merchant_spend($1, $2, 8)", [f.mes, f.finMes]],
    ["análisis: spend_heatmap 90 d", "select * from public.spend_heatmap($1, $2)", [f.hace90, f.hoy]],
    ["análisis: month_changes", "select * from public.month_changes($1)", [f.mes]],
    // Movimientos
    ["movimientos: unclassified_by_month(6)", "select * from public.unclassified_by_month(6)"],
    ["movimientos: search mes", "select * from public.search_transactions($1, $2, null, null, null, false, false, false, null, 100)", [f.mes, f.finMes]],
    ["movimientos: search todo, texto", "select * from public.search_transactions(null, null, null, null, null, false, false, false, 'merca', 100)"],
    ["movimientos: search todo, 5000 filas", "select * from public.search_transactions(null, null, null, null, null, false, false, false, null, 5000)"],
    ["movimientos: search por cuenta, todo", "select * from public.search_transactions(null, null, null, $1, null, false, false, false, null, 100)", [s.cuentaGrande]],
    ["movimiento: category_context", "select * from public.category_context($1, $2, 6)", [s.categoriaGrande, f.mes]],
    ["reglas: v_rule_suggestions", "select * from public.v_rule_suggestions"],
    ["reglas: preview_merchant_rule", "select * from public.preview_merchant_rule('mercadona')"],
    // Fijos
    ["fijos: v_subscription_summary", "select * from public.v_subscription_summary order by description"],
    ["fijos: upcoming_charges(60)", "select * from public.upcoming_charges(60)"],
    ["fijos: commitment_history(12)", "select * from public.commitment_history(12)"],
    ["fijos: commitment_by_subscription(12)", "select * from public.commitment_by_subscription(12)"],
    ["fijos: upcoming_income(60)", "select * from public.upcoming_income(60)"],
    ["fijos: income_breakdown", "select * from public.income_breakdown($1)", [f.mes]],
    // Préstamos
    ["préstamos: v_loan_status (todo)", "select * from public.v_loan_status"],
    ["préstamos: loan_schedule (hipoteca)", "select * from public.loan_schedule($1)", [prestamo]],
    // Metas
    ["metas: v_savings_goal_progress", "select * from public.v_savings_goal_progress"],
    ["metas: savings_goal_projection(6)", "select * from public.savings_goal_projection(6)"],
    // Exportar (todo el histórico de movimientos)
    ["exportar: movimientos", "select * from public.transaction order by occurred_on"],
    // Borrado: las vistas previas
    ["borrar: account_delete_preview", "select public.account_delete_preview($1)", [s.cuentaGrande]],
    ["borrar: position_delete_preview", "select public.position_delete_preview($1)", [posicion]],
    ["borrar: loan_delete_preview", "select public.loan_delete_preview($1)", [prestamo]],
    // Generadores (al abrir Fijos/Préstamos)
    ["generar: suscripciones", "select public.generate_subscription_charges()", [], { escribe: true }],
    ["generar: cuotas de préstamo", "select public.generate_loan_installments()", [], { escribe: true }],
  ];
}

/** Las acciones de borrado, ejecutadas de verdad dentro de un savepoint que se deshace. */
async function borrados(s) {
  const nombres = await q(
    "select (select name from public.account where id = $1) as cuenta, (select name from public.investment_position where id = $2) as fondo",
    [s.bancos[1], s.posiciones[0].id],
  );
  const lista = [
    ["borrar: delete_position (fondo con 10 años)", "select public.delete_position($1, $2)", [s.posiciones[0].id, nombres[0].fondo]],
  ];
  if (s.prestamos[0]) {
    const [l] = await q("select name from public.loan where id = $1", [s.prestamos[0].loan_id]);
    lista.push(["borrar: delete_loan (hipoteca)", "select public.delete_loan($1, $2)", [s.prestamos[0].loan_id, l.name]]);
  }
  // La segunda cuenta de banco: con miles de movimientos y sin préstamo (la principal paga los
  // préstamos y su borrado lo impide la FK loan_payment_account_fk, ver test-casos-limite.mjs).
  lista.push(["borrar: delete_account (cuenta con miles de movs.)", "select public.delete_account($1, $2)", [s.bancos[1], nombres[0].cuenta]]);
  return lista;
}

// --------------------------------------------------------------------------
// Medición
// --------------------------------------------------------------------------
const textoDe = (plan) => {
  const lineas = plan.split("\n");
  const i = lineas.findIndex((l) => l.startsWith("Query Text:"));
  if (i < 0) return "";
  return [lineas[i].slice(11), ...lineas.slice(i + 1, i + 4)].join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
};

function resumirPlanes(textos, sql) {
  // Del texto de auto_explain: duración de cada sentencia, seq scans con sus
  // bucles, y la sentencia anidada más cara. La de nivel superior es la que
  // trae el texto de la consulta enviada (las anidadas se registran antes).
  const sentencias = textos
    .map((t) => {
      const m = t.match(/^duration: ([\d.]+) ms/);
      return m ? { ms: Number(m[1]), texto: t } : null;
    })
    .filter(Boolean);
  const cabeza = sql.replace(/\s+/g, " ").slice(0, 40);
  const arriba = sentencias.find((s) => textoDe(s.texto).startsWith(cabeza));
  const total = arriba ? arriba.ms : sentencias.length ? Math.max(...sentencias.map((s) => s.ms)) : null;
  const anidadas = sentencias.filter((s) => s !== arriba).sort((a, b) => b.ms - a.ms);
  const seq = new Map();
  for (const s of sentencias) {
    for (const m of s.texto.matchAll(/Seq Scan on (\w+)[^\n]*?actual time=[\d.]+\.\.([\d.]+) rows=(\d+) loops=(\d+)/g)) {
      const k = m[1];
      const prev = seq.get(k) ?? { loops: 0, ms: 0 };
      prev.loops += Number(m[4]);
      prev.ms = Math.max(prev.ms, Number(m[2]) * Number(m[4]));
      seq.set(k, prev);
    }
  }
  const bucles = [];
  for (const s of sentencias) {
    for (const m of s.texto.matchAll(/->\s+([A-Z][\w ]+?)\s+(?:on (\w+)\s+)?[^\n]*?actual time=[\d.]+\.\.([\d.]+) rows=\d+ loops=(\d+)/g)) {
      const loops = Number(m[4]);
      if (loops >= 500) bucles.push({ nodo: `${m[1]}${m[2] ? ` on ${m[2]}` : ""}`, loops, ms: Math.round(Number(m[3]) * loops) });
    }
  }
  bucles.sort((a, b) => b.ms - a.ms);
  return {
    servidorMs: total,
    nAnidadas: anidadas.length,
    anidadaMax: anidadas[0] ? { ms: anidadas[0].ms, texto: textoDe(anidadas[0].texto) } : null,
    seqScans: [...seq.entries()].map(([t, v]) => `${t}×${v.loops}`).join(", "),
    buclesCaros: bucles.slice(0, 3).map((b) => `${b.nodo} ×${b.loops} (~${b.ms} ms)`).join("; "),
  };
}

async function medir(uid, nombre, sql, params = [], { escribe = false } = {}) {
  // 1) Una pasada con auto_explain (planes anidados, con tiempos reales). Los
  //    parámetros de auto_explain solo los puede fijar el rol de la conexión,
  //    así que se fijan ANTES de pasar a `authenticated`; el savepoint deshace
  //    todo (rol, parámetros y lo que la consulta escriba).
  await q("savepoint m");
  await q("set local auto_explain.log_min_duration = 0");
  await q("set local auto_explain.log_analyze = on");
  await q("set local auto_explain.log_buffers = on");
  await q("set local auto_explain.log_nested_statements = on");
  await q("set local auto_explain.log_level = notice");
  await q("set local client_min_messages = notice");
  await q("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
  ]);
  await q("set local role authenticated");
  avisos = [];
  let error = null;
  let filas = 0;
  try {
    filas = (await client.query(sql, params)).rowCount;
  } catch (e) {
    error = `${e.code} ${e.message}`;
  }
  const planes = avisos.slice();
  await q("rollback to savepoint m");
  await q("release savepoint m");

  // 2) Repeticiones cronometradas sin instrumentar (en savepoint si escribe).
  const tiempos = [];
  if (!error) {
    await comoUsuario(uid, async () => {
      for (let i = 0; i < REPS; i++) {
        if (escribe) await q("savepoint r");
        const t = process.hrtime.bigint();
        await client.query(sql, params);
        tiempos.push(Number(process.hrtime.bigint() - t) / 1e6);
        if (escribe) {
          await q("rollback to savepoint r");
          await q("release savepoint r");
        }
      }
    });
  }
  tiempos.sort((a, b) => a - b);
  return { nombre, filas, error, relojMs: tiempos.length ? tiempos[Math.floor(tiempos.length / 2)] : null, planes, ...resumirPlanes(planes, sql) };
}

/** Las cifras que una propuesta de rendimiento NO puede cambiar (texto, para comparar exacto). */
async function huella(s, f) {
  const consultasHuella = {
    v_position_value: ["select * from public.v_position_value order by position_id"],
    v_position_market: ["select * from public.v_position_market order by position_id"],
    v_net_worth: ["select * from public.v_net_worth"],
    v_account_worth: ["select * from public.v_account_worth order by account_id"],
    net_worth_daily: ["select * from public.net_worth_daily($1, $2)", [f.previo3m, f.hoy]],
    net_worth_monthly: ["select * from public.net_worth_monthly(120)"],
    account_balance_monthly: ["select * from public.account_balance_monthly(12)"],
    position_return: ["select * from public.position_return($1, $2) order by position_id", [f.desdeTodo, f.hoy]],
    portfolio_return: ["select * from public.portfolio_return($1, $2)", [f.desdeTodo, f.hoy]],
    position_performance_6m: ["select * from public.position_performance($1, $2)", [f.desde6m, f.hoy]],
    position_performance_todo: ["select * from public.position_performance($1, $2)", [f.desdeTodo, f.hoy]],
    savings_goal_projection: ["select * from public.savings_goal_projection(6)"],
    search_mes: ["select * from public.search_transactions($1, $2, null, null, null, false, false, false, null, 100000)", [f.mes, f.finMes]],
    search_texto: ["select * from public.search_transactions(null, null, null, null, null, false, false, false, 'merca', 100000)"],
    search_categoria: ["select * from public.search_transactions(null, null, null, null, null, false, false, false, 'Gasto 0', 100000)"],
    search_cuenta: ["select * from public.search_transactions(null, null, null, null, null, false, false, false, 'Bench BANCO', 100000)"],
    search_todo: ["select * from public.search_transactions(null, null, null, null, null, false, false, false, null, 100000)"],
  };
  const r = {};
  await comoUsuario(s.uid, async () => {
    for (const [k, [sql, params]] of Object.entries(consultasHuella)) {
      // Ordenadas aquí: los empates de orden (mismo created_at) no son diferencias.
      r[k] = (await q(sql, params ?? [])).map((x) => JSON.stringify(x)).sort().join("|");
    }
  });
  return r;
}

async function fechas(s) {
  const [f] = await q(
    `select current_date::text as hoy,
            date_trunc('month', current_date)::date::text as mes,
            (date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date::text as "finMes",
            (current_date - 89)::text as hace90,
            ((current_date - interval '3 months')::date + 1 - ((current_date - ((current_date - interval '3 months')::date + 1)) + 1))::text as previo3m,
            ($1::date - 1)::text as "desdeTodo",
            (current_date - interval '6 months')::date::text as desde6m,
            date_trunc('year', current_date)::date::text as "desdeAnio"`,
    [s.ini],
  );
  return f;
}

async function main() {
  await client.connect();
  await q("begin");
  const resultados = {};
  try {
    await q("set local statement_timeout = '15min'");
    // RTT de referencia
    const rtt = [];
    for (let i = 0; i < 5; i++) {
      const t = process.hrtime.bigint();
      await q("select 1");
      rtt.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    rtt.sort((a, b) => a - b);
    console.log(`Ida y vuelta de red (select 1, mediana): ${rtt[2].toFixed(1)} ms\n`);
    console.log("— Siembra (dentro de la transacción) —");
    const TABLAS_TAM = ["transaction", "instrument_price", "fx_rate", "valuation", "position_unit_event", "account", "category"];
    const tamanos = () =>
      q(
        `select c.relname, pg_total_relation_size(c.oid)::bigint as b
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1)`,
        [TABLAS_TAM],
      ).then((r) => new Map(r.map((x) => [x.relname, Number(x.b)])));
    const tamAntes = await tamanos();
    const filasAntes = await q("select (select count(*) from public.transaction)::int as t, (select count(*) from public.instrument_price)::int as p");
    const sembrados = {};
    for (const p of PERFILES) sembrados[p] = await sembrar(p, p);
    // Lo que ocupa lo sembrado (tabla + índices + TOAST), por fila: base de la
    // estimación de crecimiento del informe. Las filas sembradas aún no se han
    // borrado, así que el aumento de tamaño es suyo.
    const tamDespues = await tamanos();
    const filasDespues = await q("select (select count(*) from public.transaction)::int as t, (select count(*) from public.instrument_price)::int as p");
    const dT = filasDespues[0].t - filasAntes[0].t;
    const dP = filasDespues[0].p - filasAntes[0].p;
    const kb = (t) => ((tamDespues.get(t) - tamAntes.get(t)) / 1024).toFixed(0);
    console.log(
      `  Tamaño sembrado: transaction +${kb("transaction")} kB (${dT} filas, ` +
        `${((tamDespues.get("transaction") - tamAntes.get("transaction")) / dT).toFixed(0)} B/fila con índices); ` +
        `instrument_price +${kb("instrument_price")} kB (${dP} filas, ` +
        `${((tamDespues.get("instrument_price") - tamAntes.get("instrument_price")) / dP).toFixed(0)} B/fila con índices)`,
    );
    if (ANALIZAR) {
      const t = Date.now();
      for (const tabla of ["transaction", "account", "category", "card", "instrument", "instrument_price", "fx_rate",
        "investment_position", "position_unit_event", "valuation", "subscription", "recurring_income", "budget",
        "savings_goal", "merchant_rule", "loan"]) {
        await q(`analyze public.${tabla}`);
      }
      console.log(`  ANALYZE de las tablas sembradas: ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }

    if (PROPUESTAS.length) {
      // Las cifras ANTES, la propuesta aplicada dentro de la transacción, y las
      // cifras DESPUÉS: tienen que ser idénticas, fila a fila.
      const antes = {};
      if (!SIN_HUELLA) for (const p of PERFILES) antes[p] = await huella(sembrados[p], await fechas(sembrados[p]));
      for (const fichero of PROPUESTAS) {
        await client.query(readFileSync(fichero, "utf8"));
        console.log(`\n  Propuesta aplicada (dentro de la transacción): ${fichero}`);
      }
      await q("analyze public.transaction");
      for (const p of SIN_HUELLA ? [] : PERFILES) {
        const despues = await huella(sembrados[p], await fechas(sembrados[p]));
        const distintas = Object.keys(antes[p]).filter((k) => antes[p][k] !== despues[k]);
        console.log(
          distintas.length === 0
            ? `  ${p}: las ${Object.keys(despues).length} consultas de la huella dan EXACTAMENTE lo mismo`
            : `  ${p}: ¡DISTINTAS! ${distintas.join(", ")}`,
        );
        if (distintas.length) process.exitCode = 1;
      }
    }

    for (const p of PERFILES) {
      const s = sembrados[p];
      const f = await fechas(s);
      console.log(`\n— Mediciones: perfil ${p} (${s.movimientos} movimientos) —\n`);
      const lista = [...consultas(s, f), ...(await borrados(s)).map((x) => [...x, { escribe: true }])].filter(
        ([nombre]) => !SOLO || nombre.includes(SOLO),
      );
      resultados[p] = [];
      for (const [nombre, sql, params, opts] of lista) {
        const r = await medir(s.uid, nombre, sql, params ?? [], opts ?? {});
        resultados[p].push(r);
        console.log(
          `${r.error ? "ERR " : "    "}${nombre.padEnd(46)} servidor ${String(r.servidorMs?.toFixed(1) ?? "-").padStart(8)} ms` +
            `  reloj ${String(r.relojMs?.toFixed(1) ?? "-").padStart(8)} ms  filas ${String(r.filas).padStart(6)}` +
            (r.seqScans ? `  seq: ${r.seqScans}` : "") +
            (r.error ? `\n        ${r.error}` : ""),
        );
        if (r.buclesCaros) console.log(`        bucles: ${r.buclesCaros}`);
        if (r.anidadaMax && r.anidadaMax.ms > 50) console.log(`        anidada más cara ${r.anidadaMax.ms.toFixed(1)} ms: ${r.anidadaMax.texto}`);
      }
    }
  } finally {
    await q("rollback").catch(() => {});
    await client.end();
  }

  if (SALIDA) {
    mkdirSync(SALIDA, { recursive: true });
    const json = {};
    for (const [p, filas] of Object.entries(resultados)) {
      json[p] = filas.map((r) => ({ ...r, planes: undefined }));
      const texto = filas
        .map((r) => `######## ${r.nombre}\n${r.error ?? ""}\n${r.planes.join("\n\n")}`)
        .join("\n\n");
      writeFileSync(join(SALIDA, `planes-${p}.txt`), texto);
    }
    writeFileSync(join(SALIDA, "resultados.json"), JSON.stringify(json, null, 1));
    console.log(`\nPlanes y resultados en ${SALIDA}`);
  }

  // Tabla comparativa en Markdown (servidor; reloj entre paréntesis).
  if (resultados.normal && resultados.intenso) {
    console.log("\n| Consulta | Normal ms | Intenso ms | × |\n|---|---:|---:|---:|");
    for (const r of resultados.intenso) {
      const a = resultados.normal.find((x) => x.nombre === r.nombre);
      const x = a?.servidorMs && r.servidorMs ? (r.servidorMs / a.servidorMs).toFixed(1) : "-";
      console.log(`| ${r.nombre} | ${a?.servidorMs?.toFixed(1) ?? "-"} | ${r.servidorMs?.toFixed(1) ?? (r.error ? "ERROR" : "-")} | ${x} |`);
    }
  }
}

main().catch(async (e) => {
  console.error(e);
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
  process.exit(2);
});
