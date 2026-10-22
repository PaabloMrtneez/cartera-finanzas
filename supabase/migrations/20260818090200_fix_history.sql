-- ===========================================================================
-- El histórico del patrimonio hacía desaparecer el dinero recién aportado.
--
-- La fórmula resta lo aportado a posiciones y vuelve a sumar su valor de
-- mercado. Pero entre que aportas y registras la primera valoración pueden
-- pasar semanas, y en esa ventana la posición no tenía valor con el que
-- reponer lo restado: el dinero simplemente se esfumaba de la curva.
--
-- Con 6.000 € aportados y sin valorar todavía, la gráfica dibujaba una caída de
-- 6.000 € que nunca ocurrió. Una curva de patrimonio que miente es peor que no
-- tener curva.
--
-- La corrección es la misma regla que ya usa v_position_value: sin valoración,
-- una posición vale lo que se ha aportado a ella. No se inventa ninguna
-- ganancia, pero tampoco se pierde el dinero de vista.
-- ===========================================================================

create or replace function public.net_worth_history(p_months integer default 12)
returns table (period_month date, net_worth_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with cierres as (
    select m::date as mes,
           (m + interval '1 month' - interval '1 day')::date as fin
    from generate_series(
           date_trunc('month', current_date) - make_interval(months => p_months - 1),
           date_trunc('month', current_date),
           interval '1 month'
         ) m
  )
  select c.mes,
         (
           -- Saldo de todas las cuentas al cierre del mes.
           coalesce((select sum(a.initial_balance_cents) from public.account a), 0)
           + coalesce((
               select sum(v.delta_cents)
               from public.v_account_movement v
               where v.occurred_on <= c.fin
             ), 0)
           -- Menos lo aportado a posiciones hasta esa fecha, que ya está
           -- contado en el saldo de la cuenta de inversión.
           - coalesce((
               select sum(t.amount_cents)
               from public.transaction t
               where t.position_id is not null
                 and t.type = 'TRANSFER'
                 and t.status <> 'DISCARDED'
                 and t.occurred_on <= c.fin
             ), 0)
           -- Más lo que valían esas posiciones entonces. Sin valoración
           -- todavía, valen lo aportado hasta esa fecha.
           + coalesce((
               select sum(
                 coalesce(
                   (select val.value_cents
                    from public.valuation val
                    where val.position_id = p.id and val.date <= c.fin
                    order by val.date desc
                    limit 1),
                   (select coalesce(sum(t.amount_cents), 0)
                    from public.transaction t
                    where t.position_id = p.id
                      and t.type = 'TRANSFER'
                      and t.status <> 'DISCARDED'
                      and t.occurred_on <= c.fin)
                 )
               )
               from public.investment_position p
             ), 0)
         )::bigint
  from cierres c
  order by c.mes;
$$;
