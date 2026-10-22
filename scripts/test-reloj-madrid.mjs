/**
 * Prueba de 20261020090200_un_solo_reloj_madrid.sql (M4): «hoy» es el día de
 * Madrid en toda la capa de datos, sin depender del reloj de la sesión.
 *
 *   node --env-file=.env.local scripts/test-reloj-madrid.mjs
 *
 * TODO ocurre dentro de UNA transacción que se deshace; las migraciones
 * pendientes se aplican ahí dentro. No se imprime ninguna cifra real.
 *
 * La idea: `current_date` depende de la zona horaria de la SESIÓN. Se calculan
 * las mismas funciones «con hoy» con la sesión en Kiritimati (UTC+14) y en Pago
 * Pago (UTC−11), que SIEMPRE están en días distintos. Antes de la migración los
 * resultados difieren; después tienen que ser idénticos, porque el único «hoy»
 * es private.hoy() = el día de Madrid.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes, versionesAplicadas } from "./migraciones-pendientes.mjs";

const VERSION = "20261020090200";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

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

const MADRID = "(now() at time zone 'Europe/Madrid')::date";

/** Funciones y vistas cuyo resultado depende de «hoy» (ninguna devuelve timestamptz). */
const CON_HOY = {
  prevision: `select * from public.month_forecast(date_trunc('month', ${MADRID})::date)`,
  prevision_categorias: `select * from public.category_forecast(date_trunc('month', ${MADRID})::date)`,
  ritmo: `select * from public.month_pace(date_trunc('month', ${MADRID})::date)`,
  proximos_cargos: "select * from public.upcoming_charges(60)",
  proximos_ingresos: "select * from public.upcoming_income(60)",
  sin_clasificar: "select * from public.unclassified_by_month(6)",
  curva_mensual: "select * from public.net_worth_monthly(3)",
  ahorro_mensual: "select * from public.monthly_savings(3)",
  saldo_mensual: "select * from public.account_balance_monthly(3)",
  compromiso: "select * from public.commitment_history(3)",
  cierre_anual: "select * from public.yearly_close()",
  meses_cerrados: "select period_month, income_cents, net_expense_cents from public.v_closed_months",
  fijos: "select id, next_charge_date, due from public.v_subscription_summary",
  ingresos_fijos: "select id, next_income_date, due from public.v_recurring_income_summary",
  pendiente_valorar: "select position_id from public.v_pending_valuation",
};

async function comoUsuario(uid, trabajo) {
  await q("savepoint como");
  try {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
    await q("set local role authenticated");
    return await trabajo();
  } finally {
    await q("rollback to savepoint como");
    await q("release savepoint como");
  }
}

