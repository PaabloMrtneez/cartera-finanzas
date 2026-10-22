-- ===========================================================================
-- Los datos de los gráficos que la auditoría encontró sin construir.
--
-- Todas las funciones que tocan gasto o ingreso salen de v_transaction_econ,
-- que ya excluye los traspasos y hace que un reembolso reste de la categoría
-- del gasto enlazado. Repetir esos filtros consulta a consulta es cómo se
-- acaban descuadrando dos pantallas que deberían decir lo mismo.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Movimientos · «Sin clasificar por mes»
--
-- El prototipo lo explica: «Los meses con más cola son los que faltan reglas
-- de comercio». Es un mapa de dónde falta trabajo, no una cifra más.
-- ---------------------------------------------------------------------------
create or replace function public.unclassified_by_month(p_months integer default 6)
returns table (period_month date, cuantos integer, cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select m::date as mes
    from generate_series(
           date_trunc('month', current_date) - make_interval(months => p_months - 1),
           date_trunc('month', current_date),
           interval '1 month'
         ) m
  )
  select s.mes,
         coalesce(count(t.id), 0)::integer,
         coalesce(sum(t.amount_cents), 0)::bigint
  from meses s
  left join public.transaction t
    on t.period_month = s.mes
   and t.category_id is null
   and t.type = 'EXPENSE'
   and t.status <> 'DISCARDED'
  group by s.mes
  order by s.mes;
$$;


-- ---------------------------------------------------------------------------
-- Detalle de movimiento · «Categoría, 6 meses»
--
-- Pone un gasto en contexto: qué peso tiene dentro de su categoría este mes y
-- cómo van los seis meses. Un importe suelto no dice si 34 € es mucho.
-- ---------------------------------------------------------------------------
create or replace function public.category_context(p_category uuid, p_month date, p_months integer default 6)
returns table (period_month date, cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select m::date as mes
    from generate_series(
           date_trunc('month', p_month::timestamp) - make_interval(months => p_months - 1),
           date_trunc('month', p_month::timestamp),
           interval '1 month'
         ) m
  )
  select s.mes,
         coalesce((
           select sum(e.net_expense_cents)
           from public.v_transaction_econ e
           where e.period_month = s.mes
             -- `is not distinct from` para que también funcione con NULL, que es
             -- «Sin categoría»: no es una fila, es la ausencia de una.
             and e.econ_category_id is not distinct from p_category
         ), 0)::bigint
  from meses s
  order by s.mes;
$$;


