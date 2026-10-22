-- ===========================================================================
-- Patrimonio día a día, desglosado, y por cuenta.
--
-- Los gráficos nuevos piden tres cosas que el histórico mensual no da:
--
--   · Los rangos 1M y 3M del patrimonio necesitan un punto POR DÍA. Con cierres
--     mensuales, «el último mes» son dos puntos y una recta.
--   · El área «caja frente a invertido» necesita las partes, no solo el total.
--     Hasta ahora la pantalla deducía «invertido = patrimonio − caja», que mete
--     en «invertido» la caja sin desplegar de las cuentas de inversión.
--   · «Saldo por cuenta» necesita una línea por cuenta; account_balance_history
--     solo devuelve la suma.
--
-- Las tres salen de UN único cálculo, private.account_worth_on: el valor de
-- cada cuenta en cada una de las fechas pedidas. El patrimonio es su suma, las
-- partes son sus sumas filtradas, y la línea de una cuenta es su fila. Un solo
-- sitio donde equivocarse, en vez de tres que acaben contando historias
-- distintas.
--
-- Nada se almacena (invariante 2): todo se deriva de los movimientos y de las
-- valoraciones en cada llamada. Todo es security invoker: la RLS de las tablas
-- decide qué filas entran, igual que en net_worth_history y sus vecinas.
--
-- EL CRITERIO DEL VALOR DE UNA POSICIÓN EN UN DÍA
--
--   valor(d) = última valoración con fecha <= d
--            + lo aportado a la posición DESPUÉS de esa valoración y hasta d
--
--   y sin ninguna valoración todavía: lo aportado hasta d.
--
-- La valoración se ARRASTRA hasta la siguiente, sin interpolar: inventar
-- valores intermedios sería inventar ganancias. Lo que sí se suma, al coste, es
-- el dinero metido después de la última valoración. Sin eso, una aportación a
-- mitad de mes HUNDÍA la curva por su importe hasta que se registraba la
-- valoración de cierre: el saldo de la cuenta de inversión sube, lo aportado
-- sube lo mismo y se resta, y la posición seguía valiendo lo de la última
-- valoración. Con cierres mensuales casi no se veía; con un punto por día se
-- vería cada vez. Una curva que dibuja una caída que no ha ocurrido miente.
--
-- Con una valoración en la misma fecha que la aportación, la valoración manda
-- (se entiende que ya la incluye): solo se suman las aportaciones POSTERIORES.
--
-- Diferencia conocida con lo existente: v_position_value y net_worth_history
-- usan solo la última valoración, sin las aportaciones posteriores. Coinciden
-- siempre que no haya aportación entre la última valoración y la fecha (es el
-- caso de todos los datos reales a fecha de esta migración). La migración
-- 20261005090300_valor_de_posicion_con_aportes_posteriores.sql los alinea.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- El cálculo común: el valor de cada cuenta en cada fecha.
--
--   balance_cents    saldo contable al cierre del día: punto de partida + todo
--                    lo movido hasta ese día (v_account_movement, que ya cuenta
--                    los traspasos en las dos patas y deja fuera lo descartado).
--   aportado_cents   lo aportado hasta ese día a las posiciones de la cuenta,
--                    que ya está dentro de su saldo.
--   posiciones_cents valor de esas posiciones ese día (criterio de arriba).
--   worth_cents      balance − aportado + posiciones: para una cuenta de dinero
--                    es su saldo (no tiene posiciones); para una de inversión,
--                    su caja sin desplegar más el valor de mercado. Es la misma
--                    fórmula que v_account_worth y v_net_worth.
--
-- Los acumulados se hacen con una suma corrida por cuenta sobre una línea de
-- tiempo que intercala los días con movimiento y las fechas pedidas, no con una
-- subconsulta por fecha: así pedir 90 días cuesta casi lo mismo que pedir 12
-- cierres. Las fechas pedidas van después de los movimientos de su mismo día
-- (`orden`), así que cada una ve el día completo.
--
-- Las posiciones archivadas cuentan, como en net_worth_history: en el pasado
-- existían. (v_net_worth las deja fuera del valor de hoy; no hay ninguna
-- archivada en los datos reales a fecha de esta migración.)
-- ---------------------------------------------------------------------------
create or replace function private.account_worth_on(p_fechas date[])
returns table (
  account_id       uuid,
  type             public.account_type,
  fecha            date,
  balance_cents    bigint,
  aportado_cents   bigint,
  posiciones_cents bigint,
  worth_cents      bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with fechas as (
    select distinct f.d as fecha
    from unnest(p_fechas) as f(d)
    where f.d is not null
  ),
  -- Lo que entra y sale de cada cuenta cada día, y lo aportado ese día a las
  -- posiciones que cuelgan de ella.
  eventos as (
    select v.account_id as cuenta,
           v.occurred_on as dia,
           sum(v.delta_cents) as delta,
           0::numeric as aportado
    from public.v_account_movement v
    group by v.account_id, v.occurred_on
    union all
    select p.account_id,
           t.occurred_on,
           0::numeric,
           sum(t.amount_cents)
    from public.transaction t
    join public.investment_position p
      on p.user_id = t.user_id and p.id = t.position_id
    where t.type = 'TRANSFER'
      and t.status <> 'DISCARDED'
    group by p.account_id, t.occurred_on
  ),
  linea as (
    select e.cuenta, e.dia, 0 as orden, e.delta, e.aportado
    from eventos e
    union all
    select a.id, f.fecha, 1, 0::numeric, 0::numeric
    from public.account a
    cross join fechas f
  ),
  acumulado as (
    select l.cuenta,
           l.dia,
           l.orden,
           sum(l.delta)    over w as delta,
           sum(l.aportado) over w as aportado
    from linea l
    window w as (partition by l.cuenta order by l.dia, l.orden
                 rows between unbounded preceding and current row)
  ),
  posiciones as (
    select p.account_id as cuenta,
           f.fecha,
           sum(coalesce(ult.value_cents, 0) + coalesce(despues.cents, 0)) as cents
    from public.investment_position p
    cross join fechas f
    -- La última valoración conocida ese día…
    left join lateral (
      select v.date, v.value_cents
      from public.valuation v
      where v.user_id = p.user_id
        and v.position_id = p.id
        and v.date <= f.fecha
      order by v.date desc
      limit 1
    ) ult on true
    -- …más lo aportado después de ella (o todo, si aún no hay ninguna).
    left join lateral (
      select sum(t.amount_cents) as cents
      from public.transaction t
      where t.user_id = p.user_id
        and t.position_id = p.id
        and t.type = 'TRANSFER'
        and t.status <> 'DISCARDED'
        and t.occurred_on <= f.fecha
        and (ult.date is null or t.occurred_on > ult.date)
    ) despues on true
    group by p.account_id, f.fecha
  )
  select a.id,
         a.type,
         ac.dia,
         (a.initial_balance_cents + coalesce(ac.delta, 0))::bigint,
         coalesce(ac.aportado, 0)::bigint,
         coalesce(po.cents, 0)::bigint,
         (a.initial_balance_cents + coalesce(ac.delta, 0)
            - coalesce(ac.aportado, 0) + coalesce(po.cents, 0))::bigint
  from acumulado ac
  join public.account a on a.id = ac.cuenta
  left join posiciones po on po.cuenta = ac.cuenta and po.fecha = ac.dia
  where ac.orden = 1;
$$;

comment on function private.account_worth_on is
  'Valor de cada cuenta en cada fecha pedida: saldo, aportado a sus posiciones, valor de esas posiciones (última valoración + aportes posteriores) y worth = saldo − aportado + posiciones. Base común del patrimonio diario, mensual y por cuenta.';

-- Postgres concede EXECUTE a PUBLIC al crear una función: aquí solo lo necesita
-- `authenticated`, para las funciones públicas security invoker que la llaman.
revoke all on function private.account_worth_on(date[]) from public, anon;
grant execute on function private.account_worth_on(date[]) to authenticated;


-- ---------------------------------------------------------------------------
-- Patrimonio · rangos 1M y 3M: el patrimonio neto día a día, con sus partes.
--
--   net_worth_cents = cash_cents + invested_cents + idle_cents
--
--   cash_cents      saldo de las cuentas que no son de inversión (tarjetas en
--                   negativo incluidas)
--   invested_cents  valor de mercado de las posiciones
--   idle_cents      caja sin desplegar de las cuentas de inversión
--
-- Es la misma partición que v_net_worth, ahora exacta en cada día: «invertido»
-- ya no arrastra la caja sin desplegar.
--
-- El rango se recorta a hoy: un día futuro no tiene patrimonio que dibujar (y
-- un movimiento con fecha futura no debe adelantarse en la curva). Y a cinco
-- años como mucho, que ya son 1.827 puntos. Un día sin ninguna cuenta sale a
-- cero, como en net_worth_history.
-- ---------------------------------------------------------------------------
create or replace function public.net_worth_daily(p_desde date, p_hasta date)
returns table (
  fecha           date,
  net_worth_cents bigint,
  cash_cents      bigint,
  invested_cents  bigint,
  idle_cents      bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with dias as (
    select (p_desde + g.n)::date as dia
    from generate_series(
           0,
           (least(p_hasta, current_date, p_desde + 1826) - p_desde)
         ) as g(n)
  ),
  valores as (
    select w.fecha,
           sum(w.worth_cents) as total,
           sum(w.balance_cents) filter (where w.type <> 'INVERSION') as caja,
           sum(w.posiciones_cents) as invertido,
           sum(w.balance_cents - w.aportado_cents) filter (where w.type = 'INVERSION') as sin_desplegar
    from private.account_worth_on((select array_agg(d.dia) from dias d)) w
    group by w.fecha
  )
  select d.dia,
         coalesce(v.total, 0)::bigint,
         coalesce(v.caja, 0)::bigint,
         coalesce(v.invertido, 0)::bigint,
         coalesce(v.sin_desplegar, 0)::bigint
  from dias d
  left join valores v on v.fecha = d.dia
  order by d.dia;
$$;

comment on function public.net_worth_daily is
  'Patrimonio neto por día entre p_desde y p_hasta (recortado a hoy y a 5 años), con caja, invertido (valor de posiciones) y sin desplegar. net = cash + invested + idle.';

revoke all on function public.net_worth_daily(date, date) from public, anon;
grant execute on function public.net_worth_daily(date, date) to authenticated;


-- ---------------------------------------------------------------------------
-- Patrimonio · la versión mensual, con las mismas partes.
--
-- Mismos meses y misma fecha de cierre que net_worth_history (el último día de
-- cada mes, también el del mes en curso), así que el total coincide con ella
-- mes a mes; además trae caja, invertido y sin desplegar para el área «caja
-- frente a invertido» de 6M, 1A y 5A.
-- ---------------------------------------------------------------------------
create or replace function public.net_worth_monthly(p_months integer default 12)
returns table (
  period_month    date,
  net_worth_cents bigint,
  cash_cents      bigint,
  invested_cents  bigint,
  idle_cents      bigint
)
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
  ),
  valores as (
    select w.fecha,
           sum(w.worth_cents) as total,
           sum(w.balance_cents) filter (where w.type <> 'INVERSION') as caja,
           sum(w.posiciones_cents) as invertido,
           sum(w.balance_cents - w.aportado_cents) filter (where w.type = 'INVERSION') as sin_desplegar
    from private.account_worth_on((select array_agg(c.fin) from cierres c)) w
    group by w.fecha
  )
  select c.mes,
         coalesce(v.total, 0)::bigint,
         coalesce(v.caja, 0)::bigint,
         coalesce(v.invertido, 0)::bigint,
         coalesce(v.sin_desplegar, 0)::bigint
  from cierres c
  left join valores v on v.fecha = c.fin
  order by c.mes;
$$;

comment on function public.net_worth_monthly is
  'Patrimonio neto al cierre de cada uno de los últimos p_months meses (mismos cierres que net_worth_history), con caja, invertido y sin desplegar.';

revoke all on function public.net_worth_monthly(integer) from public, anon;
grant execute on function public.net_worth_monthly(integer) to authenticated;


-- ---------------------------------------------------------------------------
-- Cuentas · una línea por cuenta, mes a mes.
--
-- Por cada cuenta (también las archivadas: su historia sigue siendo verdad, y
-- sin ellas las líneas no sumarían el total) y cada cierre de mes:
--
--   balance_cents  saldo contable. Sumado sobre todas las cuentas da
--                  exactamente account_balance_history.
--   worth_cents    lo que vale la cuenta: igual al saldo en las de dinero; en
--                  las de inversión, caja sin desplegar + valor de posiciones,
--                  como v_account_worth. Es el que mide el progreso de una meta.
--
-- Como en account_balance_history, el saldo de partida cuenta desde el primer
-- mes aunque la cuenta se diera de alta después: el punto de partida no tiene
-- fecha.
-- ---------------------------------------------------------------------------
create or replace function public.account_balance_monthly(p_months integer default 12)
returns table (
  account_id    uuid,
  name          text,
  color         text,
  type          public.account_type,
  archived      boolean,
  period_month  date,
  balance_cents bigint,
  worth_cents   bigint
)
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
  select a.id,
         a.name,
         a.color,
         a.type,
         a.archived,
         c.mes,
         w.balance_cents,
         w.worth_cents
  from private.account_worth_on((select array_agg(c2.fin) from cierres c2)) w
  join cierres c on c.fin = w.fecha
  join public.account a on a.id = w.account_id
  order by a.archived, a.name, a.id, c.mes;
$$;

comment on function public.account_balance_monthly is
  'Saldo contable y valor (worth, como v_account_worth) de cada cuenta al cierre de cada uno de los últimos p_months meses. La suma de balance_cents es account_balance_history.';

revoke all on function public.account_balance_monthly(integer) from public, anon;
grant execute on function public.account_balance_monthly(integer) to authenticated;


-- ---------------------------------------------------------------------------
-- Metas · hacia dónde va cada una, al ritmo de los últimos meses.
--
--   saved_cents        lo que vale hoy la cuenta de la meta (v_account_worth,
--                      la misma cifra que la barra de progreso).
--   ritmo_cents        cuánto ha crecido de media al mes la cuenta en los
--                      últimos p_months meses CERRADOS: valor al cierre del mes
--                      pasado menos valor p_months cierres antes, entre p_months.
--                      Se excluye el mes en curso porque va a medias. Puede ser
--                      negativo (la cuenta mengua).
--   meses_para_meta    meses que faltan a ese ritmo (0 si ya se alcanzó; NULL
--                      si el ritmo no es positivo o pasa de cien años).
--   fecha_estimada     hoy + meses_para_meta. La línea de proyección va del
--                      punto (hoy, saved_cents) al punto (fecha_estimada,
--                      target_cents).
--   necesario_mensual_cents  con fecha límite por delante y sin alcanzar: lo que
--                      haría falta al mes, con la MISMA cuenta que ya hace la
--                      tarjeta de la meta (lo que falta / (días / 30,44)), para
--                      que pantalla y gráfico digan la misma cifra. NULL si no
--                      hay fecha, ya pasó o ya se alcanzó.
--
-- Todo importe es entero en céntimos; los cocientes se hacen en numeric (exacto,
-- no coma flotante) y se redondean.
-- ---------------------------------------------------------------------------
create or replace function public.savings_goal_projection(p_months integer default 6)
returns table (
  goal_id                 uuid,
  account_id              uuid,
  name                    text,
  target_cents            bigint,
  deadline                date,
  saved_cents             bigint,
  remaining_cents         bigint,
  ritmo_cents             bigint,
  meses_para_meta         integer,
  fecha_estimada          date,
  necesario_mensual_cents bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with marco as (
    select greatest(1, p_months) as n,
           (date_trunc('month', current_date) - interval '1 day')::date as fin_ultimo,
           (date_trunc('month', current_date)
              - make_interval(months => greatest(1, p_months))
              - interval '1 day')::date as fin_base
  ),
  historia as (
    select w.account_id, w.fecha, w.worth_cents
    from marco m
    cross join lateral private.account_worth_on(array[m.fin_ultimo, m.fin_base]) w
  ),
  metas as (
    select g.id,
           g.account_id,
           g.name,
           g.target_cents,
           g.deadline,
           coalesce(w.worth_cents, 0)::bigint as guardado,
           greatest(0, g.target_cents - coalesce(w.worth_cents, 0))::bigint as falta,
           round(
             (coalesce(h1.worth_cents, 0) - coalesce(h0.worth_cents, 0))::numeric / m.n
           )::bigint as ritmo
    from public.savings_goal g
    cross join marco m
    left join public.v_account_worth w
      on w.user_id = g.user_id and w.account_id = g.account_id
    left join historia h1 on h1.account_id = g.account_id and h1.fecha = m.fin_ultimo
    left join historia h0 on h0.account_id = g.account_id and h0.fecha = m.fin_base
  ),
  plazos as (
    select mt.*,
           case
             when mt.falta = 0 then 0
             when mt.ritmo > 0 and ceil(mt.falta::numeric / mt.ritmo) <= 1200
               then ceil(mt.falta::numeric / mt.ritmo)::integer
           end as meses
    from metas mt
  )
  select p.id,
         p.account_id,
         p.name,
         p.target_cents,
         p.deadline,
         p.guardado,
         p.falta,
         p.ritmo,
         p.meses,
         case
           when p.meses is not null
             then (current_date + make_interval(months => p.meses))::date
         end,
         case
           when p.falta > 0 and p.deadline is not null and p.deadline > current_date
             then round(p.falta::numeric * 30.44 / (p.deadline - current_date))::bigint
         end
  from plazos p
  order by p.name, p.id;
$$;

comment on function public.savings_goal_projection is
  'Proyección de cada meta: valor de hoy, ritmo medio mensual de su cuenta en los últimos p_months meses cerrados, meses y fecha estimada para alcanzarla, y lo necesario al mes si tiene fecha límite.';

revoke all on function public.savings_goal_projection(integer) from public, anon;
grant execute on function public.savings_goal_projection(integer) to authenticated;