/** Huellas de CON_HOY para `uid` con la sesión en la zona `tz`. */
async function huellas(uid, tz) {
  return comoUsuario(uid, async () => {
    await q(`set local timezone = '${tz}'`);
    const h = {};
    for (const [k, sql] of Object.entries(CON_HOY)) {
      await q("savepoint h");
      try {
        const [r] = await q(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from (${sql}) x`);
        h[k] = r.h;
      } catch (e) {
        h[k] = `ERROR ${e.code}`;
      }
      await q("rollback to savepoint h");
      await q("release savepoint h");
    }
    return h;
  });
}

async function sembrar() {
  const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  const uid = u.id;
  const [b] = await q("insert into public.account (user_id,name,type,initial_balance_cents) values ($1,'Banco','BANCO',500000) returning id::text as id", [uid]);
  const [inv] = await q("insert into public.account (user_id,name,type) values ($1,'Bróker','INVERSION') returning id::text as id", [uid]);
  const [cat] = await q("insert into public.category (user_id,name,type) values ($1,'Súper','EXPENSE') returning id::text as id", [uid]);
  // Gastos e ingresos de hoy, de ayer y de mañana-1 (en Madrid), de este mes y del anterior.
  for (const [d, tipo, cents, conCat] of [
    [0, "EXPENSE", 1234, true], [-1, "EXPENSE", 2000, false], [-2, "EXPENSE", 999, true],
    [-35, "EXPENSE", 4321, true], [-40, "INCOME", 150000, false], [-3, "INCOME", 200000, false],
    [1, "EXPENSE", 777, true],
  ]) {
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
       values ($1,$2,$3,'x',${MADRID} + $4::int,$5,$6,case when $6::uuid is null then null else $2::public.entry_type end,'MANUAL','CONFIRMED')`,
      [uid, tipo, cents, d, b.id, conCat && tipo === "EXPENSE" ? cat.id : null],
    );
  }
  await q(
    `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,started_at,account_id)
     values ($1,'Hoy',999,'MENSUAL',${MADRID},${MADRID} - 60,$2), ($1,'Mañana',500,'MENSUAL',${MADRID} + 1,${MADRID} - 60,$2)`,
    [uid, b.id],
  );
  await q(
    `insert into public.recurring_income (user_id,description,amount_cents,periodicity,next_income_date,started_at,account_id)
     values ($1,'Nómina',100000,'MENSUAL',${MADRID},${MADRID} - 60,$2)`,
    [uid, b.id],
  );
  await q("insert into public.budget (user_id,category_id,monthly_cap_cents) values ($1,$2,50000)", [uid, cat.id]);
  const [p] = await q(
    "insert into public.investment_position (user_id,name,account_id,since) values ($1,'Plan',$2,'2026-01-01') returning id::text as id",
    [uid, inv.id],
  );
  await q(`insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,${MADRID} - 45,100000)`, [uid, p.id]);
  return { uid, banco: b.id, posicion: p.id };
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const yaEstaba = (await versionesAplicadas(client)).has(VERSION);
    const previas = await aplicarPendientes(client, { hasta: "20261020090199" });
    if (previas.length) console.log(`(aplicadas antes: ${previas.join(", ")})`);

    const reales = (await q("select id::text as id from auth.users order by created_at")).map((r) => r.id);
    const fotosAntes = [];
    for (const u of reales) fotosAntes.push(await fotoUsuario(client, u, { conHoy: false }));

    const s = await sembrar();

    console.log("\n— Antes: el resultado depende de la zona horaria de la sesión —\n");
    const kirAntes = await huellas(s.uid, "Pacific/Kiritimati");
    const pagoAntes = await huellas(s.uid, "Pacific/Pago_Pago");
    const difAntes = compararFotos(kirAntes, pagoAntes);
    if (yaEstaba) console.log("  (la migración ya estaba aplicada: el «antes» ya es el «después»)");
    else check("sin la migración, Kiritimati y Pago Pago dan resultados distintos (prueba de que la prueba mide algo)", difAntes.length > 0, "no difiere nada");
    console.log(`        difieren: ${difAntes.join(", ") || "nada"}`);

    const aplicadas = await aplicarPendientes(client, { hasta: VERSION });
    if (aplicadas.length) console.log(`\n(aplicada dentro de la transacción: ${aplicadas.join(", ")})`);

    console.log("\n— Después: un solo reloj —\n");
    const [h] = await q("select private.hoy()::text as hoy, (now() at time zone 'Europe/Madrid')::date::text as madrid");
    check("private.hoy() es el día de Madrid", h.hoy === h.madrid, JSON.stringify(h));
    const [vol] = await q("select provolatile as v, proconfig from pg_proc where oid = 'private.hoy()'::regprocedure");
    check("private.hoy() es STABLE y con search_path = ''", vol.v === "s" && (vol.proconfig ?? []).includes('search_path=""'), JSON.stringify(vol));

    const kir = await huellas(s.uid, "Pacific/Kiritimati");
    const pago = await huellas(s.uid, "Pacific/Pago_Pago");
    const utc = await huellas(s.uid, "UTC");
    const dif = [...new Set([...compararFotos(kir, pago), ...compararFotos(kir, utc)])];
    check("con la migración, UTC, Kiritimati (UTC+14) y Pago Pago (UTC−11) dan EXACTAMENTE lo mismo", dif.length === 0, `difieren: ${dif.join(", ")}`);
    const errores = Object.entries(kir).filter(([, v]) => v.startsWith("ERROR"));
    check("ninguna de las funciones con «hoy» falla", errores.length === 0, JSON.stringify(errores));

    // Generar cargos con la sesión en Pago Pago (su current_date es AYER en Madrid):
    // el cargo de hoy en Madrid se genera igual.
    const gen = await comoUsuario(s.uid, async () => {
      await q("set local timezone = 'Pacific/Pago_Pago'");
      await q("select public.generate_subscription_charges(), public.generate_recurring_income()");
      return q(`select count(*)::int as n from public.transaction where user_id = $1 and source = 'RECURRING' and occurred_on = private.hoy()`, [s.uid]);
    });
    check("generar cargos con la sesión en UTC−11: el cargo y el ingreso de HOY (Madrid) se crean", gen[0].n === 2, `${gen[0].n}`);

    // Los CHECK de fecha: una valoración de hoy (Madrid) siempre se acepta; una de mañana, nunca.
    const val = async (dias, tz) =>
      comoUsuario(s.uid, async () => {
        await q(`set local timezone = '${tz}'`);
        await q("savepoint v");
        try {
          await q("insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,private.hoy() + $3::int,1)", [s.uid, s.posicion, dias]);
          return "aceptada";
        } catch (e) {
          return e.code;
        } finally {
          await q("rollback to savepoint v");
        }
      });
    check("valoración con fecha de hoy en Madrid y sesión en UTC−11: aceptada", (await val(0, "Pacific/Pago_Pago")) === "aceptada");
    check("valoración con fecha de mañana en Madrid y sesión en UTC+14: rechazada (23514)", (await val(1, "Pacific/Kiritimati")) === "23514");

    console.log("\n— Inventario: nadie más lee current_date —\n");
    const [inv] = await q(`
      select
        (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public','private') and (p.prosrc ~* '\\mcurrent_date\\M'
                or coalesce(pg_get_expr(p.proargdefaults, 0), '') ~* 'current_date')) as funciones,
        (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public','private') and c.relkind = 'v' and pg_get_viewdef(c.oid) ~* '\\mcurrent_date\\M') as vistas,
        (select count(*) from pg_constraint k where k.connamespace = 'public'::regnamespace
          and pg_get_constraintdef(k.oid) ~* 'current_date') as checks,
        (select count(*) from information_schema.columns where table_schema = 'public'
          and column_default ~* 'current_date') as defectos,
        (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public','private') and p.proname <> 'hoy' and p.prosrc ~* 'time zone ''Europe/Madrid''\\)::date') as madrid_a_mano`);
    check(
      "ninguna función, vista, CHECK ni valor por defecto usa current_date ni la expresión de Madrid escrita a mano",
      Object.values(inv).every((v) => Number(v) === 0),
      JSON.stringify(inv),
    );
    const [vis] = await q(`
      select count(*) filter (where not coalesce(c.reloptions, '{}') @> array['security_invoker=true']) as sin_invoker
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'`);
    check("todas las vistas siguen siendo security_invoker", Number(vis.sin_invoker) === 0);
    const [def] = await q(`
      select count(*) filter (where p.prosecdef and not coalesce(p.proconfig, '{}') @> array['search_path=""']) as mal
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')`);
    check("toda función security definer sigue con search_path = ''", Number(def.mal) === 0);

    console.log("\n— Datos reales (solo si cuadran) —\n");
    let iguales = 0;
    for (const [i, u] of reales.entries()) {
      const d = compararFotos(fotosAntes[i], await fotoUsuario(client, u, { conHoy: false }));
      if (d.length === 0) iguales++;
      else console.log(`  usuario #${i + 1}: cambian ${d.join(", ")}`);
    }
    const [mismoDia] = await q("select current_date = private.hoy() as v");
    check(
      `cifras de los ${reales.length} usuarios reales idénticas (fechas fijas)${mismoDia.v ? "" : " — OJO: ahora Madrid y UTC están en días distintos"}`,
      iguales === reales.length,
    );
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
