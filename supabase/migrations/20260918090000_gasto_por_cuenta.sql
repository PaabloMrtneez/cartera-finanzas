-- ===========================================================================
-- Gasto por cuenta (o tarjeta): cuánto se ha CARGADO a cada cuenta cada mes.
--
-- Hasta ahora había saldo por cuenta (v_account_balance) y gasto por categoría,
-- pero nadie cruzaba «cuenta × gasto». Esto lo cubre para la sección de gasto de
-- cada tarjeta en Cuentas: el del mes en curso (último punto) y su tendencia.
--
-- Es GASTO cargado a la cuenta —los EXPENSE—, no el neto: un reembolso entra
-- como ingreso en la cuenta donde se recibe, que rara vez es la del gasto, así
-- que restarlo por cuenta no significaría nada. Los traspasos NO son gasto
-- (mueven, no gastan) y quedan fuera; los descartados también. Es la lectura
-- natural de «cuánto he cargado a esta tarjeta».
-- ===========================================================================

create or replace function public.account_spend_history(p_months integer default 6)
returns table (
  account_id   uuid,
  period_month date,
  gasto_cents  bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select generate_series(
             (date_trunc('month', current_date) - make_interval(months => p_months - 1))::date,
             date_trunc('month', current_date)::date,
             interval '1 month'
           )::date as mes
  ),
  -- Solo las cuentas con algún gasto en la ventana: una cuenta de ahorro sin
  -- cargos no aporta una tendencia de gasto que mirar.
  cuentas as (
    select t.account_id
    from public.transaction t, meses m
    where t.period_month = m.mes
      and t.type = 'EXPENSE'
      and t.status <> 'DISCARDED'
    group by t.account_id
    having sum(t.amount_cents) > 0
  )
  select c.account_id,
         m.mes,
         coalesce((
           select sum(t.amount_cents)
           from public.transaction t
           where t.account_id = c.account_id
             and t.period_month = m.mes
             and t.type = 'EXPENSE'
             and t.status <> 'DISCARDED'
         ), 0)::bigint
  from cuentas c
  cross join meses m
  order by c.account_id, m.mes;
$$;

comment on function public.account_spend_history is
  'Gasto mensual (EXPENSE cargado, sin traspasos ni descartados) por cuenta en los últimos p_months, para la sección de gasto por tarjeta. Solo cuentas con gasto en la ventana.';
