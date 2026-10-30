/**
 * Prueba de los préstamos:
 *   20261013090000_tipo_de_cuenta_prestamo.sql  (enum PRESTAMO)
 *   20261013090100_prestamos.sql                (loan, cuadro, generación, vistas)
 *   20261013090200_prevision_con_prestamos.sql  (previsión del mes)
 *
 *   node --env-file=.env.local scripts/test-prestamos.mjs
 *   DATABASE_URL=postgres://…@localhost:…/db node scripts/test-prestamos.mjs   (réplica local)
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): las
 * migraciones que falten se aplican ahí dentro, los usuarios de prueba se
 * insertan en auth.users ahí dentro, y no persiste nada.
 *
 * Bloques:
 *   1. DATOS REALES. Antes y después de aplicar las migraciones, las cifras de
 *      cada usuario (saldos, patrimonio y sus curvas, meses, reparto, límites,
 *      previsión) son IDÉNTICAS, y su deuda es 0. No se imprime ninguna cifra.
 *   2. AUDITORÍA del esquema (RLS, security_invoker, search_path, FK con
 *      user_id) con los objetos nuevos ya creados.
 *   3. EL CUADRO, AL CÉNTIMO. src/lib/prestamos.ts contra public.loan_plan y
 *      public.loan_tae en una rejilla de casos, más casos calculados a mano.
 *   4. FUNCIONAL (necesita el valor PRESTAMO ya CONFIRMADO en la base: Postgres
 *      no deja usar un valor de enum añadido en la misma transacción). Contra
 *      producción antes de aplicar la migración del enum, este bloque se
 *      OMITE y lo dice; se corre contra una réplica local con las 49
 *      migraciones + el enum confirmado.
 *
 * Las fechas se piden con ::text: el driver pg convierte un `date` a medianoche
 * local y toISOString() daría el día anterior.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import {
  comisionPorPorcentaje,
  cuadroAmortizacion,
  leerTipo,
  primeraCuotaPorDefecto,
  resumenPrestamo,
  sumarMeses,
  taeCalculada,
  tipoComoDecimal,
} from "../src/lib/prestamos.ts";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const leer = (f) => readFileSync(join(raiz, "supabase", "migrations", f), "utf8");
const MIG_ENUM = "20261013090000_tipo_de_cuenta_prestamo.sql";
const MIG_PRESTAMOS = "20261013090100_prestamos.sql";
const MIG_PREVISION = "20261013090200_prevision_con_prestamos.sql";

const url = process.env.DATABASE_URL ?? "";
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? false : sslDb });
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
const n = (v) => (v === null || v === undefined ? null : Number(v));

let ok = 0;
let mal = 0;
let omitidas = 0;
function check(nombre, condicion, detalle = "") {
  if (condicion) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    mal++;
    console.log(`  FALLO ${nombre}${detalle ? `\n        ${detalle}` : ""}`);
  }
}

async function comoUsuario(uid, trabajo, aal = "aal2") {
  await q("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal }),
  ]);
  await q("set local role authenticated");
  try {
    return await trabajo();
  } finally {
    await q("reset role").catch(() => {});
  }
}

async function comoServicio(trabajo) {
  await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
  await q("set local role service_role");
  try {
    return await trabajo();
  } finally {
    await q("reset role").catch(() => {});
  }
}

/** En un savepoint que se deshace pase lo que pase. Devuelve el error o null. */
async function intento(trabajo, { uid = null, aal = "aal2", rol = null } = {}) {
  await q("savepoint intento");
  let error = null;
  try {
    if (uid) {
      await q("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: uid, role: "authenticated", aal }),
      ]);
      await q("set local role authenticated");
    } else if (rol) {
      await q("select set_config('request.jwt.claims', '', true)");
      await q(`set local role ${rol}`);
    }
    await trabajo();
  } catch (e) {
    error = e;
  }
  await q("rollback to savepoint intento");
  await q("release savepoint intento");
  return error;
}

// --------------------------------------------------------------------------
// 1. Datos reales: la huella de cifras de un usuario
// --------------------------------------------------------------------------
async function cifras(uid, hoy) {
  return comoUsuario(uid, async () => {
    const r = {};
    r.saldos = await q("select account_id::text, balance_cents::text from public.v_account_balance order by 1");
    r.valor = await q("select account_id::text, worth_cents::text from public.v_account_worth order by 1");
    r.patrimonio = await q(
      "select net_worth_cents::text, cash_cents::text, invested_cents::text, idle_cents::text from public.v_net_worth",
    );
    r.meses = await q(
      "select period_month::text, income_cents::text, net_expense_cents::text, month_balance_cents::text, gross_expense_cents::text from public.v_month_summary order by 1",
    );
    r.reparto = await q("select category_id::text, net_cents::text from public.category_breakdown($1::date) order by 1", [hoy]);
    r.mensual = await q(
      "select period_month::text, net_worth_cents::text, cash_cents::text, invested_cents::text, idle_cents::text from public.net_worth_monthly(36)",
    );
    r.diario = await q(
      "select fecha::text, net_worth_cents::text, cash_cents::text, invested_cents::text, idle_cents::text from public.net_worth_daily($1::date - 95, $1::date)",
      [hoy],
    );
    r.historia = await q("select period_month::text, net_worth_cents::text from public.net_worth_history(24)");
    r.prevision = await q("select * from public.month_forecast($1::date)", [hoy]);
    r.prevCat = await q("select category_id::text, gastado_cents::text, prevision_cents::text, rebasa from public.category_forecast($1::date) order by 1", [hoy]);
    r.limites = await q("select category_id::text, spent_cents::text, effective_cap_cents::text from public.budget_status($1::date) order by 1", [hoy]);
    return JSON.stringify(r);
  });
}

