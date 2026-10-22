-- ===========================================================================
-- Cierre de mes: el resumen de un mes ya terminado.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Qué categorías cambiaron más respecto al mes anterior.
--
-- Se ordena por la magnitud del cambio en euros, no en porcentaje: subir de 2 a
-- 4 euros es un +100 % que a nadie le importa, y subir de 300 a 380 es lo que de
-- verdad explica el mes.
-- ---------------------------------------------------------------------------
create or replace function public.month_changes(p_month date)
returns table (
  category_id   uuid,
  name          text,
  color         text,
  icon          text,
  current_cents bigint,
  previous_cents bigint,
  delta_cents   bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with periodos as (
    select date_trunc('month', p_month::timestamp)::date                        as actual,
           (date_trunc('month', p_month::timestamp) - interval '1 month')::date as anterior
  ),
  actual as (
    select econ_category_id as cid, sum(net_expense_cents) as total
    from public.v_transaction_econ
    where period_month = (select actual from periodos)
    group by 1
  ),
  anterior as (
    select econ_category_id as cid, sum(net_expense_cents) as total
    from public.v_transaction_econ
    where period_month = (select anterior from periodos)
    group by 1
  ),
  claves as (
    select cid from actual
    union
    select cid from anterior
  )
  select k.cid,
         coalesce(c.name, 'Sin categoría'),
         coalesce(c.color, '#9ca3af'),
         coalesce(c.icon, 'circle-help'),
         coalesce(a.total, 0)::bigint,
         coalesce(p.total, 0)::bigint,
         (coalesce(a.total, 0) - coalesce(p.total, 0))::bigint
  from claves k
  left join actual   a on a.cid is not distinct from k.cid
  left join anterior p on p.cid is not distinct from k.cid
  left join public.category c on c.id = k.cid
  where coalesce(a.total, 0) <> coalesce(p.total, 0)
  order by abs(coalesce(a.total, 0) - coalesce(p.total, 0)) desc
  limit 8;
$$;


-- ---------------------------------------------------------------------------
-- Meses que ya tienen movimientos, para poder navegar por los cierres.
-- ---------------------------------------------------------------------------
create view public.v_closed_months with (security_invoker = true) as
select user_id,
       period_month,
       income_cents,
       net_expense_cents,
       month_balance_cents,
       gross_expense_cents,
       reimbursed_cents
from public.v_month_summary
where period_month < date_trunc('month', current_date)::date;


-- ---------------------------------------------------------------------------
-- Marca hasta qué mes se ha visto ya el cierre, para no repetir el aviso.
-- ---------------------------------------------------------------------------
create or replace function public.mark_month_seen(p_month date)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.profile
     set last_shown_month = greatest(
           coalesce(last_shown_month, date '2000-01-01'),
           date_trunc('month', p_month::timestamp)::date)
   where user_id = (select private.current_user_id());
$$;
