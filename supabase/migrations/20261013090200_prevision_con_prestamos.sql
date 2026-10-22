-- ===========================================================================
-- La previsión del mes cuenta los intereses de los préstamos como lo FIJO que
-- son, no como gasto discrecional.
--
-- Sin esto, la cuota cobrada el día 1 (intereses: un gasto como otro
-- cualquiera) entraba en el ritmo y se extrapolaba al resto del mes: el día 2,
-- 50 € de intereses se convertían en 700 € de previsión, y un límite sobre
-- «Intereses» podía disparar el aviso predictivo sin motivo. Igual que con las
-- suscripciones (20260916090100_prevision_de_mes.sql):
--
--   1. Lo YA cobrado de un préstamo (intereses y comisiones, `loan_id`) se
--      descuenta de lo discrecional, en neto (sus reembolsos, también).
--   2. Lo que FALTA por cobrar este mes —los intereses de las cuotas aún no
--      generadas con fecha dentro del mes— se suma como pendiente fijo, en la
--      misma columna `suscripciones_cents` («lo fijo que falta»), y por
--      categoría (la de intereses del préstamo) en category_forecast.
--
-- Es la MISMA función con esas dos piezas añadidas: para quien no tiene
-- préstamos, el resultado es idéntico (lo comprueba scripts/test-prestamos.mjs
-- con los datos reales). Las firmas no cambian, así que los permisos se
-- conservan.
-- ===========================================================================

create or replace function public.month_forecast(p_month date)
returns table (
  dias_transcurridos  integer,
  dias_totales        integer,
  dias_restantes      integer,
  gasto_real_cents    bigint,
  suscripciones_cents bigint,
  extrapolado_cents   bigint,
  prevision_cents     bigint,
  ingresos_real_cents bigint
)
language sql
stable
set search_path = ''
as $$
  with marco as (
    select date_trunc('month', p_month::timestamp)::date as mes,
           (date_trunc('month', p_month::timestamp) + interval '1 month' - interval '1 day')::date
             as fin_mes
  ),
  -- El corte: hasta hoy si el mes está en curso, todo el mes si ya pasó, y antes
  -- de empezar si es futuro (así no cuenta días ni extrapola).
  dias as (
    select m.mes,
           m.fin_mes,
           extract(day from m.fin_mes)::int as dias_totales,
           case
             when m.mes = date_trunc('month', current_date)::date then current_date
             when m.mes <  date_trunc('month', current_date)::date then m.fin_mes
             else (m.mes - interval '1 day')::date
           end as corte
    from marco m
  ),
  dd as (
    select d.*,
           greatest(0, (d.corte - d.mes + 1))::int as dias_transcurridos
    from dias d
  ),
  -- (1) Lo gastado y lo ingresado hasta el corte, ya netos.
  realizado as (
    select coalesce(sum(e.net_expense_cents), 0)::bigint as gasto_real,
           coalesce(sum(e.real_income_cents), 0)::bigint as ingresos_real
    from public.v_transaction_econ e
    join dd on e.period_month = dd.mes and e.occurred_on <= dd.corte
  ),
  -- Lo recurrente ya cargado hasta el corte —suscripciones y, ahora, intereses
  -- y comisiones de préstamos—, en NETO, para descontarlo de lo discrecional.
  susc_pasado as (
    select coalesce(sum(s.net), 0)::bigint as cents
    from (
      select t.amount_cents as net
      from public.transaction t
      join dd on t.period_month = dd.mes and t.occurred_on <= dd.corte
      where t.type = 'EXPENSE'
        and t.status <> 'DISCARDED'
        and (t.subscription_id is not null or t.loan_id is not null)
      union all
      select -rb.amount_cents
      from public.transaction rb
      join public.transaction ex
        on ex.id = rb.reimburses_id and ex.user_id = rb.user_id
      join dd on rb.period_month = dd.mes and rb.occurred_on <= dd.corte
      where rb.type = 'INCOME'
        and rb.reimburses_id is not null
        and rb.status <> 'DISCARDED'
        and (ex.subscription_id is not null or ex.loan_id is not null)
    ) s
  ),
  -- (2) Suscripciones que faltan por cargar este mes (solo el mes en curso).
  susc_futuro as (
    select coalesce(sum(u.amount_cents), 0)::bigint as cents
    from dd
    left join lateral (
      select uc.amount_cents
      from public.upcoming_charges(greatest(0, (dd.fin_mes - current_date))::int) uc
      where dd.mes = date_trunc('month', current_date)::date
        and uc.charge_date <= dd.fin_mes
    ) u on true
  ),
  -- (2b) Intereses de las cuotas de préstamo que faltan por cobrar este mes: las
  -- aún no generadas (después de la marca de agua) con fecha dentro del mes. Por
  -- construcción no solapan con (1), que solo ve las ya generadas.
  prest_futuro as (
    select coalesce(sum(p.interest_cents), 0)::bigint as cents
    from dd
    join public.loan l
      on dd.mes = date_trunc('month', current_date)::date
     and l.status = 'ACTIVO'
    cross join lateral public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
    where p.period > l.last_generated_period
      and p.due_on between dd.mes and dd.fin_mes
  ),
  calc as (
    select dd.dias_transcurridos,
           dd.dias_totales,
           (dd.dias_totales - dd.dias_transcurridos) as dias_restantes,
           realizado.gasto_real,
           realizado.ingresos_real,
           (susc_futuro.cents + prest_futuro.cents) as susc_fut,
           greatest(0, realizado.gasto_real - susc_pasado.cents) as discrecional
    from dd, realizado, susc_pasado, susc_futuro, prest_futuro
  ),
  fin as (
    select c.*,
           case
             when c.dias_transcurridos > 0
               then round(c.discrecional::numeric * c.dias_restantes / c.dias_transcurridos)::bigint
             else 0::bigint
           end as extrapolado
    from calc c
  )
  select f.dias_transcurridos,
         f.dias_totales,
         f.dias_restantes,
         f.gasto_real,
         f.susc_fut,
         f.extrapolado,
         (f.gasto_real + f.susc_fut + f.extrapolado)::bigint as prevision,
         f.ingresos_real
  from fin f;
