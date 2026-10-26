/**
 * Prueba de 20261026090000_prestamos_con_categoria.sql: cada préstamo tiene su
 * categoría y elige si cuenta como gasto SOLO LOS INTERESES (lo de siempre) o
 * LA CUOTA ENTERA (el capital también, en la categoría del préstamo).
 *
 *   node --env-file=.env.local scripts/test-prestamos-categoria.mjs
 *
 * TODO dentro de UNA transacción que se deshace: la migración se aplica ahí
 * dentro, los usuarios de prueba se insertan en auth.users ahí dentro, y no
 * persiste nada. De los usuarios reales solo se comparan HUELLAS (md5): no se
 * imprime ninguna cifra.
 *
 * Las fechas se piden con ::text: el driver pg convierte un `date` a medianoche
 * local y toISOString() daría el día anterior.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";
import { cuadroAmortizacion, sumarMeses } from "../src/lib/prestamos.ts";

const VERSION = "20261026090000";
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

/** En un savepoint que se deshace pase lo que pase. Devuelve el error o null. */
async function intento(uid, sql, params) {
  await q("savepoint intento");
  let error = null;
  try {
    await comoUsuario(uid, () => q(sql, params));
  } catch (e) {
    error = e;
  }
  await q("rollback to savepoint intento");
  await q("release savepoint intento");
  return error;
}

// Huellas extra de lo que la migración toca y foto-cifras no cubre.
const huella = (sql) => `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from (${sql}) x`;
const EXTRA = {
  gasto_por_cuenta: "select * from public.account_spend_history(12)",
  prevision_categoria: "select * from public.category_forecast(date_trunc('month', current_date)::date)",
  busqueda_gastos: "select id, total_count, total_net_cents from public.search_transactions(p_type => 'EXPENSE', p_limit => 100000)",
  busqueda_traspasos: "select id, total_count, total_net_cents from public.search_transactions(p_type => 'TRANSFER', p_limit => 100000)",
  busqueda_sin_categoria: "select id, total_count, total_net_cents from public.search_transactions(p_uncategorized => true, p_limit => 100000)",
  // v_loan_status SIN la columna nueva (foto-cifras usa `select *`).
  prestamos_sin_columna_nueva: `select loan_id, payment_cents, principal_pending_cents, interest_paid_cents,
                                       interest_pending_cents, total_cost_cents, next_due_on, interest_category_id
                                from public.v_loan_status`,
  borrar_prestamo: "select l.id, public.loan_delete_preview(l.id) from public.loan l",
};
async function fotoExtra(uid) {
  const foto = {};
  for (const [nombre, sql] of Object.entries(EXTRA)) {
    await q("savepoint foto");
    try {
      foto[nombre] = (await comoUsuario(uid, () => q(huella(sql))))[0].h;
    } catch (e) {
      foto[nombre] = `ERROR ${e.code ?? e.message}`;
    }
    await q("rollback to savepoint foto");
    await q("release savepoint foto");
  }
  return foto;
}

const CREAR = `select public.create_loan($1, $2, $3, $4, $5::numeric, null, 0, $6, $7::date, $8::date, true, $9::uuid, $10) as r`;
async function crear(uid, o) {
  const [r] = await comoUsuario(uid, () =>
    q(CREAR, [o.nombre, o.cuenta, o.principal, o.plazo, o.tin, o.dia ?? 1, o.inicio, o.primera ?? null, o.categoria ?? null, o.entera ?? false]),
  );
  return r.r;
}
const movimientosDe = (loanId) =>
  q(`select id::text, type, amount_cents, occurred_on::text as d, loan_part, category_id::text as cat,
            account_id::text as origen, to_account_id::text as destino
     from public.transaction where loan_id = $1 order by occurred_on, loan_period, loan_part`, [loanId]);
