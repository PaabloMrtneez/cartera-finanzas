-- ===========================================================================
-- Análisis más profundo: la tendencia de 12 meses con su comparación año a año,
-- y la tendencia por categoría.
--
-- Todo sale de v_transaction_econ, así que hereda los tres invariantes de una
-- vez (sin traspasos, reembolsos imputados a la categoría del gasto, un ingreso
-- normal no cuenta como gasto). Y todo es DERIVADO: nada se almacena.
--
-- Con poco histórico estas series salen cortas —o el año pasado, vacío— y la
-- pantalla se calla o lo enseña tenue. No es un fallo: es que aún no hay con qué
-- comparar. Se llenan solas con el uso.
--
-- Nota de PostgreSQL: se comparan meses con subconsultas correlacionadas, NO con
-- FULL JOIN sobre una categoría que puede ser NULL —eso no es hash-joinable y
-- revienta con 0A000, como ya avisa category_comparison—.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Año a año: para cada uno de los últimos p_months meses, el gasto neto y los
-- ingresos, junto a los del MISMO mes del año anterior. La pantalla dibuja la
-- serie de este año sólida y la del pasado tenue, y saca el titular «este mes
-- frente al año pasado» de la última fila.
-- ---------------------------------------------------------------------------
create or replace function public.year_over_year(p_month date, p_months integer default 12)
returns table (
  period_month           date,
  net_expense_cents      bigint,
  income_cents           bigint,
  prev_net_expense_cents bigint,
  prev_income_cents      bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select generate_series(
             (date_trunc('month', p_month::timestamp) - make_interval(months => p_months - 1))::date,
             date_trunc('month', p_month::timestamp)::date,
             interval '1 month'
           )::date as mes
  )
  -- Sin coalesce a propósito: un mes SIN ningún movimiento sale NULL (hueco en
  -- la línea), no 0. Con poco histórico, pintar 0 parecería «gastaste nada» en
  -- meses que en realidad no llegaste a registrar. Un mes con movimientos cuyo
  -- neto sea 0 sí devuelve 0, porque ahí sí hubo actividad.
  select m.mes,
         (select sum(e.net_expense_cents) from public.v_transaction_econ e
          where e.period_month = m.mes)::bigint,
         (select sum(e.real_income_cents) from public.v_transaction_econ e
          where e.period_month = m.mes)::bigint,
         (select sum(e.net_expense_cents) from public.v_transaction_econ e
          where e.period_month = (m.mes - interval '1 year')::date)::bigint,
         (select sum(e.real_income_cents) from public.v_transaction_econ e
          where e.period_month = (m.mes - interval '1 year')::date)::bigint
  from meses m
  order by m.mes;
$$;

comment on function public.year_over_year is
  'Serie de p_months meses con gasto neto e ingresos, y los del mismo mes del año anterior, para la tendencia y la comparativa año a año. Todo derivado de v_transaction_econ.';


-- ---------------------------------------------------------------------------
-- Tendencia por categoría: el gasto neto mensual de cada categoría en la que has
-- gastado algo durante la ventana, incluidos los meses a cero. La pantalla pinta
-- una miniserie por categoría para pillar las que se van creciendo.
--
-- Se incluye «Sin categoría» (econ_category_id NULL) como un grupo más, tratado
-- con `is not distinct from`.
-- ---------------------------------------------------------------------------
create or replace function public.category_trend(p_month date, p_months integer default 12)
returns table (
  category_id  uuid,
  name         text,
  color        text,
  icon         text,
  period_month date,
  net_cents    bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select generate_series(
             (date_trunc('month', p_month::timestamp) - make_interval(months => p_months - 1))::date,
             date_trunc('month', p_month::timestamp)::date,
             interval '1 month'
           )::date as mes
  ),
  -- Solo las categorías con gasto neto POSITIVO en la ventana: las que no tocaste
  -- (o cuyo reembolso anuló el gasto) no aportan una tendencia que mirar.
  cats as (
    select e.econ_category_id as cid
    from public.v_transaction_econ e, meses m
    where e.period_month = m.mes
    group by e.econ_category_id
    having sum(e.net_expense_cents) > 0
  )
  select k.cid,
         coalesce(c.name, 'Sin categoría'),
         coalesce(c.color, '#9ca3af'),
         coalesce(c.icon, 'circle-help'),
         m.mes,
         coalesce((
           select sum(e.net_expense_cents)
           from public.v_transaction_econ e
           where e.period_month = m.mes
             and e.econ_category_id is not distinct from k.cid
         ), 0)::bigint
  from cats k
  cross join meses m
  left join public.category c on c.id = k.cid
  order by k.cid, m.mes;
$$;

comment on function public.category_trend is
  'Gasto neto mensual por categoría (con meses a cero) sobre los últimos p_months, para la tendencia por categoría. Solo categorías con gasto neto positivo en la ventana.';