-- ---------------------------------------------------------------------------
-- Cuentas · evolución del saldo total
--
-- El prototipo pone un minigráfico con «Últimos 6 meses: +1334,00 € en cuentas
-- activas». Es el patrimonio en cuentas, sin inversiones: lo líquido.
-- ---------------------------------------------------------------------------
create or replace function public.account_balance_history(p_months integer default 6)
returns table (period_month date, cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with cierres as (
    select m::date as mes,
           (m + interval '1 month' - interval '1 day')::date as fin
    from generate_series(
           date_trunc('month', current_date) - make_interval(months => p_months - 1),
           date_trunc('month', current_date),
           interval '1 month'
         ) m
  )
  select c.mes,
         (
           coalesce((select sum(a.initial_balance_cents) from public.account a), 0)
           + coalesce((
               select sum(v.delta_cents)
               from public.v_account_movement v
               where v.occurred_on <= c.fin
             ), 0)
         )::bigint
  from cierres c
  order by c.mes;
$$;


-- ---------------------------------------------------------------------------
-- Patrimonio · «Lo que sumas cada mes»
--
-- Ingresos menos gasto neto, mes a mes. El prototipo lo dice mejor que
-- cualquier comentario: «Los traspasos no cuentan: mueven, no crean».
-- ---------------------------------------------------------------------------
create or replace function public.monthly_savings(p_months integer default 12)
returns table (period_month date, income_cents bigint, net_expense_cents bigint, saved_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select m::date as mes
    from generate_series(
           date_trunc('month', current_date) - make_interval(months => p_months - 1),
           date_trunc('month', current_date),
           interval '1 month'
         ) m
  ),
  datos as (
    select e.period_month,
           sum(e.real_income_cents)::bigint  as ingresos,
           sum(e.net_expense_cents)::bigint  as gasto
    from public.v_transaction_econ e
    group by 1
  )
  select s.mes,
         coalesce(d.ingresos, 0)::bigint,
         coalesce(d.gasto, 0)::bigint,
         (coalesce(d.ingresos, 0) - coalesce(d.gasto, 0))::bigint
  from meses s
  left join datos d on d.period_month = s.mes
  order by s.mes;
$$;


-- ---------------------------------------------------------------------------
-- Patrimonio · «Cierre por año»
--
-- Lo ahorrado por año, y el patrimonio al cierre de cada uno. Del año en curso
-- se devuelve lo que hay hasta hoy, marcado como en curso para poder decirlo.
-- ---------------------------------------------------------------------------
create or replace function public.yearly_close()
returns table (anio integer, income_cents bigint, net_expense_cents bigint, saved_cents bigint, en_curso boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select extract(year from e.period_month)::integer                    as anio,
         sum(e.real_income_cents)::bigint                              as ingresos,
         sum(e.net_expense_cents)::bigint                              as gasto,
         (sum(e.real_income_cents) - sum(e.net_expense_cents))::bigint as ahorrado,
         extract(year from e.period_month) = extract(year from current_date) as en_curso
  from public.v_transaction_econ e
  group by 1, 5
  order by 1 desc;
$$;


-- ---------------------------------------------------------------------------
-- Inversiones · «Rendimiento acumulado»
--
-- Una curva por posición más el total, en porcentaje y con base 0 % al inicio
-- del periodo, que es lo que permite comparar una posición de 500 € con otra
-- de 5.000 en el mismo eje.
--
-- El porcentaje se calcula SIEMPRE sobre el coste aportado hasta cada fecha, no
-- sobre la primera valoración: así meter dinero nuevo no aparece como si
-- hubiera rendido.
-- ---------------------------------------------------------------------------
create or replace function public.position_performance(p_from date, p_to date)
returns table (
  position_id uuid,
  name        text,
  color       text,
  fecha       date,
  value_cents bigint,
  cost_cents  bigint,
  return_pct  numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  -- Las fechas en las que hay algo que dibujar: las valoraciones del periodo.
  with fechas as (
    select distinct v.date as fecha
    from public.valuation v
    where v.date between p_from and p_to
  ),
  pares as (
    select p.id, p.name, p.color, f.fecha
    from public.investment_position p
    cross join fechas f
    where not p.archived and p.since <= f.fecha
  )
  select pr.id,
         pr.name,
         pr.color,
         pr.fecha,
         -- Valor a esa fecha: la última valoración conocida, y si no hay
         -- ninguna todavía, lo aportado. La misma regla que v_position_value.
         coalesce(
           (select v.value_cents
            from public.valuation v
            where v.position_id = pr.id and v.date <= pr.fecha
            order by v.date desc
            limit 1),
           (select coalesce(sum(t.amount_cents), 0)
            from public.transaction t
            where t.position_id = pr.id
              and t.type = 'TRANSFER'
              and t.status <> 'DISCARDED'
              and t.occurred_on <= pr.fecha)
         )::bigint as valor,
         (select coalesce(sum(t.amount_cents), 0)
          from public.transaction t
          where t.position_id = pr.id
            and t.type = 'TRANSFER'
            and t.status <> 'DISCARDED'
            and t.occurred_on <= pr.fecha)::bigint as coste,
         round(
           100.0 * (
             coalesce(
               (select v.value_cents from public.valuation v
                where v.position_id = pr.id and v.date <= pr.fecha
                order by v.date desc limit 1),
               (select coalesce(sum(t.amount_cents), 0) from public.transaction t
                where t.position_id = pr.id and t.type = 'TRANSFER'
                  and t.status <> 'DISCARDED' and t.occurred_on <= pr.fecha)
             )
             - (select coalesce(sum(t.amount_cents), 0) from public.transaction t
                where t.position_id = pr.id and t.type = 'TRANSFER'
                  and t.status <> 'DISCARDED' and t.occurred_on <= pr.fecha)
           ) / nullif(
             (select coalesce(sum(t.amount_cents), 0) from public.transaction t
              where t.position_id = pr.id and t.type = 'TRANSFER'
                and t.status <> 'DISCARDED' and t.occurred_on <= pr.fecha),
             0
           ),
           2
         ) as pct
  from pares pr
  order by pr.name, pr.fecha;
$$;


-- ---------------------------------------------------------------------------
-- Suscripciones · «Compromiso, 12 meses»
--
-- Cuánto te comprometías cada mes, mirando qué suscripciones estaban vivas
-- entonces. El prototipo lo ilustra con «Subió al contratar iCloud+ en mayo»:
-- la gracia es ver el escalón, no el número de hoy.
--
-- Una suscripción cuenta en un mes si ya había empezado. Las pausadas dejan de
-- contar de aquí en adelante, no en el pasado: entonces sí pagabas.
-- ---------------------------------------------------------------------------
create or replace function public.commitment_history(p_months integer default 12)
returns table (period_month date, monthly_cents bigint, cuantas integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select m::date as mes
    from generate_series(
           date_trunc('month', current_date) - make_interval(months => p_months - 1),
           date_trunc('month', current_date),
           interval '1 month'
         ) m
  )
  select s.mes,
         coalesce(sum(
           round(sub.amount_cents * private.charges_per_year(sub.periodicity) / 12.0)
         ), 0)::bigint,
         coalesce(count(sub.id), 0)::integer
  from meses s
  left join public.subscription sub
    on sub.started_at <= (s.mes + interval '1 month' - interval '1 day')::date
   -- En el mes en curso, una pausada ya no compromete. En los pasados, sí
   -- contaba: se pagó.
   and (sub.active or s.mes < date_trunc('month', current_date)::date)
  group by s.mes
  order by s.mes;
$$;


-- ---------------------------------------------------------------------------
-- Resumen escritorio · «Categorías, agosto contra julio»
--
-- Barras divergentes: qué categorías han subido y cuáles han bajado respecto al
-- mes anterior. Se devuelven las dos cifras y la diferencia, ordenadas por
-- cuánto se mueven, que es lo que se quiere mirar primero.
-- ---------------------------------------------------------------------------
create or replace function public.category_comparison(p_month date)
returns table (
  category_id  uuid,
  name         text,
  color        text,
  icon         text,
  actual_cents bigint,
  previo_cents bigint,
  delta_cents  bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with previo as (
    select (date_trunc('month', p_month::timestamp) - interval '1 month')::date as mes
  ),
  actual as (
    select date_trunc('month', p_month::timestamp)::date as mes
  ),
  -- Las claves de los dos meses primero, y luego se suma cada una. Un FULL JOIN
  -- con `is not distinct from` no es hash-joinable en PostgreSQL y revienta en
  -- tiempo de ejecución con el error 0A000.
  claves as (
    select distinct e.econ_category_id as cid
    from public.v_transaction_econ e, actual a, previo p
    where e.period_month in (a.mes, p.mes)
  )
  select k.cid,
         coalesce(c.name, 'Sin categoría'),
         coalesce(c.color, '#9ca3af'),
         coalesce(c.icon, 'circle-help'),
         coalesce((
           select sum(e.net_expense_cents) from public.v_transaction_econ e, actual a
           where e.period_month = a.mes and e.econ_category_id is not distinct from k.cid
         ), 0)::bigint as ahora,
         coalesce((
           select sum(e.net_expense_cents) from public.v_transaction_econ e, previo p
           where e.period_month = p.mes and e.econ_category_id is not distinct from k.cid
         ), 0)::bigint as antes,
         (
           coalesce((
             select sum(e.net_expense_cents) from public.v_transaction_econ e, actual a
             where e.period_month = a.mes and e.econ_category_id is not distinct from k.cid
           ), 0)
           - coalesce((
             select sum(e.net_expense_cents) from public.v_transaction_econ e, previo p
             where e.period_month = p.mes and e.econ_category_id is not distinct from k.cid
           ), 0)
         )::bigint as delta
  from claves k
  left join public.category c on c.id = k.cid
  order by abs(
    coalesce((
      select sum(e.net_expense_cents) from public.v_transaction_econ e, actual a
      where e.period_month = a.mes and e.econ_category_id is not distinct from k.cid
    ), 0)
    - coalesce((
      select sum(e.net_expense_cents) from public.v_transaction_econ e, previo p
      where e.period_month = p.mes and e.econ_category_id is not distinct from k.cid
    ), 0)
  ) desc;
$$;