const mesDe = (fecha) => `${fecha.slice(0, 7)}-01`;

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    await aplicarPendientes(client, { hasta: String(Number(VERSION) - 1) });
    const [{ hoy }] = await q("select private.hoy()::text as hoy");

    // ── 1. Datos reales: idénticos ──────────────────────────────────────────
    const reales = (await q("select id::text as id from auth.users order by created_at")).map((r) => r.id);
    const fotos = [];
    for (const r of reales) fotos.push({ base: await fotoUsuario(client, r), extra: await fotoExtra(r) });

    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})\n`);

    console.log("— Datos reales (solo huellas) —\n");
    const cambios = [];
    for (const [i, r] of reales.entries()) {
      const base = compararFotos(fotos[i].base, await fotoUsuario(client, r)).filter((k) => k !== "prestamos");
      const extra = compararFotos(fotos[i].extra, await fotoExtra(r));
      if (base.length || extra.length) cambios.push(`usuario ${i + 1}: ${[...base, ...extra].join(", ")}`);
    }
    check(`cifras de los ${reales.length} usuarios reales idénticas (gasto, saldos, previsión, búsqueda, préstamos)`, cambios.length === 0, cambios.join("; "));
    const [{ marcados }] = await q("select count(*)::int as marcados from public.loan where counts_full_installment");
    check("ningún préstamo existente pasa a contar la cuota entera", marcados === 0);

    // ── 2. Esquema y permisos ───────────────────────────────────────────────
    console.log("\n— Esquema y permisos —\n");
    const [inv] = await q(`select bool_and(coalesce(c.reloptions::text like '%security_invoker=true%', false)) as v
                           from pg_class c where c.oid in ('public.v_transaction_econ'::regclass, 'public.v_loan_status'::regclass)`);
    check("v_transaction_econ y v_loan_status siguen con security_invoker", inv.v === true);
    const sinRuta = await q(`select p.oid::regprocedure::text as f from pg_proc p
                             where p.oid::regprocedure::text ~ '^(public\\.)?(create_loan|update_loan|month_forecast|category_forecast|account_spend_history|search_transactions|loan_delete_preview)\\(|^private\\.loan_check_category'
                               and not coalesce(p.proconfig @> array['search_path=""'], false)`);
    check("todas las funciones tocadas fijan search_path = ''", sinRuta.length === 0, sinRuta.map((r) => r.f).join(", "));
    const definer = await q(`select p.oid::regprocedure::text as f from pg_proc p
                             where p.proname in ('create_loan','update_loan','loan_check_category','search_transactions') and p.prosecdef`);
    check("ninguna es security definer", definer.length === 0, definer.map((r) => r.f).join(", "));
    const viejas = await q(`select p.oid::regprocedure::text as f from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                            where s.nspname = 'public' and p.proname in ('create_loan', 'update_loan')`);
    check("una sola firma de create_loan y de update_loan (las de antes, borradas)", viejas.length === 2, viejas.map((r) => r.f).join(", "));
    const priv = async (f, rol) => (await q("select has_function_privilege($2, $1, 'execute') as p", [f, rol]))[0].p;
    for (const f of [
      "public.create_loan(text, uuid, bigint, integer, numeric, numeric, bigint, integer, date, date, boolean, uuid, boolean)",
      "public.update_loan(uuid, text, numeric, uuid, boolean)",
    ]) {
      const [a, an, pu] = [await priv(f, "authenticated"), await priv(f, "anon"), await priv(f, "public")];
      check(`${f.split("(")[0]}: authenticated sí, anon y public no`, a && !an && !pu);
    }

    // ── 3. Funcional ────────────────────────────────────────────────────────
    console.log("\n— Funcional —\n");
    const [u1] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const [u2] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
    const uid = u1.id;
    const [banco] = await q("insert into public.account (user_id, name, type, initial_balance_cents) values ($1, 'Banco', 'BANCO', 500000) returning id::text as id", [uid]);
    const [coche] = await q("insert into public.category (user_id, name, type) values ($1, 'Coche', 'EXPENSE') returning id::text as id", [uid]);
    const [moto] = await q("insert into public.category (user_id, name, type) values ($1, 'Moto', 'EXPENSE') returning id::text as id", [uid]);
    const [nomina] = await q("insert into public.category (user_id, name, type) values ($1, 'Nómina', 'INCOME') returning id::text as id", [uid]);
    const [ajena] = await q("insert into public.category (user_id, name, type) values ($1, 'Ajena', 'EXPENSE') returning id::text as id", [u2.id]);
    const inicio = `${sumarMeses(hoy, -3).slice(0, 7)}-10`;
    const base = { cuenta: banco.id, principal: 1_000_000, plazo: 60, tin: "6", inicio };

    const sinCat = await intento(uid, CREAR, ["X", banco.id, 1_000_000, 60, "6", 1, inicio, null, null, true]);
    check("cuota entera sin categoría: rechazado (22023, en español)", sinCat?.code === "22023" && /categoría/.test(sinCat.message), sinCat?.message);
    const deOtro = await intento(uid, CREAR, ["X", banco.id, 1_000_000, 60, "6", 1, inicio, null, ajena.id, false]);
    check("categoría de OTRO usuario: rechazado", deOtro?.code === "22023", deOtro?.message);
    const deIngreso = await intento(uid, CREAR, ["X", banco.id, 1_000_000, 60, "6", 1, inicio, null, nomina.id, false]);
    check("categoría de ingreso: rechazado", deIngreso?.code === "22023", deIngreso?.message);

    const [patAntes] = await comoUsuario(uid, () => q("select coalesce(sum(net_worth_cents), 0)::bigint as c from public.v_net_worth"));
    const l1 = await crear(uid, { ...base, nombre: "Coche", categoria: coche.id, entera: true });
    const directo = await intento(uid, "update public.loan set interest_category_id = $1, interest_category_type = 'EXPENSE' where id = $2", [ajena.id, l1.loan_id]);
    check("ni con un UPDATE directo se apunta a la categoría de otro (FK compuesta)", directo?.code === "23503", directo?.message ?? "aceptado");
    const cuadro = cuadroAmortizacion({ principalCents: 1_000_000, plazoMeses: 60, tin: 60_000, primeraCuota: l1.first_charge_on });
    const vencidas = cuadro.filter((f) => f.fecha <= hoy);
    check("se generan las 3 cuotas vencidas", l1.generated === 3 && vencidas.length === 3, `${l1.generated}`);

    const m1 = await movimientosDe(l1.loan_id);
    const capital = m1.filter((m) => m.loan_part === "CAPITAL");
    const intereses = m1.filter((m) => m.loan_part === "INTERESES");
    check(
      "el capital SIGUE siendo un traspaso banco → cuenta del préstamo (los saldos no cambian de modelo)",
      capital.length === 3 && capital.every((m) => m.type === "TRANSFER" && m.origen === banco.id && m.destino === l1.liability_account_id),
    );
    check("los intereses van a la categoría del préstamo («Coche»), no a «Intereses»", intereses.length === 3 && intereses.every((m) => m.cat === coche.id));
    const [{ hay }] = await q("select exists (select 1 from public.category where user_id = $1 and name = 'Intereses') as hay", [uid]);
    check("no se crea la categoría «Intereses»", hay === false);

    const [saldoBanco] = await comoUsuario(uid, () => q("select balance_cents from public.v_account_balance where account_id = $1", [banco.id]));
    const pagado = vencidas.reduce((s, f) => s + f.cuota, 0);
    check("saldo del banco = inicial + principal − cuotas (como siempre)", n(saldoBanco.balance_cents) === 500_000 + 1_000_000 - pagado);
    const [patDespues] = await comoUsuario(uid, () => q("select coalesce(sum(net_worth_cents), 0)::bigint as c from public.v_net_worth"));
    const intPagados = vencidas.reduce((s, f) => s + f.intereses, 0);
    check("el patrimonio solo baja los intereses: contar el capital como gasto no lo toca", n(patDespues.c) - n(patAntes.c) === -intPagados);

    const meses = await comoUsuario(uid, () => q("select period_month::text as m, net_expense_cents, gross_expense_cents, income_cents from public.v_month_summary"));
    const gastoDe = (fecha) => n(meses.find((x) => x.m === mesDe(fecha))?.net_expense_cents ?? 0);
    check("gasto de cada mes = la CUOTA ENTERA", vencidas.every((f) => gastoDe(f.fecha) === f.cuota), vencidas.map((f) => `${gastoDe(f.fecha)}/${f.cuota}`).join(" "));
    check("el desembolso sigue sin ser ingreso", meses.every((x) => n(x.income_cents) === 0));
    const reparto = await comoUsuario(uid, () => q("select category_id::text as c, net_cents from public.category_breakdown($1::date)", [vencidas[1].fecha]));
    check("reparto del mes: «Coche» con la cuota entera", reparto.length === 1 && reparto[0].c === coche.id && n(reparto[0].net_cents) === vencidas[1].cuota);
    await q("insert into public.budget (user_id, category_id, monthly_cap_cents) values ($1, $2, 10000)", [uid, coche.id]);
    const lim = await comoUsuario(uid, () => q("select spent_cents from public.budget_status($1::date)", [vencidas[1].fecha]));
    check("límite de «Coche»: consume la cuota entera", n(lim[0]?.spent_cents) === vencidas[1].cuota);
    const [econ] = await comoUsuario(uid, () => q("select type, econ_category_id::text as c, net_expense_cents from public.v_transaction_econ where id = $1", [capital[1].id]));
    check("v_transaction_econ: el capital se lee como gasto de «Coche»", econ?.type === "EXPENSE" && econ.c === coche.id && n(econ.net_expense_cents) === n(capital[1].amount_cents));

    const desde = mesDe(vencidas[1].fecha);
    const hasta = sumarMeses(desde, 1);
    const busca = (extra) =>
      comoUsuario(uid, () => q(`select id::text, type, total_net_cents from public.search_transactions(p_from => $1::date, p_to => ($2::date - 1), ${extra})`, [desde, hasta]));
    const porCat = await busca(`p_category => '${coche.id}'`);
    check("búsqueda por «Coche»: intereses y capital, total = la cuota", porCat.length === 2 && n(porCat[0].total_net_cents) === vencidas[1].cuota);
    const gastos = await busca("p_type => 'EXPENSE'");
    check("búsqueda de gastos: incluye el capital", gastos.some((r) => r.id === capital[1].id) && n(gastos[0].total_net_cents) === vencidas[1].cuota);
    const traspasos = await busca("p_type => 'TRANSFER'");
    check("búsqueda de traspasos: el capital ya no sale ahí", !traspasos.some((r) => r.id === capital[1].id));
    const sinCategoria = await busca("p_uncategorized => true");
    check("búsqueda «sin categoría»: el capital no sale (tiene la del préstamo)", !sinCategoria.some((r) => r.id === capital[1].id));
    const porTexto = await busca("p_q => 'coch'");
    check("buscar por el nombre de la categoría encuentra el capital", porTexto.some((r) => r.id === capital[1].id));

    const historia = await comoUsuario(uid, () => q("select account_id::text as a, period_month::text as m, gasto_cents from public.account_spend_history(6)"));
    const delBanco = historia.find((h) => h.a === banco.id && h.m === mesDe(vencidas[1].fecha));
    check("gasto por cuenta: al banco se le carga la cuota entera", n(delBanco?.gasto_cents) === vencidas[1].cuota);
    const [prev] = await comoUsuario(uid, () => q("select gasto_real_cents, extrapolado_cents from public.month_forecast($1::date)", [mesDe(hoy)]));
    check("previsión del mes: la cuota es recurrente, no se extrapola como gasto suelto", n(prev.gasto_real_cents) === vencidas[2].cuota && n(prev.extrapolado_cents) === 0);
    const [borrar] = await comoUsuario(uid, () => q("select public.loan_delete_preview($1) as p", [l1.loan_id]));
    check("eliminar: el gasto que desaparece incluye el capital", n(borrar.p.expense_cents) === pagado);

    // La cuota que falta este mes, en la previsión (si su día aún no ha llegado).
    const dia = Number(hoy.slice(8, 10));
    if (dia < 28) {
      const l2 = await crear(uid, { ...base, nombre: "Moto", categoria: moto.id, entera: true, dia: 28, inicio: sumarMeses(hoy, -1), primera: `${hoy.slice(0, 7)}-28` });
      const c2 = cuadroAmortizacion({ principalCents: 1_000_000, plazoMeses: 60, tin: 60_000, primeraCuota: l2.first_charge_on });
      const [p2] = await comoUsuario(uid, () => q("select suscripciones_cents from public.month_forecast($1::date)", [mesDe(hoy)]));
      check("previsión: lo que falta este mes es la cuota entera (intereses + capital)", n(p2.suscripciones_cents) === c2[0].cuota, `${p2.suscripciones_cents} vs ${c2[0].cuota}`);
      await q("insert into public.budget (user_id, category_id, monthly_cap_cents) values ($1, $2, 100)", [uid, moto.id]);
      const cf = await comoUsuario(uid, () => q("select category_id::text as c, prevision_cents, rebasa from public.category_forecast($1::date)", [mesDe(hoy)]));
      const deMoto = cf.find((r) => r.c === moto.id);
      check("previsión por categoría: «Moto» prevé la cuota entera y avisa de que rebasa", n(deMoto?.prevision_cents) === c2[0].cuota && deMoto.rebasa === true);
      await comoUsuario(uid, () => q("select public.delete_loan($1, 'Moto')", [l2.loan_id]));
    } else {
      console.log("  (omitida la previsión de una cuota futura: hoy es día 28 o más)");
    }

    // ── 4. Cambiar la opción y la categoría ─────────────────────────────────
    await comoUsuario(uid, () => q("update public.transaction set category_id = $1, category_type = 'EXPENSE' where id = $2", [moto.id, intereses[0].id]));
    await comoUsuario(uid, () => q("select public.update_loan($1, 'Coche', null, null, false)", [l1.loan_id]));
    const meses2 = await comoUsuario(uid, () => q("select period_month::text as m, net_expense_cents from public.v_month_summary"));
    const gastoDe2 = (fecha) => n(meses2.find((x) => x.m === mesDe(fecha))?.net_expense_cents ?? 0);
    check("«solo los intereses»: el gasto de cada mes vuelve a ser solo los intereses", vencidas.every((f) => gastoDe2(f.fecha) === f.intereses));
    const [l1b] = await q("select interest_category_id::text as c, counts_full_installment as e from public.loan where id = $1", [l1.loan_id]);
    check("… y la categoría se queda (null = no cambiar)", l1b.c === coche.id && l1b.e === false);

    await comoUsuario(uid, () => q("select public.update_loan($1, 'Coche', null)", [l1.loan_id]));
    const [l1c] = await q("select interest_category_id::text as c, counts_full_installment as e from public.loan where id = $1", [l1.loan_id]);
    check("la llamada de la app anterior (tres parámetros) no cambia ni la categoría ni la opción", l1c.c === coche.id && l1c.e === false);

    const [otra] = await q("insert into public.category (user_id, name, type) values ($1, 'Vehículos', 'EXPENSE') returning id::text as id", [uid]);
    await comoUsuario(uid, () => q("select public.update_loan($1, 'Coche', null, $2, true)", [l1.loan_id, otra.id]));
    const m1d = await movimientosDe(l1.loan_id);
    const int2 = m1d.filter((m) => m.loan_part === "INTERESES");
    check(
      "cambiar la categoría mueve los intereses ya apuntados… salvo el recategorizado a mano",
      int2[0].cat === moto.id && int2.slice(1).every((m) => m.cat === otra.id),
      int2.map((m) => m.cat).join(" "),
    );
    const [econ2] = await comoUsuario(uid, () => q("select econ_category_id::text as c from public.v_transaction_econ where id = $1", [capital[2].id]));
    check("el capital ya cobrado cuenta en la categoría nueva sin reescribirlo", econ2?.c === otra.id);
    const sinCat2 = await intento(uid, "select public.update_loan($1, 'Coche', null, null, true)", [l1.loan_id]);
    check("update_loan con categoría de otro: rechazado", (await intento(uid, "select public.update_loan($1, 'Coche', null, $2, null)", [l1.loan_id, ajena.id]))?.code === "22023");
    check("update_loan con la cuota entera y la categoría que ya tiene: vale", sinCat2 === null, sinCat2?.message);

    // Borrar la categoría: el préstamo se queda sin ella, y la cuota SIGUE contando.
    await q("savepoint borrar_cat");
    await comoUsuario(uid, () => q("delete from public.category where id = $1", [otra.id]));
    const [econ3] = await comoUsuario(uid, () => q("select type, econ_category_id from public.v_transaction_econ where id = $1", [capital[2].id]));
    check("borrada la categoría: la cuota sigue contando, «sin categoría»", econ3?.type === "EXPENSE" && econ3.econ_category_id === null);
    await q("rollback to savepoint borrar_cat");
    await q("release savepoint borrar_cat");

    // ── 5. Liquidar con la cuota entera: el pago de lo pendiente es gasto ───
    const [{ pend }] = await comoUsuario(uid, () => q("select principal_pending_cents as pend from public.v_loan_status where loan_id = $1", [l1.loan_id]));
    await comoUsuario(uid, () => q("select public.settle_loan($1, $2::date, 0)", [l1.loan_id, hoy]));
    const [liq] = await q("select id::text from public.transaction where loan_id = $1 and loan_part = 'LIQUIDACION'", [l1.loan_id]);
    const [econLiq] = await comoUsuario(uid, () => q("select type, econ_category_id::text as c, net_expense_cents from public.v_transaction_econ where id = $1", [liq.id]));
    check("liquidar con la cuota entera: el pago de lo pendiente cuenta como gasto en su categoría", econLiq?.type === "EXPENSE" && econLiq.c === otra.id && n(econLiq.net_expense_cents) === n(pend));
    const [{ deuda }] = await comoUsuario(uid, () => q("select balance_cents as deuda from public.v_account_balance where account_id = $1", [l1.liability_account_id]));
    check("… y la deuda queda a cero, como siempre", n(deuda) === 0);

    // RLS: el otro usuario no ve nada de esto.
    const ajenas = await comoUsuario(u2.id, () => q("select count(*)::int as c from public.v_transaction_econ"));
    check("otro usuario no ve ninguna fila económica del préstamo", ajenas[0].c === 0);
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
