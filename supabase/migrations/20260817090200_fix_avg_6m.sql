-- ===========================================================================
-- Corrección de category_avg_6m.
--
-- La versión anterior cruzaba histórico y mes actual con
-- `full join ... on a.cid is not distinct from h.cid`, para que las filas sin
-- categoría (cid NULL) también se emparejaran. PostgreSQL no sabe resolver un
-- FULL JOIN con esa condición —no es hash-joinable ni merge-joinable— y falla
-- en tiempo de ejecución con 0A000.
--
-- La forma correcta: reunir primero el conjunto de categorías de los dos lados
-- con un UNION, que sí trata NULL como un valor más, y colgar de ahí los dos
-- agregados con LEFT JOIN normales.
-- ===========================================================================

create or replace function public.category_avg_6m(p_month date)
returns table (
  category_id      uuid,
  name             text,
  color            text,
  icon             text,
  avg_cents        bigint,
  current_cents    bigint,
  months_with_data integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ventana as (
    select (date_trunc('month', p_month::timestamp) - interval '6 months')::date as desde,
           (date_trunc('month', p_month::timestamp) - interval '1 month')::date  as hasta,
           date_trunc('month', p_month::timestamp)::date                        as mes
  ),
  historico as (
    select e.econ_category_id as cid,
           sum(e.net_expense_cents)            as total,
           count(distinct e.period_month)::int  as meses
    from public.v_transaction_econ e
    where e.period_month between (select desde from ventana) and (select hasta from ventana)
    group by 1
  ),
  actual as (
    select e.econ_category_id as cid, sum(e.net_expense_cents) as total
    from public.v_transaction_econ e
    where e.period_month = (select mes from ventana)
    group by 1
  ),
  -- UNION (no UNION ALL) para quedarse con cada categoría una sola vez,
  -- incluida la ausencia de categoría.
  claves as (
    select cid from historico
    union
    select cid from actual
  )
  select k.cid,
         coalesce(c.name, 'Sin categoría'),
         coalesce(c.color, '#9ca3af'),
         coalesce(c.icon, 'circle-help'),
         (coalesce(h.total, 0) / 6)::bigint,
         coalesce(a.total, 0)::bigint,
         coalesce(h.meses, 0)
  from claves k
  left join historico h on h.cid is not distinct from k.cid
  left join actual    a on a.cid is not distinct from k.cid
  left join public.category c on c.id = k.cid
  where coalesce(h.total, 0) <> 0 or coalesce(a.total, 0) <> 0
  order by abs(coalesce(a.total, 0) - coalesce(h.total, 0) / 6) desc;
$$;
