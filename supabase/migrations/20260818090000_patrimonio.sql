-- ===========================================================================
-- Patrimonio e inversiones.
--
-- Aquí conviven dos invariantes que en apariencia se contradicen:
--
--   · El patrimonio son los saldos de TODAS las cuentas, activas y archivadas,
--     incluidas las tarjetas en negativo.
--   · Una revalorización sube el patrimonio, pero NO es un ingreso: no genera
--     ningún movimiento, así que no puede mover el saldo contable de la cuenta.
--
-- Solo son compatibles si las cuentas de inversión valen por su VALOR DE
-- MERCADO —la última valoración de sus posiciones— y no por su saldo contable.
-- Eso es lo que hace v_net_worth.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Última valoración de cada posición.
-- ---------------------------------------------------------------------------
create view public.v_position_latest with (security_invoker = true) as
select distinct on (v.position_id)
       v.user_id, v.position_id, v.date as valued_on, v.value_cents
from public.valuation v
order by v.position_id, v.date desc;


-- ---------------------------------------------------------------------------
-- Lo aportado a cada posición: traspasos dirigidos a ella.
--
-- Sirve de coste de referencia cuando todavía no hay ninguna valoración, para
-- que una posición recién creada no desaparezca del patrimonio.
-- ---------------------------------------------------------------------------
create view public.v_position_contributions with (security_invoker = true) as
select p.user_id,
       p.id as position_id,
       coalesce(sum(t.amount_cents), 0)::bigint as contributed_cents
from public.investment_position p
left join public.transaction t
       on t.user_id = p.user_id
      and t.position_id = p.id
      and t.type = 'TRANSFER'
      and t.status <> 'DISCARDED'
group by p.user_id, p.id;


-- ---------------------------------------------------------------------------
-- Cada posición con su valor actual y su coste.
-- ---------------------------------------------------------------------------
create view public.v_position_value with (security_invoker = true) as
select p.user_id,
       p.id as position_id,
       p.name,
       p.color,
       p.account_id,
       p.since,
       p.archived,
       c.contributed_cents,
       l.valued_on,
       -- Sin valoración todavía, vale lo aportado: no se puede inventar una
       -- ganancia, pero tampoco puede desaparecer del patrimonio.
       coalesce(l.value_cents, c.contributed_cents) as value_cents,
       (l.value_cents is null) as sin_valorar
from public.investment_position p
left join public.v_position_contributions c on c.position_id = p.id
left join public.v_position_latest l on l.position_id = p.id;


-- ---------------------------------------------------------------------------
-- Patrimonio neto.
--
-- Tres sumandos que no se solapan:
--   · caja: el saldo de todas las cuentas que no son de inversión
--   · invertido: el valor de mercado de las posiciones
--   · sin desplegar: lo que hay en una cuenta de inversión pero aún no está
--     asignado a ninguna posición
--
-- El tercero evita el doble conteo: si aportaste 1.000 € a la cuenta de
-- inversión pero solo 800 están en posiciones, los otros 200 son caja de esa
-- cuenta y deben sumar una sola vez.
-- ---------------------------------------------------------------------------
create view public.v_net_worth with (security_invoker = true) as
with caja as (
  select b.user_id, coalesce(sum(b.balance_cents), 0)::bigint as cents
  from public.v_account_balance b
  where b.type <> 'INVERSION'
  group by b.user_id
),
invertido as (
  select v.user_id, coalesce(sum(v.value_cents), 0)::bigint as cents
  from public.v_position_value v
  where not v.archived
  group by v.user_id
),
sin_desplegar as (
  select b.user_id,
         coalesce(sum(b.balance_cents), 0)::bigint
           - coalesce(sum(a.aportado), 0)::bigint as cents
  from public.v_account_balance b
  left join lateral (
    select coalesce(sum(c.contributed_cents), 0) as aportado
    from public.v_position_contributions c
    join public.investment_position p on p.id = c.position_id
    where p.account_id = b.account_id
  ) a on true
  where b.type = 'INVERSION'
  group by b.user_id
)
select coalesce(caja.user_id, invertido.user_id, sin_desplegar.user_id) as user_id,
       coalesce(caja.cents, 0)
         + coalesce(invertido.cents, 0)
         + coalesce(sin_desplegar.cents, 0) as net_worth_cents,
       coalesce(caja.cents, 0)          as cash_cents,
       coalesce(invertido.cents, 0)     as invested_cents,
       coalesce(sin_desplegar.cents, 0) as idle_cents
from caja
full join invertido using (user_id)
full join sin_desplegar using (user_id);


-- ---------------------------------------------------------------------------
-- Evolución del patrimonio, mes a mes.
--
-- Para cada mes se calcula el saldo acumulado de las cuentas hasta el final de
-- ese mes, más el valor de las posiciones según la valoración más reciente que
-- existiera entonces. Nada se almacena: si corriges un movimiento de hace un
-- año, la curva entera se recalcula sola.
-- ---------------------------------------------------------------------------
create or replace function public.net_worth_history(p_months integer default 12)
returns table (period_month date, net_worth_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  -- Misma fórmula que v_net_worth, pero congelada al cierre de cada mes:
  --
  --   saldo de TODAS las cuentas
  --   − lo aportado a posiciones (que ya está contado en ese saldo)
  --   + el valor de mercado de esas posiciones
  --
  -- Restar lo aportado antes de sumar el valor es lo que evita contar dos veces
  -- el dinero que entró en la cuenta de inversión y de ahí pasó a una posición.
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
           -- Menos lo que se aportó a posiciones hasta esa fecha.
           - coalesce((
               select sum(t.amount_cents)
               from public.transaction t
               where t.position_id is not null
                 and t.type = 'TRANSFER'
                 and t.status <> 'DISCARDED'
                 and t.occurred_on <= c.fin
             ), 0)
           -- Más el valor de mercado que tuvieran entonces.
           + coalesce((
               select sum(
                 (select val.value_cents
                  from public.valuation val
                  where val.position_id = p.id and val.date <= c.fin
                  order by val.date desc
                  limit 1)
               )
               from public.investment_position p
             ), 0)
         )::bigint
  from cierres c
  order by c.mes;
$$;
