-- ===========================================================================
-- Previsión de fin de mes: hacia dónde va el gasto del mes en curso.
--
-- Todo lo demás en la app mira atrás —lo que ya se gastó—. Esto mira adelante:
-- «a este ritmo, acabarás en X». No es una regla de tres ingenua. Un mes no se
-- gasta a ritmo constante: el alquiler y las suscripciones caen en días fijos,
-- y una simple proyección lineal te diría «vas bien» justo antes de que entren
-- Netflix y el gimnasio. Por eso la previsión suma TRES cosas distintas:
--
--   1. Lo YA gastado este mes, neto (de v_transaction_econ: sin traspasos, con
--      los reembolsos restados de su categoría).
--   2. Las suscripciones que faltan por cargar de aquí a fin de mes. Importe y
--      fecha CONOCIDOS, no estimados: es lo que salva la previsión del «te queda
--      poco» falso. Salen de upcoming_charges, que ya expande cada suscripción
--      activa por su periodicidad.
--   3. El gasto DISCRECIONAL que queda, ese sí extrapolado: lo discrecional
--      gastado hasta hoy, por día, aplicado a los días que quedan. Discrecional
--      = lo que NO viene de una suscripción (`subscription_id is null`), para no
--      contar dos veces lo recurrente que ya está en (2).
--
-- Solo tiene sentido para el mes en curso, y la superficie solo lo enseña ahí.
-- Un mes pasado ya cerró: 0 días por delante, 0 extrapolación → su previsión es
-- su total. Un mes futuro no tiene con qué: sale a cero. Las funciones son
-- seguras para cualquier `p_month`; es la pantalla la que decide cuándo mostrar.
--
-- Al heredar de v_transaction_econ, upcoming_charges y budget_status —todas
-- security_invoker— los tres invariantes económicos quedan garantizados en un
-- solo sitio, sin repetir el filtro consulta a consulta.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- La previsión de gasto del mes, con sus piezas a la vista para que la pantalla
-- pueda explicarla (y ser humilde los primeros días, cuando extrapolar es ruido:
-- por eso se devuelve `dias_transcurridos`).
-- ---------------------------------------------------------------------------
create or replace function public.month_forecast(p_month date)
returns table (
  dias_transcurridos  integer,
  dias_totales        integer,
  dias_restantes      integer,
  gasto_real_cents    bigint,   -- (1) lo gastado hasta hoy, neto
  suscripciones_cents bigint,   -- (2) suscripciones que faltan este mes
  extrapolado_cents   bigint,   -- (3) discrecional restante, estimado
  prevision_cents     bigint,   -- (1)+(2)+(3): gasto a fin de mes
  ingresos_real_cents bigint    -- ingresos reales hasta hoy (contexto, no se proyecta)
)
language sql
stable
security invoker
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
  -- Lo recurrente ya cargado hasta el corte, para descontarlo de lo discrecional
  -- y no arrastrar las suscripciones al ritmo extrapolado. Va a la tabla base
  -- porque el econ no expone `subscription_id`. Se toma en NETO: si un cargo de
  -- suscripción se reembolsa, el reembolso ya rebajó `gasto_real`, así que aquí
  -- hay que rebajarlo también —restarle el bruto dejaría lo discrecional corto y
  -- podría silenciar un aviso de límite—.
  susc_pasado as (
    select coalesce(sum(s.net), 0)::bigint as cents
    from (
      -- El cargo recurrente suma.
      select t.amount_cents as net
      from public.transaction t
      join dd on t.period_month = dd.mes and t.occurred_on <= dd.corte
      where t.type = 'EXPENSE'
        and t.status <> 'DISCARDED'
        and t.subscription_id is not null
      union all
      -- Un reembolso de ese cargo resta, imputado al mes del reembolso (igual que
      -- lo hace el econ con net_expense_cents).
      select -rb.amount_cents
      from public.transaction rb
      join public.transaction ex
        on ex.id = rb.reimburses_id and ex.user_id = rb.user_id
      join dd on rb.period_month = dd.mes and rb.occurred_on <= dd.corte
      where rb.type = 'INCOME'
        and rb.reimburses_id is not null
        and rb.status <> 'DISCARDED'
        and ex.subscription_id is not null
    ) s
  ),
  -- (2) Suscripciones que faltan por cargar este mes. upcoming_charges arranca en
  -- `current_date`, así que esto solo aplica al mes en curso; en otro mes el gate
  -- deja el conjunto vacío. Por construcción son cargos AÚN no generados, así que
  -- no solapan con (1).
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
  calc as (
    select dd.dias_transcurridos,
           dd.dias_totales,
           (dd.dias_totales - dd.dias_transcurridos) as dias_restantes,
           realizado.gasto_real,
           realizado.ingresos_real,
           susc_futuro.cents as susc_fut,
           -- Discrecional gastado = neto − recurrente ya cargado (nunca negativo).
           greatest(0, realizado.gasto_real - susc_pasado.cents) as discrecional
    from dd, realizado, susc_pasado, susc_futuro
  ),
  fin as (
    select c.*,
           -- (3) Extrapolación del discrecional al resto del mes. Sin días
           -- transcurridos (mes futuro) no hay tasa: se deja en cero.
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
  'Previsión de gasto a fin de mes = gastado hasta hoy + suscripciones que faltan + discrecional restante extrapolado. Solo tiene sentido en el mes en curso; devuelve dias_transcurridos para que la pantalla sea humilde al principio.';


-- ---------------------------------------------------------------------------
-- Lo mismo por categoría, pero solo de las que tienen límite: cuál vas camino de
-- rebasar. Se apoya en budget_status (gastado y tope efectivo, ya con arrastre)
-- y le suma la misma proyección: suscripciones que faltan + discrecional de la
-- categoría extrapolado.
-- ---------------------------------------------------------------------------
create or replace function public.category_forecast(p_month date)
returns table (
  category_id     uuid,
  name            text,
  color           text,
  icon            text,
  cap_cents       bigint,   -- tope efectivo del mes (con arrastre)
  gastado_cents   bigint,   -- gastado hasta hoy
  prevision_cents bigint,   -- gasto de la categoría a fin de mes
  rebasa          boolean   -- previsión por encima del tope
)
language sql
stable
security invoker
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
  -- Gastado y tope efectivo por categoría: la misma cifra que ve el usuario en
  -- Análisis, para que no discrepen. budget_status suma el mes completo (sin
  -- filtro de corte); coincide con «hasta hoy» salvo que se postdate un gasto
  -- dentro del mes (infrecuente). Se prioriza cuadrar con Análisis sobre igualar
  -- el corte exacto de month_forecast.
  estado as (
    select b.category_id, b.name, b.color, b.icon,
           b.effective_cap_cents, b.spent_cents
    from public.budget_status(p_month) b
  ),
  -- Recurrente ya cargado por categoría, hasta el corte, en NETO: un reembolso de
  -- un cargo de suscripción se resta, imputado a la categoría del gasto enlazado
  -- —que es la `econ_category_id` con la que budget_status cuadra el gastado—,
  -- para no dejar corto el ritmo discrecional de esa categoría.
  susc_pasado as (
    select s.cat as category_id, coalesce(sum(s.net), 0)::bigint as cents
    from (
      select t.category_id as cat, t.amount_cents as net
      from public.transaction t
      join ddx on t.period_month = ddx.mes and t.occurred_on <= ddx.corte
      where t.type = 'EXPENSE'
        and t.status <> 'DISCARDED'
        and t.subscription_id is not null
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
        and ex.subscription_id is not null
        and ex.category_id is not null
    ) s
    group by s.cat
  ),
  -- Suscripciones que faltan este mes, por categoría (mismo gate del mes en curso).
  susc_futuro as (
    select u.category_id, coalesce(sum(u.amount_cents), 0)::bigint as cents
    from ddx
    join lateral (
      select uc.category_id, uc.amount_cents
      from public.upcoming_charges(greatest(0, (ddx.fin_mes - current_date))::int) uc
      where ddx.mes = date_trunc('month', current_date)::date
        and uc.charge_date <= ddx.fin_mes
        and uc.category_id is not null
    ) u on true
    group by u.category_id
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

comment on function public.category_forecast is
  'Previsión por categoría con límite: gastado + suscripciones pendientes + discrecional extrapolado, y si supera el tope efectivo. Ordena primero las que se van a rebasar.';
