-- ===========================================================================
-- El rendimiento se quedaba en blanco justo cuando más se quiere ver.
--
-- position_return busca la valoración inmediatamente anterior al inicio del
-- periodo para saber de dónde partías. Si aportaste antes de esa fecha pero la
-- primera valoración es posterior —lo normal: aportas en diciembre y valoras a
-- final de enero— no hay valor de partida, el denominador queda a cero y el
-- porcentaje sale nulo. Con siete valoraciones registradas, la pantalla decía
-- «harán falta al menos dos valoraciones».
--
-- Corrección: sin valoración previa, el punto de partida es lo aportado hasta
-- entonces, que es exactamente lo que te costó. Es la misma regla que usan
-- v_position_value y el histórico del patrimonio, así que las tres cifras
-- cuentan la misma historia.
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
    select distinct on (v.position_id) v.position_id, v.value_cents
    from public.valuation v
    where v.date <= p_from
    order by v.position_id, v.date desc
  ),
  -- Lo aportado ANTES del periodo: hace de coste de partida cuando todavía no
  -- había ninguna valoración.
  coste_previo as (
    select t.position_id, sum(t.amount_cents)::bigint as cents
    from public.transaction t
    where t.type = 'TRANSFER'
      and t.status <> 'DISCARDED'
      and t.position_id is not null
      and t.occurred_on <= p_from
    group by t.position_id
  ),
  v1 as (
    select distinct on (v.position_id) v.position_id, v.value_cents, v.date
    from public.valuation v
    where v.date <= p_to
    order by v.position_id, v.date desc
  ),
  flujos as (
    -- Aportaciones dentro del periodo, ponderadas por el tiempo que llevan
    -- dentro: mil euros metidos ayer no han tenido ocasión de rendir.
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
  ),
  base as (
    select p.id,
           p.name,
           p.color,
           p.account_id,
           -- Valor de partida: la valoración previa si la hay; si no, el coste.
           coalesce(v0.value_cents, cp.cents, 0)::bigint as inicio,
           coalesce(v1.value_cents, 0)::bigint            as fin,
           coalesce(f.total, 0)::bigint                   as aportado,
           coalesce(f.ponderado, 0)                       as aportado_ponderado,
           v1.date                                        as fecha,
           (v1.value_cents is null)                       as sin_valorar
    from public.investment_position p
    left join v0 on v0.position_id = p.id
    left join coste_previo cp on cp.position_id = p.id
    left join v1 on v1.position_id = p.id
    left join flujos f on f.position_id = p.id
    where not p.archived
  )
  select b.id, b.name, b.color, b.account_id,
         b.inicio,
         b.fin,
         b.aportado,
         (b.fin - b.inicio - b.aportado)::bigint,
         round(
           100.0 * (b.fin - b.inicio - b.aportado)
           / nullif(b.inicio + b.aportado_ponderado, 0),
           2
         ),
         b.fecha,
         b.sin_valorar
  from base b
  order by b.fin desc;
$$;