// --------------------------------------------------------------------------
// 2. Auditoría (las mismas comprobaciones que scripts/audit-db.mjs)
// --------------------------------------------------------------------------
async function auditoria() {
  console.log("\n— Auditoría del esquema con los objetos nuevos —\n");
  const comprobaciones = [
    ["RLS activada y forzada en toda tabla de public", `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and (not c.relrowsecurity or not c.relforcerowsecurity)`],
    ["Toda vista con security_invoker", `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
        and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), 'false') <> 'true'`],
    ["Toda función security definer fija search_path", `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) cfg where cfg like 'search_path=%')`],
    ["Ninguna función nueva es security definer", `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.prosecdef and (p.proname like '%loan%')`],
    ["Toda función nueva fija search_path", `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.proname like '%loan%'
        and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) cfg where cfg = 'search_path=""')`],
    ["Ningún saldo almacenado", `select c.relname || '.' || a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
        and (a.attname ~ '^balance' or (c.relname = 'loan' and a.attname ~ 'pending|balance|saldo'))`],
    ["Toda FK a tabla de usuario lleva user_id", `with fk as (
        select con.conname, con.confrelid::regclass::text as referencia,
               array(select attname from pg_attribute where attrelid = con.conrelid and attnum = any(con.conkey)) as cols
        from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
        where con.contype = 'f' and n.nspname = 'public')
      select conname from fk where referencia not in ('auth.users') and not ('user_id' = any(cols))
        -- Los catálogos compartidos (instrument…) no tienen user_id: no son tablas de usuario.
        and exists (select 1 from pg_attribute a where a.attrelid = referencia::regclass and a.attname = 'user_id' and not a.attisdropped)
        and conname not in ('ingest_bucket_device_id_fkey', 'ingest_dead_letter_device_id_fkey')`],
  ];
  for (const [nombre, sql] of comprobaciones) {
    const filas = await q(sql);
    check(nombre, filas.length === 0, filas.map((f) => Object.values(f)[0]).join(", "));
  }

  // Permisos de las funciones nuevas.
  const priv = async (f, rol) =>
    (await q("select has_function_privilege($2, $1, 'execute') as p", [f, rol]))[0].p;
  const deUsuario = [
    "public.create_loan(text, uuid, bigint, integer, numeric, numeric, bigint, integer, date, date, boolean, uuid, boolean)",
    "public.update_loan(uuid, text, numeric, uuid, boolean)",
    "public.update_loan_terms(uuid, uuid, bigint, integer, numeric, bigint, integer, date, date, boolean)",
    "public.cancel_loan(uuid)",
    "public.settle_loan(uuid, date, bigint)",
    "public.loan_delete_preview(uuid)",
    "public.delete_loan(uuid, text)",
    "public.generate_loan_installments()",
    "public.loan_schedule(uuid)",
    "public.loan_plan(bigint, integer, numeric, date)",
    "public.loan_tae(bigint, integer, numeric, bigint)",
    "public.net_worth_monthly(integer)",
    "public.net_worth_daily(date, date)",
  ];
  for (const f of deUsuario) {
    const [a, an, pu] = [await priv(f, "authenticated"), await priv(f, "anon"), await priv(f, "public")];
    check(`${f.split("(")[0]}: authenticated sí, anon y public no`, a === true && an === false && pu === false);
  }
  for (const f of ["public.generate_loan_installments_all()", "public.claim_loan_installment_notices()"]) {
    const [s, a, an, pu] = [
      await priv(f, "service_role"),
      await priv(f, "authenticated"),
      await priv(f, "anon"),
      await priv(f, "public"),
    ];
    check(`${f.split("(")[0]}: SOLO service_role`, s === true && a === false && an === false && pu === false);
  }
  const [t] = await q(
    "select has_table_privilege('anon', 'public.loan', 'select') as anon_sel, has_table_privilege('anon', 'public.loan', 'insert') as anon_ins",
  );
  check("anon no tiene ningún privilegio sobre loan", t.anon_sel === false && t.anon_ins === false);
}

// --------------------------------------------------------------------------
// 3. El cuadro al céntimo: TypeScript contra SQL
// --------------------------------------------------------------------------
async function cuadroSql(principal, plazo, tin, primera) {
  return q(
    `select period, due_on::text as due_on, payment_cents, interest_cents, principal_cents, balance_after_cents
     from public.loan_plan($1, $2, $3::numeric, $4::date) order by period`,
    [principal, plazo, tin, primera],
  );
}

async function errorSql(trabajo) {
  return intento(trabajo);
}

