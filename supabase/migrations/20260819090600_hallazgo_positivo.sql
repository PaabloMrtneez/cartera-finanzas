-- ===========================================================================
-- Un hallazgo que no sea una regañina.
--
-- Los cuatro que había eran todos avisos: pendientes, sin clasificar, límite
-- pasado y suscripciones sin generar. El prototipo tiene uno positivo —«Llevas
-- siete meses ahorrando»— y no es un adorno: una app de finanzas que solo te
-- dice lo que haces mal se acaba cerrando, y entonces deja de servir para nada.
--
-- Se añade una columna `tono` para que la interfaz sepa que ese no lleva el
-- triángulo de aviso. Sin ella habría que reconocer el hallazgo por su `kind`
-- desde el componente, que es exactamente el tipo de regla escondida que luego
-- nadie encuentra.
-- ===========================================================================

drop function if exists public.month_findings(date);

create function public.month_findings(p_month date)
returns table (
  kind    text,
  title   text,
  detail  text,
  cents   bigint,
  count   integer,
  href    text,
  tono    text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with mes as (select date_trunc('month', p_month::timestamp)::date as m),

  -- Meses seguidos ahorrando, contando hacia atrás desde el último cerrado.
  -- El mes en curso no cuenta: todavía puede torcerse.
  ahorro as (
    select e.period_month,
           (sum(e.real_income_cents) - sum(e.net_expense_cents)) as saldo
    from public.v_transaction_econ e
    where e.period_month < date_trunc('month', current_date)::date
    group by e.period_month
  ),
  ordenados as (
    select period_month, saldo,
           row_number() over (order by period_month desc) as pos
    from ahorro
  ),
  -- El primer mes en rojo corta la racha.
  corte as (
    select coalesce(min(pos), 999) as donde from ordenados where saldo <= 0
  ),
  racha as (
    select count(*)::int as meses, coalesce(sum(o.saldo), 0)::bigint as total
    from ordenados o, corte c
    where o.pos < c.donde
  )

  select 'pendientes',
         'Pagos pendientes de confirmar',
         'Llegaron del Atajo y ninguna regla los reconoció.',
         coalesce(sum(t.amount_cents), 0)::bigint,
         count(*)::int,
         '/movimientos?pendientes=1',
         'aviso'
  from public.transaction t
  where t.status = 'PENDING'
  having count(*) > 0

  union all

  select 'sin-clasificar',
         'Gasto sin clasificar',
         'Sin categoría no consume límite ni entra en el reparto.',
         coalesce(sum(e.net_expense_cents), 0)::bigint,
         count(*)::int,
         '/movimientos?categoria=sin',
         'aviso'
  from public.v_transaction_econ e, mes
  where e.period_month = mes.m and e.econ_category_id is null and e.net_expense_cents > 0
  having count(*) > 0

  union all

  select 'limite-pasado',
         'Límites pasados',
         'Te has pasado del tope que te pusiste.',
         coalesce(sum(b.spent_cents - b.cap_cents), 0)::bigint,
         count(*)::int,
         '/analisis',
         'aviso'
  from public.budget_status(p_month) b
  where b.spent_cents > b.cap_cents
  having count(*) > 0

  union all

  select 'suscripciones',
         'Cargos de suscripción sin generar',
         'Su fecha de cobro ya pasó pero no están en tus movimientos.',
         coalesce(sum(s.amount_cents), 0)::bigint,
         count(*)::int,
         '/suscripciones',
         'aviso'
  from public.v_subscription_summary s
  where s.active and s.due
  having count(*) > 0

  union all

  -- El positivo. Desde tres meses seguidos, que es cuando deja de ser
  -- casualidad y empieza a ser una costumbre.
  select 'racha-ahorro',
         case when r.meses = 1 then 'Cerraste el mes ahorrando'
              else 'Llevas ' || r.meses || ' meses ahorrando' end,
         'Ingresas más de lo que gastas, mes tras mes.',
         r.total,
         r.meses,
         '/patrimonio',
         'bien'
  from racha r
  where r.meses >= 3;
$$;

comment on function public.month_findings is
  'Lo que merece contarse sin buscarlo. `tono` separa el aviso del que va bien: una app que solo riñe se acaba cerrando.';
