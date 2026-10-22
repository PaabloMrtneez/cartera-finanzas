/**
 * «Foto» de las cifras de un usuario como HUELLAS (md5), sin sacar ningún
 * importe de la base: cada apartado es el md5 de sus filas ordenadas, calculado
 * en SQL. Sirve para comprobar que una migración deja las cifras de los
 * usuarios reales idénticas (o para saber exactamente qué apartado cambia)
 * sin imprimir ni un céntimo.
 *
 *   import { fotoUsuario, compararFotos } from "./foto-cifras.mjs";
 *   const antes = await fotoUsuario(client, uid);   // dentro de una transacción
 *   … aplicar migración …
 *   const despues = await fotoUsuario(client, uid);
 *   compararFotos(antes, despues)   // → ["patrimonio", …] los apartados que cambian
 *
 * Se ejecuta con la sesión del usuario (rol authenticated, aal2), como la app.
 * Las curvas con fechas usan unas fijas para que «hoy» no cuente; las que
 * dependen de hoy por dentro (previsión, próximos cargos) van aparte, en
 * APARTADOS_CON_HOY, porque un cambio de reloj (M4) puede moverlas a propósito.
 */

const huella = (sql) => `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from (${sql}) x`;

export const APARTADOS = {
  patrimonio: "select * from public.v_net_worth",
  saldos: "select account_id, balance_cents from public.v_account_balance",
  valor_cuentas: "select * from public.v_account_worth",
  meses: "select * from public.v_month_summary",
  econ: "select * from public.v_transaction_econ",
  reparto: `select period_month, econ_category_id, sum(net_expense_cents), sum(real_income_cents)
            from public.v_transaction_econ group by 1, 2`,
  posiciones_valor: "select * from public.v_position_value",
  posiciones_mercado: `select position_id, value_cents, fuente, sin_precio, contributed_cents, gain_cents, units, price
                       from public.v_position_market`,
  aportaciones: "select * from public.v_position_contributions",
  curva_mensual: "select * from public.net_worth_monthly(120)",
  curva_diaria: "select * from public.net_worth_daily('2026-06-01', '2026-10-15')",
  saldo_mensual: "select * from public.account_balance_monthly(24)",
  rendimiento: "select * from public.position_performance('2000-01-01', '2026-10-15')",
  rentabilidad: "select * from public.position_return('2000-01-01', '2026-10-15')",
  rentabilidad_cartera: "select * from public.portfolio_return('2000-01-01', '2026-10-15')",
  busqueda: `select id, total_count, total_net_cents from public.search_transactions(p_limit => 100000)`,
  busqueda_texto: `select id, total_count, total_net_cents from public.search_transactions(p_q => 'a', p_limit => 100000)`,
  metas: "select * from public.v_savings_goal_progress",
  prestamos: "select * from public.v_loan_status",
  fijos: "select * from public.v_subscription_summary",
  ingresos_fijos: "select * from public.v_recurring_income_summary",
  reparto_mes: "select * from public.category_breakdown('2026-09-01')",
  limites_mes: "select * from public.budget_status('2026-09-01')",
};

export const APARTADOS_CON_HOY = {
  prevision: "select * from public.month_forecast(date_trunc('month', current_date)::date)",
  proximos_cargos: "select * from public.upcoming_charges(60)",
  proximos_ingresos: "select * from public.upcoming_income(60)",
};

/** Huellas de todos los apartados para `uid`. Un apartado que falla vale «ERROR código». */
export async function fotoUsuario(client, uid, { conHoy = true } = {}) {
  const apartados = conHoy ? { ...APARTADOS, ...APARTADOS_CON_HOY } : APARTADOS;
  const foto = {};
  for (const [nombre, sql] of Object.entries(apartados)) {
    await client.query("savepoint foto");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
      ]);
      await client.query("set local role authenticated");
      const r = await client.query(huella(sql));
      foto[nombre] = r.rows[0].h;
    } catch (e) {
      foto[nombre] = `ERROR ${e.code ?? e.message}`;
    }
    await client.query("rollback to savepoint foto");
    await client.query("release savepoint foto");
  }
  return foto;
}

/** Nombres de los apartados que difieren entre dos fotos. */
export function compararFotos(a, b) {
  return Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
}