$$;

comment on function public.month_forecast is
  'Previsión de gasto del mes: lo gastado + lo fijo que falta (suscripciones e intereses de préstamos) + lo discrecional extrapolado al ritmo de lo que va de mes.';


create or replace function public.category_forecast(p_month date)
returns table (
  category_id     uuid,
  name            text,
  color           text,
  icon            text,
  cap_cents       bigint,
  gastado_cents   bigint,
  prevision_cents bigint,
  rebasa          boolean
)
language sql
stable
set search_path = ''
as $$
  with marco as (
    select date_trunc('month', p_month::timestamp)::date as mes,
           (date_trunc('month', p_month::timestamp) + interval '1 month' - interval '1 day')::date
             as fin_mes
  ),
  dd as (
    select m.mes,
           m.fin_mes,
           extract(day from m.fin_mes)::int as dias_totales,
           case
             when m.mes = date_trunc('month', current_date)::date then current_date
             when m.mes <  date_trunc('month', current_date)::date then m.fin_mes
             else (m.mes - interval '1 day')::date
           end as corte
    from marco m
  ),
  ddx as (
    select dd.*,
           greatest(0, (dd.corte - dd.mes + 1))::int as dias_transcurridos
    from dd
  ),
  estado as (
    select b.category_id, b.name, b.color, b.icon,
           b.effective_cap_cents, b.spent_cents
    from public.budget_status(p_month) b
  ),
  -- Recurrente ya cargado por categoría (suscripciones y préstamos), en neto.
  susc_pasado as (
    select s.cat as category_id, coalesce(sum(s.net), 0)::bigint as cents
    from (
      select t.category_id as cat, t.amount_cents as net
      from public.transaction t
      join ddx on t.period_month = ddx.mes and t.occurred_on <= ddx.corte
      where t.type = 'EXPENSE'
        and t.status <> 'DISCARDED'
        and (t.subscription_id is not null or t.loan_id is not null)
        and t.category_id is not null
      union all
      select ex.category_id as cat, -rb.amount_cents
      from public.transaction rb
      join public.transaction ex
        on ex.id = rb.reimburses_id and ex.user_id = rb.user_id
      join ddx on rb.period_month = ddx.mes and rb.occurred_on <= ddx.corte
      where rb.type = 'INCOME'
        and rb.reimburses_id is not null
        and rb.status <> 'DISCARDED'
        and (ex.subscription_id is not null or ex.loan_id is not null)
        and ex.category_id is not null
    ) s
    group by s.cat
  ),
  -- Lo fijo que falta este mes, por categoría: suscripciones y los intereses de
  -- las cuotas de préstamo aún no generadas (en la categoría de intereses del
  -- préstamo; el id de categoría es único, así que también cuadra cuando la
  -- llama el motor de avisos para todos los usuarios).
  susc_futuro as (
    select f.category_id, coalesce(sum(f.cents), 0)::bigint as cents
    from (
      select uc.category_id, uc.amount_cents as cents
      from ddx
      join lateral (
        select u.category_id, u.amount_cents
        from public.upcoming_charges(greatest(0, (ddx.fin_mes - current_date))::int) u
        where ddx.mes = date_trunc('month', current_date)::date
          and u.charge_date <= ddx.fin_mes
          and u.category_id is not null
      ) uc on true
      union all
      select l.interest_category_id, p.interest_cents
      from ddx
      join public.loan l
        on ddx.mes = date_trunc('month', current_date)::date
       and l.status = 'ACTIVO'
       and l.interest_category_id is not null
      cross join lateral public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
      where p.period > l.last_generated_period
        and p.due_on between ddx.mes and ddx.fin_mes
    ) f
    group by f.category_id
  ),
  proj as (
    select e.category_id, e.name, e.color, e.icon,
           e.effective_cap_cents as cap_cents,
           e.spent_cents as gastado_cents,
           (e.spent_cents
             + coalesce(sf.cents, 0)
             + case
                 when dx.dias_transcurridos > 0
                   then round(
                          greatest(0, e.spent_cents - coalesce(sp.cents, 0))::numeric
                          * (dx.dias_totales - dx.dias_transcurridos) / dx.dias_transcurridos
                        )::bigint
                 else 0::bigint
               end
           )::bigint as prevision_cents
    from estado e
    cross join ddx dx
    left join susc_pasado sp on sp.category_id = e.category_id
    left join susc_futuro sf on sf.category_id = e.category_id
  )
  select p.category_id, p.name, p.color, p.icon,
         p.cap_cents, p.gastado_cents, p.prevision_cents,
         (p.prevision_cents > p.cap_cents) as rebasa
  from proj p
  order by (p.prevision_cents > p.cap_cents) desc, p.prevision_cents desc;
$$;