async function cuadroAlCentimo() {
  console.log("\n— El cuadro de amortización, al céntimo (TS ↔ SQL) —\n");

  // Casos calculados a mano.
  const a = cuadroAmortizacion({ principalCents: 1_000_000, plazoMeses: 60, tin: leerTipo("6"), primeraCuota: "2026-11-01" });
  check("10.000 € a 60 meses al 6 % TIN → cuota 193,33 € (P·i/(1−(1+i)^−n), i = 0,5 %)", a[0].cuota === 19333, `${a[0].cuota}`);
  check("primer mes: intereses 50,00 € y capital 143,33 €", a[0].intereses === 5000 && a[0].capital === 14333);
  check("la suma del capital es el principal exacto", a.reduce((s, f) => s + f.capital, 0) === 1_000_000);
  check("el pendiente acaba exactamente en 0", a[59].pendiente === 0);
  check("la última cuota ajusta el redondeo (193,21 €)", a[59].cuota === 19321, `${a[59].cuota}`);
  check("intereses totales 1.599,68 €", a.reduce((s, f) => s + f.intereses, 0) === 159968);
  const b = cuadroAmortizacion({ principalCents: 120_000, plazoMeses: 12, tin: leerTipo("12"), primeraCuota: "2026-01-15" });
  check("1.200 € a 12 meses al 12 % (i = 1 %) → cuota 106,62 €, 1.º mes 12,00 € de intereses", b[0].cuota === 10662 && b[0].intereses === 1200);
  const c = cuadroAmortizacion({ principalCents: 100_000, plazoMeses: 12, tin: 0, primeraCuota: "2026-01-31" });
  check("TIN 0 %: 1.000 € en 12 → 83,33 € y la última 83,37 €, sin intereses", c[0].cuota === 8333 && c[11].cuota === 8337 && c.every((f) => f.intereses === 0));
  check("las fechas recortan el fin de mes como Postgres (31 ene → 28 feb)", c[1].fecha === "2026-02-28" && c[2].fecha === "2026-03-31");

  // La rejilla, contra la base.
  const principales = [10_000, 123_457, 1_000_000, 2_500_001, 99_999_999];
  const plazos = [1, 2, 12, 37, 60, 120, 360, 480];
  const tins = ["0", "0,01", "1,5", "3,25", "6", "7,99", "12,5", "24", "49,9999"];
  let iguales = 0;
  let distintos = 0;
  let invalidosCoinciden = 0;
  const muestras = [];
  for (const P of principales) {
    for (const plazo of plazos) {
      for (const tinTxt of tins) {
        const tin = leerTipo(tinTxt);
        const primera = "2026-12-28";
        let ts = null;
        let tsError = false;
        try {
          ts = cuadroAmortizacion({ principalCents: P, plazoMeses: plazo, tin, primeraCuota: primera });
        } catch {
          tsError = true;
        }
        if (tsError) {
          const e = await errorSql(() => cuadroSql(P, plazo, tipoComoDecimal(tin), primera));
          if (e && e.code === "22023") invalidosCoinciden++;
          else {
            distintos++;
            muestras.push(`${P}/${plazo}/${tinTxt}: TS lo rechaza y SQL no`);
          }
          continue;
        }
        const sql = await cuadroSql(P, plazo, tipoComoDecimal(tin), primera);
        const igual =
          sql.length === ts.length &&
          sql.every(
            (f, i) =>
              n(f.period) === ts[i].periodo &&
              f.due_on === ts[i].fecha &&
              n(f.payment_cents) === ts[i].cuota &&
              n(f.interest_cents) === ts[i].intereses &&
              n(f.principal_cents) === ts[i].capital &&
              n(f.balance_after_cents) === ts[i].pendiente,
          );
        if (igual) iguales++;
        else {
          distintos++;
          if (muestras.length < 5) muestras.push(`${P}/${plazo}/${tinTxt}`);
        }
      }
    }
  }
  check(
    `rejilla de ${principales.length * plazos.length * tins.length} casos: TS y SQL dan el mismo cuadro, fila a fila`,
    distintos === 0,
    muestras.join("; "),
  );
  console.log(`        (${iguales} cuadros iguales, ${invalidosCoinciden} rechazados por los dos)`);

  // La TAE: mismo valor en los dos lados.
  const casosTae = [
    [1_000_000, 60, "6", 10_000],
    [1_000_000, 60, "6", 0],
    [1_000_000, 60, "0", 0],
    [1_000_000, 60, "0", 25_000],
    [2_500_001, 120, "3,25", 37_500],
    [123_457, 12, "7,99", 2_469],
    [99_999_999, 480, "1,5", 999_999],
    [10_000, 1, "24", 100],
    [500_000, 36, "12,5", 0],
    [3_000_000, 84, "5,95", 59_999],
  ];

  const taeMal = [];
  for (const [P, plazo, tinTxt, fee] of casosTae) {
    const tin = leerTipo(tinTxt);
    const cuotas = cuadroAmortizacion({ principalCents: P, plazoMeses: plazo, tin, primeraCuota: "2026-01-01" }).map((f) => f.cuota);
    const ts = taeCalculada(cuotas, P - fee);
    const [r] = await q("select public.loan_tae($1, $2, $3::numeric, $4)::text as t", [P, plazo, tipoComoDecimal(tin), fee]);
    const sqlTae = r.t === null ? null : Number(r.t);
    if (ts !== sqlTae) taeMal.push(`${P}/${plazo}/${tinTxt}/${fee}: TS ${ts} SQL ${sqlTae}`);
  }
  check(`TAE: TS y SQL iguales en ${casosTae.length} casos`, taeMal.length === 0, taeMal.join("; "));
  const tae6 = taeCalculada(a.map((f) => f.cuota), 1_000_000);
  check("TAE sin comisión ≈ (1+i)^12 − 1 = 6,17 %", tae6 === 6.17, `${tae6}`);
  const tae6c = taeCalculada(a.map((f) => f.cuota), 990_000);
  check("con 1 % de comisión la TAE sube y es razonable (6,61 %)", tae6c === 6.61, `${tae6c}`);
  check("TIN 0 y sin comisión → TAE 0", taeCalculada(c.map((f) => f.cuota), 100_000) === 0);

  // El resumen y las fechas por defecto.
  const res = resumenPrestamo({ principalCents: 1_000_000, plazoMeses: 60, tin: leerTipo("6"), primeraCuota: "2026-11-01", comisionCents: comisionPorPorcentaje(1_000_000, leerTipo("1")) });
  check("resumen: comisión 1 % = 100,00 €, coste total = intereses + comisión", res.comision === 10_000 && res.costeTotal === 159968 + 10_000);
  check("primera cuota por defecto: el día de cobro del mes siguiente", primeraCuotaPorDefecto("2026-10-13", 1) === "2026-11-01" && primeraCuotaPorDefecto("2026-12-31", 28) === "2027-01-28");
  const [porDefecto] = await q(
    "select (date_trunc('month', $1::date::timestamp) + interval '1 month' + make_interval(days => $2 - 1))::date::text as d",
    ["2026-12-31", 28],
  );
  check("… y la base calcula la misma (la regla de loan_check_terms)", porDefecto.d === "2027-01-28");
}

// --------------------------------------------------------------------------
// 4. Funcional
// --------------------------------------------------------------------------
const CREAR = `select public.create_loan($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8, $9::date, $10::date, $11) as r`;
async function crear(uid, o) {
  const [r] = await comoUsuario(uid, () =>
    q(CREAR, [o.nombre, o.cuenta, o.principal, o.plazo, tipoComoDecimal(leerTipo(o.tin)), o.tae ?? null, o.comision ?? 0, o.dia ?? 1, o.inicio, o.primera ?? null, o.desembolso]),
  );
  return r.r;
}
const estado = (uid, loanId) =>
  comoUsuario(uid, () => q("select *, start_on::text as start_txt, next_due_on::text as next_txt, end_on::text as end_txt, closed_on::text as closed_txt from public.v_loan_status where loan_id = $1", [loanId])).then((r) => r[0]);
const saldo = (uid, cuenta) =>
  comoUsuario(uid, () => q("select balance_cents from public.v_account_balance where account_id = $1", [cuenta])).then((r) => n(r[0]?.balance_cents));
const patrimonio = (uid) =>
  comoUsuario(uid, () => q("select coalesce(sum(net_worth_cents), 0) as c, coalesce(sum(debt_cents), 0) as d, coalesce(sum(cash_cents), 0) as caja from public.v_net_worth")).then((r) => ({ total: n(r[0].c), deuda: n(r[0].d), caja: n(r[0].caja) }));
