-- ===========================================================================
-- El cuadro francés rechaza las cuotas que no amortizan.
--
-- Cierre de la v1: H-08 de docs/pruebas/informe-robustez.md, lado SQL. Es el
-- espejo de cuadroAmortizacion (src/lib/prestamos.ts), que aplica la MISMA
-- regla: scripts/test-prestamos.mjs compara los dos lados en una rejilla y
-- exige que rechacen los mismos casos.
-- Prueba: scripts/test-cuadro-amortiza.mjs.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- public.loan_plan solo rechazaba un capital NEGATIVO. Con un TIN alto y un
-- plazo largo, la cuota redondeada es igual a los intereses: capital 0 cada
-- mes y todo el principal en la última cuota (100 € a 480 meses al 30 %: 479
-- cuotas de 2,50 € y una de 102,50 €). Y el redondeo de la cuota (½ céntimo)
-- se capitaliza: 50.000 € a 40 años al 25 % dejan la última 979 € por debajo.
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
--  · Capital <= 0 en cualquier cuota: rechazado (antes, solo < 0).
--  · Con más de una cuota, la última no puede apartarse de la primera más de
--    max(100 céntimos, 10 % de la cuota).
-- Mensaje: «Con ese TIN y ese plazo la cuota no amortiza bien el préstamo.
-- Prueba con un plazo más corto.» (22023), el mismo que el de la app.
-- En préstamos normales (≤ 30 años, TIN ≤ 10 %) nada cambia: la última se
-- aparta unos céntimos. Ningún préstamo de producción queda fuera (la prueba
-- lo comprueba con los suyos, sin imprimirlos).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.loan_plan(p_principal_cents bigint, p_term_months integer, p_tin_pct numeric, p_first_charge_on date)
 RETURNS TABLE(period integer, due_on date, payment_cents bigint, interest_cents bigint, principal_cents bigint, balance_after_cents bigint)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  -- 12 meses × 100 (%) × 10⁴ (cuatro decimales del TIN).
  c_d     constant numeric := 12000000;
  v_t     numeric;          -- TIN en diezmilésimas de punto: 6,5 % → 65000
  v_q     numeric := 1;     -- (D+T)ⁿ
  v_dn    numeric := 1;     -- Dⁿ
  v_cuota numeric;
  v_pend  numeric;
  v_int   numeric;
  v_cap   numeric;
  v_primera numeric;       -- la cuota del primer mes
  v_ultima  numeric;       -- la del último
  k       integer;
begin
  if p_principal_cents is null or p_principal_cents <= 0 then
    raise exception 'El importe del préstamo tiene que ser mayor que cero' using errcode = '22023';
  end if;
  if p_term_months is null or p_term_months < 1 or p_term_months > 480 then
    raise exception 'El plazo va de 1 a 480 meses' using errcode = '22023';
  end if;
  if p_tin_pct is null or p_tin_pct < 0 or p_tin_pct > 50 or p_tin_pct <> round(p_tin_pct, 4) then
    raise exception 'El TIN va de 0 a 50 %%, con cuatro decimales como mucho' using errcode = '22023';
  end if;
  if p_first_charge_on is null then
    raise exception 'Falta la fecha de la primera cuota' using errcode = '22023';
  end if;

  v_t := p_tin_pct * 10000;
  v_pend := p_principal_cents;

  -- div() es la división entera (trunca; con positivos, un suelo):
  -- ⌊(2a + b) / 2b⌋ redondea a/b con el empate hacia arriba.
  if v_t = 0 then
    v_cuota := div(2 * v_pend + p_term_months, 2 * p_term_months);
  else
    for k in 1 .. p_term_months loop
      v_q  := v_q * (c_d + v_t);
      v_dn := v_dn * c_d;
    end loop;
    v_cuota := div(2 * v_pend * v_t * v_q + c_d * (v_q - v_dn), 2 * c_d * (v_q - v_dn));
  end if;

  for k in 1 .. p_term_months loop
    v_int := div(2 * v_pend * v_t + c_d, 2 * c_d);
    if k < p_term_months then
      v_cap := v_cuota - v_int;
    else
      v_cap := v_pend;   -- la última cuota ajusta: el pendiente queda en 0
    end if;
    -- Toda cuota tiene que amortizar algo (H-08): con capital 0 el préstamo
    -- solo paga intereses y TODO el principal caería en la última cuota.
    if v_cap <= 0 or (k < p_term_months and v_pend - v_cap <= 0) then
      raise exception 'Con ese TIN y ese plazo la cuota no amortiza bien el préstamo. Prueba con un plazo más corto.'
        using errcode = '22023';
    end if;
    if k = 1 then v_primera := v_int + v_cap; end if;
    if k = p_term_months then v_ultima := v_int + v_cap; end if;
    v_pend := v_pend - v_cap;

    period              := k;
    due_on              := (p_first_charge_on + make_interval(months => k - 1))::date;
    payment_cents       := (v_int + v_cap)::bigint;
    interest_cents      := v_int::bigint;
    principal_cents     := v_cap::bigint;
    balance_after_cents := v_pend::bigint;
    return next;
  end loop;

  -- H-08: el medio céntimo de redondeo de la cuota se capitaliza durante todo
  -- el plazo; con un TIN alto y un plazo muy largo la última cuota se aparta
  -- cientos de euros de las demás. Eso ya no es una cuota constante: se
  -- rechaza si se aparta más de max(1 €, 10 % de la cuota). Las filas ya
  -- devueltas con RETURN NEXT se descartan con el error.
  if p_term_months > 1 and abs(v_ultima - v_primera) > greatest(100, div(v_primera, 10)) then
    raise exception 'Con ese TIN y ese plazo la cuota no amortiza bien el préstamo. Prueba con un plazo más corto.'
      using errcode = '22023';
  end if;
end $function$;
