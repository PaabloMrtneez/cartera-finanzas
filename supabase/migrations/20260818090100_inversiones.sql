-- ===========================================================================
-- Rendimiento de las inversiones.
--
-- El invariante: las aportaciones se descuentan ANTES de calcular el
-- porcentaje. Si metes 1.000 € en una posición que valía 1.000 y ahora vale
-- 2.000, no has ganado un 100 %: has ganado cero.
--
-- Y el total de la cartera pondera por capital, no promedia porcentajes. Una
-- posición de 10.000 € que sube un 5 % pesa cien veces más que una de 100 €
-- que sube un 50 %.
-- ===========================================================================

create or replace function public.position_return(p_from date, p_to date)
returns table (
  position_id         uuid,
  name                text,
  color               text,
  account_id          uuid,
  start_cents         bigint,
  end_cents           bigint,
  contributions_cents bigint,
  gain_cents          bigint,
  return_pct          numeric,
  valued_on           date,
  sin_valorar         boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with v0 as (
    -- Valor al principio del periodo.
    select distinct on (v.position_id) v.position_id, v.value_cents
    from public.valuation v
    where v.date <= p_from
    order by v.position_id, v.date desc
  ),
  v1 as (
    -- Valor al final.
    select distinct on (v.position_id) v.position_id, v.value_cents, v.date
    from public.valuation v
    where v.date <= p_to
    order by v.position_id, v.date desc
  ),
  flujos as (
    -- Aportaciones dentro del periodo, y su versión ponderada por el tiempo que
    -- llevan dentro: mil euros metidos ayer no han tenido ocasión de rendir.
    select t.position_id,
           sum(t.amount_cents)::bigint as total,
           sum(
             t.amount_cents
             * ((p_to - t.occurred_on)::numeric / nullif((p_to - p_from), 0))
           ) as ponderado
    from public.transaction t
    where t.type = 'TRANSFER'
      and t.status <> 'DISCARDED'
      and t.position_id is not null
      and t.occurred_on > p_from
      and t.occurred_on <= p_to
    group by t.position_id
  )
  select p.id,
         p.name,
         p.color,
         p.account_id,
         coalesce(v0.value_cents, 0)::bigint,
         coalesce(v1.value_cents, 0)::bigint,
         coalesce(f.total, 0)::bigint,
         (coalesce(v1.value_cents, 0) - coalesce(v0.value_cents, 0) - coalesce(f.total, 0))::bigint,
         round(
           100.0
           * (coalesce(v1.value_cents, 0) - coalesce(v0.value_cents, 0) - coalesce(f.total, 0))
           / nullif(coalesce(v0.value_cents, 0) + coalesce(f.ponderado, 0), 0),
           2
         ),
         v1.date,
         (v1.value_cents is null)
  from public.investment_position p
  left join v0 on v0.position_id = p.id
  left join v1 on v1.position_id = p.id
  left join flujos f on f.position_id = p.id
  where not p.archived
  order by coalesce(v1.value_cents, 0) desc;
$$;


-- ---------------------------------------------------------------------------
-- Rendimiento de toda la cartera.
--
-- Se suman numeradores y denominadores por separado y se divide al final. Eso
-- ES la ponderación por capital: no es lo mismo que promediar los porcentajes
-- de cada posición, y promediarlos daría una cifra falsa.
-- ---------------------------------------------------------------------------
create or replace function public.portfolio_return(p_from date, p_to date)
returns table (
  start_cents         bigint,
  end_cents           bigint,
  contributions_cents bigint,
  gain_cents          bigint,
  return_pct          numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(r.start_cents), 0)::bigint,
         coalesce(sum(r.end_cents), 0)::bigint,
         coalesce(sum(r.contributions_cents), 0)::bigint,
         coalesce(sum(r.gain_cents), 0)::bigint,
         round(
           100.0 * coalesce(sum(r.gain_cents), 0)
           / nullif(coalesce(sum(r.start_cents), 0) + coalesce(sum(r.contributions_cents), 0), 0),
           2
         )
  from public.position_return(p_from, p_to) r;
$$;


-- ---------------------------------------------------------------------------
-- Posiciones que aún no tienen valoración de este mes.
--
-- Se valora una vez al mes, a cierre. Este aviso es lo que evita que la curva
-- del patrimonio se quede plana sin que nadie se dé cuenta.
-- ---------------------------------------------------------------------------
create view public.v_pending_valuation with (security_invoker = true) as
select p.user_id,
       p.id as position_id,
       p.name,
       (select max(v.date) from public.valuation v where v.position_id = p.id) as last_valued_on
from public.investment_position p
where not p.archived
  and not exists (
    select 1 from public.valuation v
    where v.position_id = p.id
      and v.period_month = date_trunc('month', current_date)::date
  );
