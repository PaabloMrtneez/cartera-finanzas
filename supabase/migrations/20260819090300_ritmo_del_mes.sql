-- ===========================================================================
-- «Ritmo del mes»: el gasto neto acumulado día a día, contra el mes anterior.
--
-- Sale de v_transaction_econ, así que hereda de una vez los tres invariantes:
-- los traspasos no están, los reembolsos restan del gasto de su categoría, y un
-- ingreso normal no cuenta como gasto negativo.
--
-- Dos decisiones sobre el eje:
--
-- 1. Los días futuros del mes en curso devuelven NULL, no cero. Un cero
--    dibujaría una línea plana hasta fin de mes y parecería que has dejado de
--    gastar; con NULL la línea termina en hoy, que es lo único que se sabe.
--
-- 2. Si el mes anterior es más corto —comparar el 30 de marzo con febrero— su
--    serie se queda en su último día en lugar de cortarse. Es lo honesto: a
--    estas alturas febrero ya había cerrado, y su acumulado es el total.
-- ===========================================================================

create or replace function public.month_pace(p_month date)
returns table (
  dia            integer,
  actual_cents   bigint,
  anterior_cents bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with limites as (
    select date_trunc('month', p_month::timestamp)::date                       as mes,
           (date_trunc('month', p_month::timestamp) - interval '1 month')::date as previo
  ),
  dias as (
    select l.*,
           extract(day from (l.mes + interval '1 month' - interval '1 day'))::int    as dias_mes,
           extract(day from (l.previo + interval '1 month' - interval '1 day'))::int as dias_previo,
           -- Hasta qué día se sabe algo: hoy si el mes está en curso, todo si ya pasó.
           case
             when l.mes = date_trunc('month', current_date)::date
               then extract(day from current_date)::int
             else extract(day from (l.mes + interval '1 month' - interval '1 day'))::int
           end as hasta
    from limites l
  ),
  -- Gasto neto por día de cada uno de los dos meses.
  por_dia as (
    select e.period_month,
           extract(day from e.occurred_on)::int as d,
           sum(e.net_expense_cents)::bigint     as cents
    from public.v_transaction_econ e, limites l
    where e.period_month in (l.mes, l.previo)
    group by 1, 2
  ),
  eje as (
    select d.*, g.n as dia
    from dias d, generate_series(1, d.dias_mes) g(n)
  )
  select e.dia,
         case
           when e.dia > e.hasta then null
           else coalesce((
             select sum(p.cents)
             from por_dia p
             where p.period_month = e.mes and p.d <= e.dia
           ), 0)::bigint
         end,
         coalesce((
           select sum(p.cents)
           from por_dia p
           -- El recorte: pasado el último día del mes previo, su acumulado ya
           -- no crece, así que se compara contra su total.
           where p.period_month = e.previo and p.d <= least(e.dia, e.dias_previo)
         ), 0)::bigint
  from eje e
  order by e.dia;
$$;

comment on function public.month_pace is
  'Gasto neto acumulado día a día del mes y del anterior, para el gráfico de ritmo. Los días futuros son NULL: la línea termina en hoy.';