const movimientosDe = (loanId) =>
  q("select type, amount_cents, occurred_on::text as d, loan_part, loan_period, account_id::text as origen, to_account_id::text as destino, category_id::text as cat, source from public.transaction where loan_id = $1 order by occurred_on, loan_period, loan_part", [loanId]);

async function funcional(hoy) {
  console.log("\n— Funcional —\n");
  const [u1] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  const [u2] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  const uid = u1.id;
  const otro = u2.id;
  const [banco] = await q("insert into public.account (user_id, name, type, initial_balance_cents) values ($1, 'Banco', 'BANCO', 500000) returning id::text as id", [uid]);
  const [ahorro] = await q("insert into public.account (user_id, name, type) values ($1, 'Ahorro', 'AHORRO') returning id::text as id", [uid]);
  const [bancoOtro] = await q("insert into public.account (user_id, name, type, initial_balance_cents) values ($1, 'Banco', 'BANCO', 100000) returning id::text as id", [otro]);

  // Inicio: el día 10 de hace tres meses. Día de cobro 1 → cuotas el 1 de los
  // tres meses siguientes, el último el de este mes (≤ hoy).
  const inicio = `${sumarMeses(hoy, -3).slice(0, 7)}-10`;

  // ── Desembolso ahora, con comisión ──────────────────────────────────────
  const patAntes = await patrimonio(uid);
  const l1 = await crear(uid, { nombre: "Coche", cuenta: banco.id, principal: 1_000_000, plazo: 60, tin: "6", comision: 10_000, inicio, desembolso: true });
  const cuadro1 = cuadroAmortizacion({ principalCents: 1_000_000, plazoMeses: 60, tin: 60_000, primeraCuota: l1.first_charge_on });
  const vencidas1 = cuadro1.filter((f) => f.fecha <= hoy);
  check("create_loan: primera cuota por defecto = día 1 del mes siguiente al inicio", l1.first_charge_on === primeraCuotaPorDefecto(inicio, 1), l1.first_charge_on);
  check(`genera al crear las ${vencidas1.length} cuotas ya vencidas`, l1.generated === vencidas1.length && vencidas1.length === 3, `${l1.generated}`);

  const m1 = await movimientosDe(l1.loan_id);
  const des = m1.filter((m) => m.loan_part === "DESEMBOLSO");
  check(
    "desembolso: UN traspaso cuenta-pasivo → banco por el principal, en la fecha de inicio",
    des.length === 1 && des[0].type === "TRANSFER" && n(des[0].amount_cents) === 1_000_000 &&
      des[0].origen === l1.liability_account_id && des[0].destino === banco.id && des[0].d === inicio,
  );
  const com = m1.filter((m) => m.loan_part === "COMISION");
  check("comisión: UN gasto en el banco ese día, en «Intereses»", com.length === 1 && com[0].type === "EXPENSE" && n(com[0].amount_cents) === 10_000 && com[0].d === inicio && com[0].cat !== null);
  const intereses = m1.filter((m) => m.loan_part === "INTERESES");
  const capital = m1.filter((m) => m.loan_part === "CAPITAL");
  check(
    "cada cuota: gasto de intereses + traspaso de capital banco → cuenta-pasivo, con el importe del cuadro",
    intereses.length === 3 && capital.length === 3 &&
      vencidas1.every((f, i) => n(intereses[i].amount_cents) === f.intereses && n(capital[i].amount_cents) === f.capital &&
        intereses[i].d === f.fecha && capital[i].d === f.fecha && capital[i].origen === banco.id &&
        capital[i].destino === l1.liability_account_id && intereses[i].type === "EXPENSE" && capital[i].type === "TRANSFER" &&
        intereses[i].source === "RECURRING"),
  );
  check("ningún movimiento con fecha posterior a hoy", m1.every((m) => m.d <= hoy));
  const [cat] = await q("select name, type from public.category where id = $1", [intereses[0].cat]);
  check("la categoría «Intereses» se crea (de gasto) si no existía", cat.name === "Intereses" && cat.type === "EXPENSE");

  const e1 = await estado(uid, l1.loan_id);
  const saldoPasivo = await saldo(uid, l1.liability_account_id);
  check("v_loan_status: el pendiente = −saldo de la cuenta-pasivo = el del cuadro", n(e1.principal_pending_cents) === -saldoPasivo && n(e1.schedule_pending_cents) === -saldoPasivo && -saldoPasivo === vencidas1[2].pendiente);
  check("v_loan_status: capital pagado + pendiente = principal", n(e1.principal_paid_cents) + n(e1.principal_pending_cents) === 1_000_000);
  check("v_loan_status: cuota, pagadas 3, restantes 57, próxima = la 4.ª", n(e1.payment_cents) === 19333 && e1.paid_count === 3 && e1.remaining_count === 57 && e1.next_period === 4 && e1.next_txt === cuadro1[3].fecha && n(e1.next_payment_cents) === cuadro1[3].cuota);
  const intPagados = vencidas1.reduce((s, f) => s + f.intereses, 0);
  check("v_loan_status: intereses pagados, pendientes y totales cuadran", n(e1.interest_paid_cents) === intPagados && n(e1.interest_total_cents) === 159968 && n(e1.interest_paid_cents) + n(e1.interest_pending_cents) === 159968);
  check("v_loan_status: coste total = intereses + comisión; TAE calculada 6,61 %", n(e1.total_cost_cents) === 159968 + 10_000 && Number(e1.tae_calc_pct) === 6.61 && Number(e1.tae_effective_pct) === 6.61 && e1.tae_pct === null);
  check("v_loan_status: fin = la fecha de la cuota 60", e1.end_txt === cuadro1[59].fecha);

  // Patrimonio: el desembolso no lo cambia; solo la comisión y los intereses.
  const patDespues = await patrimonio(uid);
  check(
    "patrimonio: baja SOLO la comisión y los intereses pagados (el desembolso y el capital no lo mueven)",
    patDespues.total - patAntes.total === -(10_000 + intPagados),
    `${patDespues.total - patAntes.total} vs ${-(10_000 + intPagados)}`,
  );
  check("patrimonio: la deuda va en su columna (= saldo de la cuenta-pasivo) y no en la caja", patDespues.deuda === saldoPasivo && patDespues.caja === (await saldo(uid, banco.id)) + (await saldo(uid, ahorro.id)));

  // Gasto del mes: solo intereses (y la comisión en su mes), nunca el capital.
  const meses = await comoUsuario(uid, () => q("select period_month::text as m, net_expense_cents, income_cents from public.v_month_summary"));
  const gastoDe = (mes) => n(meses.find((x) => x.m === mes)?.net_expense_cents ?? 0);
  check("gasto del mes de inicio = la comisión", gastoDe(`${inicio.slice(0, 7)}-01`) === 10_000);
  check(
    "gasto de cada mes con cuota = SOLO sus intereses (el capital no es gasto)",
    vencidas1.every((f) => gastoDe(`${f.fecha.slice(0, 7)}-01`) === f.intereses),
  );
  check("el préstamo no aparece como ingreso en ningún mes", meses.every((x) => n(x.income_cents) === 0));
  const reparto = await comoUsuario(uid, () => q("select name, net_cents from public.category_breakdown($1::date)", [vencidas1[1].fecha]));
  check("reparto del mes: «Intereses» con sus intereses, nada más", reparto.length === 1 && reparto[0].name === "Intereses" && n(reparto[0].net_cents) === vencidas1[1].intereses);
  await q("insert into public.budget (user_id, category_id, monthly_cap_cents) values ($1, $2, 3000)", [uid, intereses[0].cat]);
  const lim = await comoUsuario(uid, () => q("select spent_cents from public.budget_status($1::date)", [vencidas1[1].fecha]));
  check("límites: lo consumido en «Intereses» son los intereses, no la cuota", n(lim[0].spent_cents) === vencidas1[1].intereses);

  // Idempotencia.
  const [g1] = await comoUsuario(uid, () => q("select public.generate_loan_installments() as n"));
  const [g2] = await comoUsuario(uid, () => q("select public.generate_loan_installments() as n"));
  const [g3] = await comoServicio(() => q("select public.generate_loan_installments_all() as n"));
  const m1b = await movimientosDe(l1.loan_id);
  check("generar otra vez (usuario ×2 y cron) no duplica nada", g1.n === 0 && g2.n === 0 && g3.n === 0 && m1b.length === m1.length);
  const [gPasado] = await q("select private.loan_generate($1, $2, $3::date, true) as n", [uid, l1.loan_id, sumarMeses(hoy, -1)]);
  check("generar con un corte anterior no toca nada", gPasado.n === 0 && (await movimientosDe(l1.loan_id)).length === m1.length);
  const eDup = await intento(() =>
    q(`insert into public.transaction (user_id, type, amount_cents, occurred_on, account_id, category_id, category_type, loan_id, loan_period, loan_part)
       values ($1, 'EXPENSE', 1, $2::date, $3, $4, 'EXPENSE', $5, 1, 'INTERESES')`, [uid, vencidas1[0].fecha, banco.id, intereses[0].cat, l1.loan_id]),
  );
  check("la base rechaza una segunda parte de la misma cuota (índice único)", eDup?.code === "23505");

  // Solo hasta hoy: un préstamo con la primera cuota en el futuro no genera nada…
  const inicioHoy = hoy;
  const l2 = await crear(uid, { nombre: "Moto", cuenta: banco.id, principal: 300_000, plazo: 12, tin: "5", inicio: inicioHoy, desembolso: true });
  check("primera cuota futura: no genera ninguna cuota", l2.generated === 0);
  // …ni aunque se le pida con un «hoy» futuro: el corte nunca pasa de hoy.
  const [gFut] = await q("select private.loan_generate($1, $2, $3::date, true) as n", [uid, l2.loan_id, sumarMeses(hoy, 6)]);
  check("un corte futuro se recorta a hoy: no genera cuotas futuras", gFut.n === 0);

  // Editar: el nombre siempre; las condiciones solo sin cuotas cobradas.
  await comoUsuario(uid, () => q("select public.update_loan($1, 'Coche nuevo', 6.75)", [l1.loan_id]));
  const [cta] = await q("select name from public.account where id = $1", [l1.liability_account_id]);
  const e1b = await estado(uid, l1.loan_id);
  check("update_loan: renombra el préstamo y su cuenta-pasivo, y guarda la TAE del contrato", cta.name === "Préstamo · Coche nuevo" && e1b.name === "Coche nuevo" && Number(e1b.tae_effective_pct) === 6.75);
  const eTerms = await intento(() =>
    q("select public.update_loan_terms($1, $2, 1000000, 48, 6::numeric, 0, 1, $3::date, null, true)", [l1.loan_id, banco.id, inicio]), { uid },
  );
  check("update_loan_terms con cuotas cobradas: rechazado", eTerms?.code === "23514");
  const eDirecto = await intento(() => q("update public.loan set principal_cents = 2000000 where id = $1", [l1.loan_id]), { uid });
  check("ni con un UPDATE directo de las condiciones (disparador)", eDirecto?.code === "23514");
  await comoUsuario(uid, () => q("select public.update_loan_terms($1, $2, 400000, 24, 4.5::numeric, 4000, 5, $3::date, null, true)", [l2.loan_id, banco.id, inicioHoy]));
  const m2 = await movimientosDe(l2.loan_id);
  const e2 = await estado(uid, l2.loan_id);
  check(
    "update_loan_terms sin cuotas: rehace el desembolso y la comisión con las nuevas condiciones",
    m2.length === 2 && n(m2.find((m) => m.loan_part === "DESEMBOLSO").amount_cents) === 400_000 &&
      n(m2.find((m) => m.loan_part === "COMISION").amount_cents) === 4000 && e2.charge_day === 5 && e2.term_months === 24 &&
      n(e2.principal_pending_cents) === 400_000,
  );

  // ── Liquidación al terminar ────────────────────────────────────────────
  const inicioCorto = `${sumarMeses(hoy, -4).slice(0, 7)}-10`;
  const l3 = await crear(uid, { nombre: "Tele", cuenta: banco.id, principal: 60_000, plazo: 3, tin: "9,5", inicio: inicioCorto, desembolso: true });
  const e3 = await estado(uid, l3.loan_id);
  const [a3] = await q("select archived from public.account where id = $1", [l3.liability_account_id]);
  check("con la última cuota: LIQUIDADO, cerrado en su fecha, deuda 0 y cuenta-pasivo archivada", l3.generated === 3 && e3.status === "LIQUIDADO" && e3.closed_txt === cuadroAmortizacion({ principalCents: 60_000, plazoMeses: 3, tin: 95_000, primeraCuota: l3.first_charge_on })[2].fecha && (await saldo(uid, l3.liability_account_id)) === 0 && a3.archived === true && e3.remaining_count === 0 && n(e3.interest_pending_cents) === 0);

  // ── TIN 0 % ─────────────────────────────────────────────────────────────
  const l4 = await crear(uid, { nombre: "Sin intereses", cuenta: banco.id, principal: 100_000, plazo: 12, tin: "0", inicio, desembolso: true });
  const m4 = await movimientosDe(l4.loan_id);
  const e4 = await estado(uid, l4.loan_id);
  check("TIN 0 %: solo traspasos de capital (83,33 €), ningún gasto, TAE 0", m4.every((m) => m.type === "TRANSFER") && m4.filter((m) => m.loan_part === "CAPITAL").every((m) => n(m.amount_cents) === 8333) && n(e4.interest_total_cents) === 0 && Number(e4.tae_calc_pct) === 0);

  // ── «Ya lo tenía apuntado» ──────────────────────────────────────────────
  const patAntes5 = await patrimonio(uid);
  const inicio5 = `${sumarMeses(hoy, -14).slice(0, 7)}-20`;
  const eConCom = await intento(() => q(CREAR, ["Hipoteca", ahorro.id, 5_000_000, 36, "5", null, 100, 20, inicio5, null, false]), { uid });
  check("ya apuntado con comisión: rechazado (no lleva comisión)", eConCom?.code === "22023");
  const l5 = await crear(uid, { nombre: "Reforma", cuenta: ahorro.id, principal: 5_000_000, plazo: 36, tin: "5", dia: 20, inicio: inicio5, desembolso: false });
  const cuadro5 = cuadroAmortizacion({ principalCents: 5_000_000, plazoMeses: 36, tin: 50_000, primeraCuota: l5.first_charge_on });
  const primera5 = cuadro5.find((f) => f.fecha > hoy);
  const pendiente5 = cuadro5[primera5.periodo - 2].pendiente;
  const m5 = await movimientosDe(l5.loan_id);
  const e5 = await estado(uid, l5.loan_id);
  const [ini5] = await q("select initial_balance_cents from public.account where id = $1", [l5.liability_account_id]);
  check("ya apuntado: no mueve dinero (ningún movimiento) ni genera las cuotas pasadas", m5.length === 0 && l5.generated === 0);
  check("ya apuntado: la app empieza en la primera cuota POSTERIOR al alta", l5.tracked_from_period === primera5.periodo && e5.paid_count === primera5.periodo - 1);
  check("ya apuntado: la deuda arranca en el pendiente del cuadro (saldo inicial negativo)", n(ini5.initial_balance_cents) === -pendiente5 && n(e5.principal_pending_cents) === pendiente5 && n(e5.schedule_pending_cents) === pendiente5);
  const patDespues5 = await patrimonio(uid);
  check("ya apuntado: el patrimonio baja exactamente la deuda pendiente", patDespues5.total - patAntes5.total === -pendiente5);
  check("ya apuntado: intereses pagados = los de las cuotas previas según el cuadro", n(e5.interest_paid_cents) === cuadro5.slice(0, primera5.periodo - 1).reduce((s, f) => s + f.intereses, 0));
  const sch5 = await comoUsuario(uid, () => q("select period, state from public.loan_schedule($1) order by period", [l5.loan_id]));
  check("loan_schedule: PREVIA antes del alta, PENDIENTE después", sch5.every((f) => (f.period < primera5.periodo ? f.state === "PREVIA" : f.state === "PENDIENTE")));

  // ── Liquidación anticipada ──────────────────────────────────────────────
  const l6 = await crear(uid, { nombre: "Viaje", cuenta: banco.id, principal: 240_000, plazo: 12, tin: "8", inicio, desembolso: true });
  const pend6 = -(await saldo(uid, l6.liability_account_id));
  const [s6] = await comoUsuario(uid, () => q("select public.settle_loan($1, $2::date, 5000) as r", [l6.loan_id, hoy]));
  const m6 = await movimientosDe(l6.loan_id);
  const e6 = await estado(uid, l6.loan_id);
  check(
    "settle_loan: traspasa el pendiente real, apunta la comisión de cancelación y cierra",
    n(s6.r.settled_cents) === pend6 && n(m6.find((m) => m.loan_part === "LIQUIDACION").amount_cents) === pend6 &&
      n(m6.find((m) => m.loan_part === "COMISION_CANCELACION").amount_cents) === 5000 && e6.status === "LIQUIDADO" &&
      (await saldo(uid, l6.liability_account_id)) === 0 && n(e6.interest_pending_cents) === 0 &&
      n(e6.total_cost_cents) === n(e6.interest_paid_cents) + 5000,
  );
  const [g6] = await comoUsuario(uid, () => q("select public.generate_loan_installments() as n"));
  check("un préstamo liquidado ya no genera cuotas", g6.n === 0 && (await movimientosDe(l6.loan_id)).length === m6.length);

  // ── Cancelar ────────────────────────────────────────────────────────────
  await comoUsuario(uid, () => q("select public.cancel_loan($1)", [l2.loan_id]));
  const e2c = await estado(uid, l2.loan_id);
  check("cancel_loan: CANCELADO, sin cuotas pendientes ni próxima", e2c.status === "CANCELADO" && e2c.next_period === null && e2c.remaining_count === 0);

  // ── Avisos: lo que genera el cron se avisa una vez ──────────────────────
  const l7 = await crear(uid, { nombre: "Portátil", cuenta: banco.id, principal: 150_000, plazo: 10, tin: "3", inicio, desembolso: true });
  // Simula que las cuotas vencidas aún no se habían generado (las genera el cron).
  await q("delete from public.transaction where loan_id = $1 and loan_period is not null", [l7.loan_id]);
  await q("update public.loan set last_generated_period = 0, notified_period = 0 where id = $1", [l7.loan_id]);
  const [gc] = await comoServicio(() => q("select public.generate_loan_installments_all() as n"));
  const avisos = await comoServicio(() => q("select user_id::text, loan_id::text, loan_name, from_period, to_period, term_months, amount_cents from public.claim_loan_installment_notices()"));
  const cuadro7 = cuadroAmortizacion({ principalCents: 150_000, plazoMeses: 10, tin: 30_000, primeraCuota: l7.first_charge_on });
  const aviso7 = avisos.find((x) => x.loan_id === l7.loan_id);
  check("el cron (service_role) genera las cuotas de todos", gc.n === 3 && (await movimientosDe(l7.loan_id)).filter((m) => m.loan_period !== null).length === 6);
  check(
    "claim_loan_installment_notices: avisa de las 3 cuotas del cron, con su importe, y solo de esas",
    avisos.length === 1 && aviso7 && aviso7.user_id === uid && aviso7.from_period === 1 && aviso7.to_period === 3 &&
      n(aviso7.amount_cents) === cuadro7.slice(0, 3).reduce((s, f) => s + f.cuota, 0),
  );
  const avisos2 = await comoServicio(() => q("select * from public.claim_loan_installment_notices()"));
  check("… y una segunda llamada no repite el aviso", avisos2.length === 0);

  // ── Previsión del mes: los intereses son fijos, no ritmo ─────────────────
  const [prev] = await comoUsuario(uid, () => q("select * from public.month_forecast($1::date)", [hoy]));
  const pendientesMes = await comoUsuario(uid, () =>
    q(`select coalesce(sum(p.interest_cents), 0) as c from public.loan l
       cross join lateral public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
       where l.status = 'ACTIVO' and p.period > l.last_generated_period
         and p.due_on between date_trunc('month', current_date)::date
                          and (date_trunc('month', current_date) + interval '1 month - 1 day')::date`),
  );
  check(
    "month_forecast: lo fijo pendiente incluye los intereses de las cuotas que faltan este mes",
    n(prev.suscripciones_cents) === n(pendientesMes[0].c),
    `${prev.suscripciones_cents} vs ${pendientesMes[0].c}`,
  );
  check(
    "month_forecast: sin más gasto que el de los préstamos, no extrapola nada (todo es fijo)",
    n(prev.extrapolado_cents) === 0,
    `${prev.extrapolado_cents}`,
  );

  // ── Eliminar ────────────────────────────────────────────────────────────
  const saldosAntes = new Map((await comoUsuario(uid, () => q("select account_id::text as id, balance_cents from public.v_account_balance"))).map((r) => [r.id, n(r.balance_cents)]));
  const patAntesBorrar = await patrimonio(uid);
  const [pv] = await comoUsuario(uid, () => q("select public.loan_delete_preview($1) as p", [l1.loan_id]));
  const eNombre = await intento(() => q("select public.delete_loan($1, 'otro nombre')", [l1.loan_id]), { uid });
  check("delete_loan con otro nombre: rechazado", eNombre?.code === "22023");
  await comoUsuario(uid, () => q("select public.delete_loan($1, $2)", [l1.loan_id, "Coche nuevo"]));
  const saldosDespues = new Map((await comoUsuario(uid, () => q("select account_id::text as id, balance_cents from public.v_account_balance"))).map((r) => [r.id, n(r.balance_cents)]));
  const patDespuesBorrar = await patrimonio(uid);
  const efectoBanco = pv.p.balance_effects.find((x) => x.account_id === banco.id);
  check(
    "delete_loan: no queda nada (préstamo, movimientos, cuenta-pasivo)",
    (await q("select count(*)::int as c from public.loan where id = $1", [l1.loan_id]))[0].c === 0 &&
      (await q("select count(*)::int as c from public.transaction where loan_id = $1 or account_id = $2 or to_account_id = $2", [l1.loan_id, l1.liability_account_id]))[0].c === 0 &&
      (await q("select count(*)::int as c from public.account where id = $1", [l1.liability_account_id]))[0].c === 0,
  );
  check(
    "el preview acertó: saldo del banco, patrimonio y nº de movimientos",
    saldosDespues.get(banco.id) - saldosAntes.get(banco.id) === n(efectoBanco.balance_delta_cents) &&
      patDespuesBorrar.total - patAntesBorrar.total === n(pv.p.net_worth_delta_cents) &&
      n(pv.p.transactions) === m1.length && n(pv.p.installments) === 3 && n(pv.p.expense_cents) === 10_000 + intPagados &&
      n(pv.p.net_worth_delta_cents) === 10_000 + intPagados,
  );

  // delete_account sobre la cuenta de pago de un préstamo: lo impide la FK.
  const eCuenta = await intento(() => q("select public.delete_account($1, 'Banco')", [banco.id]), { uid });
  check("delete_account de la cuenta de pago de un préstamo: lo impide la clave del préstamo", eCuenta?.code === "23503" && /loan_payment_account_fk/.test(eCuenta.message + (eCuenta.constraint ?? "")), eCuenta?.message);

  // ── Aislamiento ─────────────────────────────────────────────────────────
  console.log("\n— Aislamiento —\n");
  const vistoPorOtro = await comoUsuario(otro, () => q("select count(*)::int as c from public.v_loan_status"));
  const cuadroPorOtro = await comoUsuario(otro, () => q("select count(*)::int as c from public.loan_schedule($1)", [l5.loan_id]));
  check("otro usuario no ve los préstamos ni el cuadro ajenos", vistoPorOtro[0].c === 0 && cuadroPorOtro[0].c === 0);
  const eOtroCrear = await intento(() => q(CREAR, ["Robo", banco.id, 100_000, 12, "5", null, 0, 1, inicio, null, true]), { uid: otro });
  check("otro usuario no puede crear un préstamo contra una cuenta ajena", eOtroCrear?.code === "22023" && /no existe/.test(eOtroCrear.message));
  for (const [nombre, sql, params] of [
    ["update_loan", "select public.update_loan($1, 'X', null)", [l5.loan_id]],
    ["cancel_loan", "select public.cancel_loan($1)", [l5.loan_id]],
    ["settle_loan", "select public.settle_loan($1, null, 0)", [l5.loan_id]],
    ["delete_loan", "select public.delete_loan($1, 'Reforma')", [l5.loan_id]],
    ["loan_delete_preview", "select public.loan_delete_preview($1)", [l5.loan_id]],
  ]) {
    const e = await intento(() => q(sql, params), { uid: otro });
    check(`otro usuario: ${nombre} sobre un préstamo ajeno falla (no lo encuentra)`, e?.code === "P0002", e?.message);
  }
  const eUpd = await intento(async () => {
    const r = await q("update public.loan set name = 'pirata' where id = $1 returning id", [l5.loan_id]);
    if (r.length) throw new Error("actualizó");
  }, { uid: otro });
  check("otro usuario: un UPDATE directo no toca ninguna fila", eUpd === null);
  const eInsLoan = await intento(() =>
    q(`insert into public.loan (user_id, name, payment_account_id, liability_account_id, liability_account_type, principal_cents, term_months, tin_pct, charge_day, start_on, first_charge_on, disbursed)
       values ($1, 'X', $2, $3, 'PRESTAMO', 100000, 12, 5, 1, $4::date, $5::date, true)`, [otro, bancoOtro.id, l5.liability_account_id, inicio, primeraCuotaPorDefecto(inicio, 1)]), { uid: otro });
  check("otro usuario: un préstamo propio no puede apuntar a una cuenta-pasivo ajena (FK compuesta)", eInsLoan?.code === "23503");
  const eInsTx = await intento(() =>
    q(`insert into public.transaction (user_id, type, amount_cents, occurred_on, account_id, loan_id, loan_part)
       values ($1, 'EXPENSE', 100, $2::date, $3, $4, 'COMISION')`, [otro, hoy, bancoOtro.id, l5.loan_id]), { uid: otro });
  check("otro usuario: un movimiento propio no puede enlazar un préstamo ajeno (FK compuesta)", eInsTx?.code === "23503");
  const eGenAll = await intento(() => q("select public.generate_loan_installments_all()"), { uid: otro });
  const eClaim = await intento(() => q("select * from public.claim_loan_installment_notices()"), { uid: otro });
  check("una sesión normal no puede lanzar la generación de todos ni reclamar avisos", eGenAll?.code === "42501" && eClaim?.code === "42501");

  // Con el 2FA opcional (20261019090000) solo se exige aal2 a quien tiene un
  // factor verificado: se le da uno (con la regla anterior da igual).
  await q(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (gen_random_uuid(), $1, 'prueba', 'totp', 'verified', now(), now())`,
    [uid],
  );
  const eAal1 = await intento(() => q(CREAR, ["Sin 2FA", banco.id, 100_000, 12, "5", null, 0, 1, inicio, null, true]), { uid, aal: "aal1" });
  const verAal1 = await comoUsuario(uid, () => q("select count(*)::int as c from public.v_loan_status"), "aal1");
  const eGenAal1 = await intento(() => q("select public.generate_loan_installments()"), { uid, aal: "aal1" });
  check("sin aal2: no crea, no genera y no ve nada", eAal1?.code === "42501" && verAal1[0].c === 0 && eGenAal1?.code === "42501");
  const eAnon = await intento(() => q(CREAR, ["Anon", banco.id, 100_000, 12, "5", null, 0, 1, inicio, null, true]), { rol: "anon" });
  const eAnonSel = await intento(() => q("select * from public.loan"), { rol: "anon" });
  const eAnonVista = await intento(() => q("select * from public.v_loan_status"), { rol: "anon" });
  check("anon: ni crear, ni leer la tabla, ni la vista", eAnon?.code === "42501" && eAnonSel?.code === "42501" && eAnonVista?.code === "42501");

  // El borrado directo de un préstamo sigue cerrado.
  const eDel = await intento(async () => {
    const r = await q("delete from public.loan where id = $1 returning id", [l5.loan_id]);
    if (r.length) throw new Error("borró");
  }, { uid });
  check("un DELETE directo de un préstamo (sin delete_loan) no borra nada", eDel === null);
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const [hoyRow] = await q("select (now() at time zone 'Europe/Madrid')::date::text as hoy");
    const hoy = hoyRow.hoy;
    console.log(`Base ${local ? "LOCAL" : "remota"} · hoy en Madrid: ${hoy}`);

    // ¿El valor PRESTAMO ya está confirmado (de antes de esta transacción)?
    const [enumYa] = await q(
      "select exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'account_type' and e.enumlabel = 'PRESTAMO') as v",
    );
    const enumConfirmado = enumYa.v;

    // 1. Huella de los datos reales ANTES.
    const reales = await q("select u.id::text as id from auth.users u order by u.created_at");
    const antes = new Map();
    for (const u of reales) antes.set(u.id, await cifras(u.id, hoy));

    // Migraciones que falten, dentro de la transacción.
    if (!enumConfirmado) {
      await client.query(leer(MIG_ENUM));
      console.log(`(migración ${MIG_ENUM} aplicada dentro de la transacción)`);
    }
    const [tabla] = await q("select to_regclass('public.loan') is not null as v");
    if (!tabla.v) {
      await client.query(leer(MIG_PRESTAMOS));
      console.log(`(migración ${MIG_PRESTAMOS} aplicada dentro de la transacción)`);
    }
    const [prev] = await q("select prosrc like '%loan_id%' as v from pg_proc where proname = 'month_forecast'");
    if (!prev.v) {
      await client.query(leer(MIG_PREVISION));
      console.log(`(migración ${MIG_PREVISION} aplicada dentro de la transacción)`);
    }

    console.log(`\n— Datos reales: ${reales.length} usuarios (solo se informa si cuadra) —\n`);
    // Antes se comprobaba también que nadie tenía préstamos ni deuda: se
    // escribió cuando aún no existían. Con préstamos reales lo que importa es
    // que sus cifras no cambian, que es esta comprobación.
    let iguales = 0;
    for (const u of reales) {
      if ((await cifras(u.id, hoy)) === antes.get(u.id)) iguales++;
    }
    check(`las cifras de los ${reales.length} usuarios reales no cambian`, iguales === reales.length, `${iguales} de ${reales.length}`);

    await auditoria();
    await cuadroAlCentimo();

    if (enumConfirmado) {
      await funcional(hoy);
    } else {
      omitidas++;
      console.log(
        "\n— Funcional: OMITIDO —\n  El valor PRESTAMO no está confirmado en esta base (Postgres no deja usarlo en la\n" +
          "  misma transacción que lo añade). Córrelo contra la réplica local o tras aplicar\n" +
          `  ${MIG_ENUM}.`,
      );
    }
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
  console.log(`\n${ok} correctas · ${mal} fallidas${omitidas ? ` · ${omitidas} bloque omitido` : ""}`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
  process.exit(2);
});
