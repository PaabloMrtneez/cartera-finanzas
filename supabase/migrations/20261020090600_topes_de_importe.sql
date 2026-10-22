-- ===========================================================================
-- El mismo tope de importe en todas las columnas de dinero que escribe el
-- usuario: 1.000 millones de euros (100.000.000.000 céntimos), el de
-- tx_amount_positive y account_balance_range.
--
-- Cierre de la v1: hallazgo M6 de docs/pruebas/informe-datos.md.
-- Prueba: scripts/test-topes-importe.mjs y test-casos-limite.mjs.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- subscription.amount_cents, recurring_income.amount_cents,
-- savings_goal.target_cents, budget.monthly_cap_cents y valuation.value_cents
-- solo exigían > 0 (o >= 0). La app solo exige Number.isSafeInteger (~9·10^15)
-- y por la API se llega a bigint entero: una suscripción semanal de 2·10^15 €
-- desbordaba bigint en v_subscription_summary (amount × 52, error 22003) y
-- rompía Fijos para ese usuario.
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
-- Un CHECK de máximo en cada una, con el mismo número que en transaction. Con
-- él, amount × 52 cabe de sobra (5,2·10^12) y la suma de todas las
-- suscripciones de un usuario solo desbordaría con más de un millón de ellas:
-- v_subscription_summary y v_recurring_income_summary no necesitan cambiar.
-- Los préstamos ya tienen su tope (loan_principal_range, 10 M€) y las
-- aportaciones externas el suyo (unit_event_contributed_max).
--
-- En producción ninguna fila supera el tope (comprobado: 0), así que los
-- CHECK se validan sin tocar nada. El lado de la app (el mismo tope en Zod con
-- un mensaje decente) es de src/lib/schemas.ts.
-- ===========================================================================

alter table public.subscription
  add constraint sub_amount_max check (amount_cents <= 100000000000);

alter table public.recurring_income
  add constraint rincome_amount_max check (amount_cents <= 100000000000);

alter table public.savings_goal
  add constraint goal_target_max check (target_cents <= 100000000000);

alter table public.budget
  add constraint budget_cap_max check (monthly_cap_cents <= 100000000000);

alter table public.valuation
  add constraint valuation_value_max check (value_cents <= 100000000000);
