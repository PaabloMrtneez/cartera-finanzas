-- ===========================================================================
-- Límites de gasto por categoría, y la comparativa contra la media.
--
-- Los límites NUNCA bloquean: no impiden guardar un movimiento ni cambian los
-- informes. Solo colorean y avisan.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Consumo de un límite en un mes.
--
-- El invariante que más importa está en el LEFT JOIN: los movimientos sin
-- clasificar tienen econ_category_id NULL, y `NULL = <uuid>` es NULL, así que
-- no casan nunca. Un gasto en «Sin categoría» es aritméticamente incapaz de
-- consumir tope o disparar un aviso. No hace falta código para eso.
--
-- El arrastre es acumulativo: lo que sobró en meses anteriores se suma al tope
-- de este, pero solo si el límite lo tiene activado.
-- ---------------------------------------------------------------------------
create or replace function public.budget_status(p_month date)
returns table (
  budget_id            uuid,
  category_id          uuid,
  name                 text,
  color                text,
  icon                 text,
  cap_cents            bigint,
  rollover_cents       bigint,
  effective_cap_cents  bigint,
  spent_cents          bigint,
  pct                  numeric,
  warn_at_80           boolean,
  rollover_unspent     boolean,
  discount_reimbursements boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with objetivo as (
    select date_trunc('month', p_month::timestamp)::date as mes
  ),
  meses as (
    -- Todos los meses desde que existe el límite hasta el mes pedido.
    select b.id as bid,
           generate_series(
             least(date_trunc('month', b.created_at::timestamp)::date, (select mes from objetivo)),
             (select mes from objetivo),
             interval '1 month'
           )::date as pm
    from public.budget b
  ),
  gasto as (
    select m.bid,
           m.pm,
           b.monthly_cap_cents,
           b.rollover_unspent,
           coalesce(sum(
             case
               -- Un gasto siempre consume.
               when e.type = 'EXPENSE' then e.net_expense_cents
               -- Un reembolso resta, pero solo si el límite lo descuenta.
               when b.discount_reimbursements then e.net_expense_cents
               else 0
             end
           ), 0) as gastado
    from meses m
    join public.budget b on b.id = m.bid
    left join public.v_transaction_econ e
      on e.period_month = m.pm
     and e.econ_category_id = b.category_id
    group by m.bid, m.pm, b.monthly_cap_cents, b.rollover_unspent
  ),
  arrastrado as (
    select bid, pm, monthly_cap_cents, gastado, rollover_unspent,
           greatest(0, coalesce(sum(
             case when rollover_unspent then monthly_cap_cents - gastado else 0 end
           ) over (
             partition by bid order by pm
             rows between unbounded preceding and 1 preceding
           ), 0)) as arrastre
    from gasto
  )
  select b.id,
         b.category_id,
         c.name,
         c.color,
         c.icon,
         b.monthly_cap_cents,
         a.arrastre,
         b.monthly_cap_cents + a.arrastre,
         a.gastado,
         round(100.0 * a.gastado / nullif(b.monthly_cap_cents + a.arrastre, 0), 1),
         b.warn_at_80,
         b.rollover_unspent,
         b.discount_reimbursements
  from arrastrado a
  join public.budget b on b.id = a.bid
  join public.category c on c.id = b.category_id
  where a.pm = (select mes from objetivo)
  order by round(100.0 * a.gastado / nullif(b.monthly_cap_cents + a.arrastre, 0), 1) desc nulls last;
$$;


-- ---------------------------------------------------------------------------
-- Media de los 6 meses COMPLETOS anteriores, por categoría.
--
-- Se divide siempre entre 6, no entre los meses con datos. Un gasto puntual de
-- 600 € en un solo mes debe leerse como una media de 100 €/mes, no de 600.
--
-- `months_with_data` permite a la interfaz callarse cuando el histórico es tan
-- corto que la comparación engañaría: arrancando de cero, los primeros meses la
-- media no significa nada.
-- ---------------------------------------------------------------------------
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
           sum(e.net_expense_cents) as total,
           count(distinct e.period_month)::int as meses
    from public.v_transaction_econ e
    where e.period_month between (select desde from ventana) and (select hasta from ventana)
    group by 1
  ),
  actual as (
    select e.econ_category_id as cid, sum(e.net_expense_cents) as total
    from public.v_transaction_econ e
    where e.period_month = (select mes from ventana)
    group by 1
  )
  select coalesce(h.cid, a.cid),
         coalesce(c.name, 'Sin categoría'),
         coalesce(c.color, '#9ca3af'),
         coalesce(c.icon, 'circle-help'),
         (coalesce(h.total, 0) / 6)::bigint,
         coalesce(a.total, 0)::bigint,
         coalesce(h.meses, 0)
  from historico h
  full join actual a on a.cid is not distinct from h.cid
  left join public.category c on c.id = coalesce(h.cid, a.cid)
  where coalesce(h.total, 0) <> 0 or coalesce(a.total, 0) <> 0
  order by abs(coalesce(a.total, 0) - coalesce(h.total, 0) / 6) desc;
$$;


-- ---------------------------------------------------------------------------
-- Hallazgos del mes: lo que merece que te lo cuenten sin buscarlo.
--
-- Cada fila lleva su cifra y a dónde ir, para que la interfaz no tenga que
-- recalcular nada ni inventarse los enlaces.
-- ---------------------------------------------------------------------------
create or replace function public.month_findings(p_month date)
returns table (
  kind    text,
  title   text,
  detail  text,
  cents   bigint,
  count   integer,
  href    text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with mes as (select date_trunc('month', p_month::timestamp)::date as m)

  -- Pagos del Atajo que ninguna regla supo clasificar.
  select 'pendientes',
         'Pagos pendientes de confirmar',
         'Llegaron del Atajo y ninguna regla los reconoció.',
         coalesce(sum(t.amount_cents), 0)::bigint,
         count(*)::int,
         '/movimientos?pendientes=1'
  from public.transaction t
  where t.status = 'PENDING'
  having count(*) > 0

  union all

  -- Gasto sin categoría en el mes: distorsiona el reparto.
  select 'sin-clasificar',
         'Movimientos sin categoría',
         'Sin clasificar no cuentan en el reparto ni consumen ningún límite.',
         coalesce(sum(e.net_expense_cents), 0)::bigint,
         count(*)::int,
         '/movimientos?categoria=sin'
  from public.v_transaction_econ e
  where e.period_month = (select m from mes)
    and e.econ_category_id is null
    and e.type = 'EXPENSE'
  having count(*) > 0

  union all

  -- Límites ya rebasados.
  select 'limite-pasado',
         'Límites rebasados',
         'Ya has pasado el tope de este mes en estas categorías.',
         coalesce(sum(s.spent_cents - s.effective_cap_cents), 0)::bigint,
         count(*)::int,
         '/analisis'
  from public.budget_status((select m from mes)) s
  where s.spent_cents > s.effective_cap_cents
  having count(*) > 0

  union all

  -- Suscripciones cuyo cargo ya tocaba y no se ha generado.
  select 'suscripciones',
         'Cargos de suscripción sin generar',
         'Su fecha de cobro ya pasó pero no están en tus movimientos.',
         coalesce(sum(s.amount_cents), 0)::bigint,
         count(*)::int,
         '/suscripciones'
  from public.v_subscription_summary s
  where s.active and s.due
  having count(*) > 0;
$$;
