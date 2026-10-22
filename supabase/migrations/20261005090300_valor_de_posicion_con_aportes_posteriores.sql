-- ===========================================================================
-- Una aportación posterior a la última valoración ya no desaparece.
--
-- QUÉ ESTABA MAL
--
-- El valor de una posición era «la última valoración; si no hay ninguna, lo
-- aportado». Eso olvida el dinero que se mete DESPUÉS de la última valoración.
-- Valoras a 30 de septiembre en 1.000 €, el 5 de octubre aportas 500:
--
--   · el saldo de la cuenta de inversión sube 500 (entra el traspaso),
--   · lo aportado sube 500 y se resta (para no contarlo dos veces),
--   · la posición sigue valiendo 1.000, la última valoración.
--
-- Resultado: el patrimonio baja 500 € que nadie ha perdido, y en Inversiones la
-- posición enseña una pérdida de 500 € (vale 1.000 y has metido 1.500), hasta
-- que se registra la valoración de cierre. En los cierres mensuales casi no se
-- veía, porque se valora a final de mes; pero el mes en curso lo sufre siempre
-- que se aporta antes de valorar, y en la curva diaria (net_worth_daily) se
-- vería cada vez.
--
-- EL CRITERIO
--
--   valor(d) = última valoración con fecha <= d
--            + lo aportado DESPUÉS de esa valoración y hasta d
--
-- Lo aportado después se suma al COSTE: no se inventa ninguna ganancia, pero el
-- dinero no se pierde de vista. Una aportación del mismo día que la valoración
-- se da por incluida en ella. Sin ninguna valoración, el valor sigue siendo lo
-- aportado (es el mismo criterio con «última valoración» = 0). Es el criterio
-- de private.account_worth_on (20261005090000), y esta migración alinea con él
-- lo que quedaba:
--
--   · v_position_value  → y con ella v_net_worth, v_account_worth y el
--                          progreso de las metas, que leen de aquí.
--   · net_worth_history → pasa a leer de net_worth_monthly, así que la curva
--                          mensual, la diaria y el desglose son el MISMO
--                          cálculo y no pueden contar historias distintas.
--   · position_return   → el valor de inicio y el de fin del periodo (y con ella
--                          portfolio_return, que suma sus filas).
--
-- Con los datos reales a fecha de esta migración no cambia ninguna cifra: no hay
-- ninguna aportación posterior a la última valoración de su posición. Lo
-- comprueba scripts/test-patrimonio-diario.mjs comparando antes y después.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- v_position_value: mismas columnas, mismo orden. Solo cambia value_cents.
-- ---------------------------------------------------------------------------
create or replace view public.v_position_value with (security_invoker = true) as
select p.user_id,
       p.id as position_id,
       p.name,
       p.color,
       p.account_id,
       p.since,
       p.archived,
       c.contributed_cents,
       l.valued_on,
       -- Sin valoración todavía, vale lo aportado. Con ella, la valoración más
       -- lo aportado después: no se inventa ganancia, tampoco se pierde dinero.
       coalesce(l.value_cents + coalesce(d.cents, 0), c.contributed_cents)::bigint as value_cents,
       (l.value_cents is null) as sin_valorar
from public.investment_position p
left join public.v_position_contributions c on c.position_id = p.id
left join public.v_position_latest l on l.position_id = p.id
left join lateral (
  select sum(t.amount_cents) as cents
  from public.transaction t
  where t.user_id = p.user_id
    and t.position_id = p.id
    and t.type = 'TRANSFER'
    and t.status <> 'DISCARDED'
    and t.occurred_on > l.valued_on
) d on true;


-- ---------------------------------------------------------------------------
-- net_worth_history: misma firma, mismas columnas. Ahora es un envoltorio de
-- net_worth_monthly, que tiene los mismos cierres.
-- ---------------------------------------------------------------------------
create or replace function public.net_worth_history(p_months integer default 12)
returns table (period_month date, net_worth_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select n.period_month, n.net_worth_cents
  from public.net_worth_monthly(p_months) n
  order by n.period_month;
$$;


-- ---------------------------------------------------------------------------
-- position_return: copia de la vigente (20260828090000_rendimiento_sobre_lo_
-- aportado.sql) salvo el valor de inicio y el de fin:
--
--   inicio = valoración <= p_from + lo aportado entre ella y p_from
--            (sin valoración previa: lo aportado hasta p_from, como antes)
--   fin    = valoración <= p_to   + lo aportado entre ella y p_to
--            (sin valoración: 0 y sin_valorar, como antes)
--
-- Antes, una aportación entre la última valoración y p_to contaba en
-- `aportado` pero no en `fin`, y salía como pérdida; y una entre la valoración
-- previa y p_from no estaba ni en `inicio` ni en `aportado`, y salía como
-- ganancia.
-- ---------------------------------------------------------------------------
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
    select distinct on (v.position_id) v.position_id, v.value_cents, v.date
    from public.valuation v
    where v.date <= p_from
    order by v.position_id, v.date desc
  ),
  v1 as (
    select distinct on (v.position_id) v.position_id, v.value_cents, v.date
    from public.valuation v
    where v.date <= p_to
    order by v.position_id, v.date desc
  ),
  flujos as (
    -- Aportaciones dentro del periodo, sin ponderar (ver 20260828090000).
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
           -- Valor de partida: la valoración previa más lo aportado después de
           -- ella hasta p_from; sin valoración previa, todo lo aportado hasta
           -- p_from, que es lo que costó.
           (coalesce(v0.value_cents, 0) + coalesce((
              select sum(t.amount_cents)
              from public.transaction t
              where t.user_id = p.user_id
                and t.position_id = p.id
                and t.type = 'TRANSFER'
                and t.status <> 'DISCARDED'
                and t.occurred_on <= p_from
                and (v0.date is null or t.occurred_on > v0.date)
            ), 0))::bigint as inicio,
           -- Valor final: la última valoración más lo aportado después de ella.
           -- Sin ninguna valoración se queda en 0 y la fila sale sin_valorar.
           case
             when v1.value_cents is null then 0
             else v1.value_cents + coalesce((
               select sum(t.amount_cents)
               from public.transaction t
               where t.user_id = p.user_id
                 and t.position_id = p.id
                 and t.type = 'TRANSFER'
                 and t.status <> 'DISCARDED'
                 and t.occurred_on <= p_to
                 and t.occurred_on > v1.date
             ), 0)
           end::bigint as fin,
           coalesce(f.total, 0)::bigint as aportado,
           v1.date                      as fecha,
           (v1.value_cents is null)     as sin_valorar
    from public.investment_position p
    left join v0 on v0.position_id = p.id
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
