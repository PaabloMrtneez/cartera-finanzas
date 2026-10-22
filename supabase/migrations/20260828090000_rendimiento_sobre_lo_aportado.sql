-- ===========================================================================
-- El rendimiento de una posición se mide sobre lo APORTADO, no sobre lo
-- aportado ponderado por el tiempo.
--
-- QUÉ ESTABA MAL
--
-- `position_return` dividía la ganancia entre `inicio + aportado_ponderado`,
-- donde el ponderado reparte cada aportación por la fracción del periodo que
-- lleva dentro. Eso es Dietz modificado, una fórmula legítima: mil euros
-- metidos ayer no han tenido ocasión de rendir un año entero, y contarlos
-- enteros inflaría el porcentaje.
--
-- Pero tiene un punto ciego, y es justo el de estrenar una posición: cuando
-- `inicio` es cero y la aportación entró al final del periodo, el denominador
-- se queda en una fracción diminuta de lo que de verdad hay puesto, y el
-- porcentaje se dispara. Medido contra datos reales, una posición con 640,68 €
-- aportados el 27 de agosto y 720,06 € de valor el 28 daba:
--
--     rango «Año»   →  +2961,20 %
--     rango «6 M»   →  +2242,58 %
--     rango «1 M»   →   +384,09 %
--
-- cuando lo que ha pasado es que ha subido un 12,39 %. Y una posición en
-- pérdidas daba −124,28 %: perder más del 100 % de lo que metiste no es un
-- número inexacto, es un número imposible.
--
-- POR QUÉ ESTE DENOMINADOR
--
-- Dividir entre `inicio + aportado` es el rendimiento simple sobre el capital
-- puesto: lo que contesta a «cuánto ha subido», que es la pregunta que se le
-- hace a esta pantalla. No puede bajar de −100 %, no depende de la longitud del
-- periodo elegido, y es lo que enseña cualquier bróker.
--
-- Y además arregla una incoherencia que ya existía: `portfolio_return` suma
-- numeradores y denominadores de todas las posiciones y divide al final, con el
-- aportado SIN ponderar. Es decir, el total y las partes venían usando
-- definiciones distintas, y el total nunca cuadraba con lo que sumaban las
-- filas. Ahora las dos miden lo mismo.
--
-- Lo que se pierde: en un periodo con aportaciones repartidas, este número no
-- distingue entre dinero que lleva un año dentro y dinero que lleva un mes. A
-- cambio de que nunca mienta por dos órdenes de magnitud, es un cambio que sale
-- a cuenta.
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
    -- Aportaciones dentro del periodo. Ya no se ponderan por el tiempo que
    -- llevan dentro: ver la explicación de arriba.
    select t.position_id, sum(t.amount_cents)::bigint as total
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
           / nullif(b.inicio + b.aportado, 0),
           2
         ),
         b.fecha,
         b.sin_valorar
  from base b
  order by b.fin desc;
$$;
