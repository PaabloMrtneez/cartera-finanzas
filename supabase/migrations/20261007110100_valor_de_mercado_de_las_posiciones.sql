-- ===========================================================================
-- Inversiones que se actualizan solas (2/2): el valor de una posición, en UN
-- único cálculo.
--
-- Sobre los datos de 20261007110000_instrumentos_y_participaciones.sql, esta
-- migración define private.position_value_on(fechas): el valor de cada posición
-- en cada fecha. Todo lo que enseña el valor de una posición pasa a leer de
-- ahí, así que no hay dos sitios que puedan contar historias distintas:
--
--   · private.account_worth_on → net_worth_daily, net_worth_monthly,
--     net_worth_history, account_balance_monthly, savings_goal_projection
--   · v_position_value         → v_net_worth, v_account_worth, el progreso de
--                                las metas
--   · position_return          → portfolio_return
--   · position_performance
--   · v_position_market        (nueva: lo que necesita la interfaz)
--
-- ── EL VALOR DE UNA POSICIÓN EN UN DÍA d ──────────────────────────────────
--
-- 1. ¿La posición sigue un instrumento el día d? Lo dice el último ALTA o BAJA
--    del libro con fecha <= d (a igual fecha, el último insertado). Si es un
--    ALTA, está SINCRONIZADA y ese ALTA dice qué instrumento.
--
-- 2. NO SINCRONIZADA (todas las posiciones de hoy): exactamente el criterio de
--    siempre (20261005090300_valor_de_posicion_con_aportes_posteriores.sql):
--
--      valor(d) = última valoración con fecha <= d
--               + lo aportado DESPUÉS de ella y hasta d
--      (sin ninguna valoración: lo aportado hasta d)
--
-- 3. SINCRONIZADA:
--
--      participaciones(d) = las del último ALTA o AJUSTE del periodo con
--                           fecha <= d
--                         + las de cada aportación posterior a él y hasta d
--      precio(d)          = último cierre del instrumento con fecha <= d
--      cambio(d)          = último tipo del BCE con fecha <= d (1 si es EUR)
--
--      valor(d) = round(participaciones × precio × 100 / cambio) céntimos
--
--    El redondeo es al céntimo más cercano con el empate HACIA ARRIBA (round()
--    de Postgres sobre numeric redondea lejos del cero, y el valor nunca es
--    negativo), el mismo criterio que src/lib/valoracion.ts. El producto
--    participaciones × precio × 100 es exacto en numeric; solo la división
--    entre el cambio no lo es, y se hace con más de 16 cifras significativas
--    antes de redondear al céntimo.
--
--    Una aportación del mismo día que el ALTA o el AJUSTE se da por incluida en
--    él, igual que una del mismo día que una valoración.
--
-- 4. EL RESPALDO MANUAL. En una posición sincronizada, una valoración manual
--    con fecha POSTERIOR al último precio disponible el día d (y no anterior al
--    ALTA) manda: el valor es esa valoración más lo aportado después, como en
--    una posición manual. Deja de mandar en cuanto llega un precio de su misma
--    fecha o posterior. Es lo que permite seguir al día si Yahoo falla.
--
-- 5. SIN PRECIO TODAVÍA (o sin tipo de cambio, si no es EUR): se valora como
--    una posición manual. No se inventa nada; la interfaz lo enseña como «sin
--    precio».
--
-- ── LAS PARTICIPACIONES DE UNA APORTACIÓN QUE NO LAS TRAE ─────────────────
--
-- Se estiman con el ÚLTIMO precio conocido en su fecha (el último cierre con
-- fecha <= la de la aportación, y su tipo de cambio):
--
--      participaciones ≈ round(importe × cambio / precio, 8)
--
-- Se elige ese precio, y no el primero posterior (que se parecería más al
-- valor liquidativo al que el fondo ejecuta de verdad), por dos razones:
--
--   · La aportación entra NEUTRA: el día que se hace, la posición sube
--     exactamente lo aportado (participaciones nuevas × el mismo precio con el
--     que se valora ese día). Una aportación no es rendimiento, y con el precio
--     del día siguiente aparecería una ganancia o pérdida instantánea que no ha
--     ocurrido.
--   · Es ESTABLE: no cambia cuando llega el precio de mañana, así que la curva
--     de ayer no se reescribe sola.
--
-- Solo si no hay ningún precio anterior a la aportación se usa el primero
-- posterior. Es una estimación y se marca como tal (units_estimadas): la cifra
-- exacta llega anotando las participaciones de la aportación o con un AJUSTE
-- con lo que diga el bróker.
--
-- Todo es security invoker: la RLS de cada tabla decide qué filas entran. Los
-- precios y el catálogo los ve cualquier autenticado; posiciones, libro,
-- valoraciones y movimientos, solo su dueño.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- El cálculo común.
--
-- Columnas:
--   value_cents      valor en céntimos (criterio de arriba)
--   fuente           'MERCADO'  participaciones × precio × cambio
--                    'RESPALDO' sincronizada, pero manda una valoración manual
--                               posterior al último precio
--                    'MANUAL'   no sincronizada, o sincronizada sin precio aún
--   valued_on        fecha del dato que manda: la del precio (MERCADO) o la de
--                    la valoración (RESPALDO, MANUAL)
--   sin_valorar      ni precio que mande ni valoración: vale lo aportado
--   instrument_id    instrumento seguido ese día (NULL si no lo está)
--   alta_date        fecha del ALTA del periodo vigente
--   alta_contributed_cents  aportado declarado en ese ALTA
--   anchor_date      fecha del último ALTA o AJUSTE (punto de partida de las
--                    participaciones)
--   units            participaciones ese día
--   units_estimadas  alguna aportación de las que suman no traía las suyas
--   price, price_date, fx_rate, fx_date  lo que se ha usado (fx_rate 1 en EUR)
--
-- La fecha 'infinity' es válida y significa «con todo lo que hay»: es lo que
-- usa v_position_value para el valor de HOY, que cuenta también aportaciones
-- con fecha futura igual que el saldo de la cuenta (v_account_balance).
-- ---------------------------------------------------------------------------
create or replace function private.position_value_on(p_fechas date[])
returns table (
  position_id            uuid,
  user_id                uuid,
  account_id             uuid,
  fecha                  date,
  value_cents            bigint,
  fuente                 text,
  valued_on              date,
  sin_valorar            boolean,
  instrument_id          uuid,
  alta_date              date,
  alta_contributed_cents bigint,
  anchor_date            date,
  units                  numeric,
  units_estimadas        boolean,
  price                  numeric,
  price_date             date,
  fx_rate                numeric,
  fx_date                date
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
  -- Cada aportación con sus participaciones: las que trae o, si no, estimadas
  -- con el precio del instrumento que seguía la posición ese día.
  aportes as (
    select t.user_id,
           t.position_id,
           t.occurred_on,
           coalesce(
             t.position_units,
             round(t.amount_cents::numeric * coalesce(cam.rate, 1) / (100 * pre.close), 8)
           ) as units,
           (t.position_units is null) as estimada
    from public.transaction t
    left join lateral (
      select e.instrument_id
      from public.position_unit_event e
      where e.user_id = t.user_id
        and e.position_id = t.position_id
        and e.kind in ('ALTA', 'BAJA')
        and e.date <= t.occurred_on
      order by e.date desc, e.seq desc
      limit 1
    ) per on true
    left join public.instrument i on i.id = per.instrument_id
    left join lateral (
      -- El último precio en su fecha o, si no hay ninguno anterior, el primero.
      select x.close
      from (
        (select ip.close, 0 as orden, ip.date
         from public.instrument_price ip
         where ip.instrument_id = per.instrument_id and ip.date <= t.occurred_on
         order by ip.date desc
         limit 1)
        union all
        (select ip.close, 1, ip.date
         from public.instrument_price ip
         where ip.instrument_id = per.instrument_id and ip.date > t.occurred_on
         order by ip.date
         limit 1)
      ) x
      order by x.orden
      limit 1
    ) pre on per.instrument_id is not null
    left join lateral (
      select x.rate
      from (
        (select fr.rate, 0 as orden
         from public.fx_rate fr
         where fr.currency = i.currency and fr.date <= t.occurred_on
         order by fr.date desc
         limit 1)
        union all
        (select fr.rate, 1
         from public.fx_rate fr
         where fr.currency = i.currency and fr.date > t.occurred_on
         order by fr.date
         limit 1)
      ) x
      order by x.orden
      limit 1
    ) cam on i.currency is not null and i.currency <> 'EUR'
    where t.type = 'TRANSFER'
      and t.status <> 'DISCARDED'
      and t.position_id is not null
      and per.instrument_id is not null
      -- Sin precio no hay estimación posible (ni valor de mercado): no suma.
      and (t.position_units is not null
           or (pre.close is not null and (i.currency = 'EUR' or cam.rate is not null)))
  ),
  base as (
    select p.id,
           p.user_id,
           p.account_id,
           f.fecha,
           per.instrument_id,
           per.date              as alta_date,
           per.seq               as alta_seq,
           per.contributed_cents as alta_contributed,
           i.currency
    from public.investment_position p
    cross join fechas f
    left join lateral (
      select e.kind, e.instrument_id, e.date, e.seq, e.contributed_cents
      from public.position_unit_event e
      where e.user_id = p.user_id
        and e.position_id = p.id
        and e.kind in ('ALTA', 'BAJA')
        and e.date <= f.fecha
      order by e.date desc, e.seq desc
      limit 1
    ) per on per.kind = 'ALTA'
    left join public.instrument i on i.id = per.instrument_id
  ),
  calculo as (
    select b.*,
           anc.date  as anchor_date,
           anc.units + coalesce(mov.units, 0) as units,
           coalesce(mov.estimadas, false)     as units_estimadas,
           pr.close  as price,
           pr.date   as price_date,
           case when b.currency = 'EUR' then 1::numeric else fx.rate end as fx_rate,
           fx.date   as fx_date,
           ult.date  as val_date,
           (coalesce(ult.value_cents, 0) + coalesce(despues.cents, 0))::bigint as manual_cents
    from base b
    -- Punto de partida de las participaciones: el último ALTA o AJUSTE del
    -- periodo vigente (posterior o igual al ALTA, en el orden del libro).
    left join lateral (
      select e.date, e.units
      from public.position_unit_event e
      where e.user_id = b.user_id
        and e.position_id = b.id
        and e.kind in ('ALTA', 'AJUSTE')
        and e.date <= b.fecha
        and (e.date, e.seq) >= (b.alta_date, b.alta_seq)
      order by e.date desc, e.seq desc
      limit 1
    ) anc on b.instrument_id is not null
    -- Más las participaciones de las aportaciones posteriores.
    left join lateral (
      select sum(a.units) as units, bool_or(a.estimada) as estimadas
      from aportes a
      where a.user_id = b.user_id
        and a.position_id = b.id
        and a.occurred_on > anc.date
        and a.occurred_on <= b.fecha
    ) mov on b.instrument_id is not null
    left join lateral (
      select ip.close, ip.date
      from public.instrument_price ip
      where ip.instrument_id = b.instrument_id
        and ip.date <= b.fecha
      order by ip.date desc
      limit 1
    ) pr on b.instrument_id is not null
    left join lateral (
      select fr.rate, fr.date
      from public.fx_rate fr
      where fr.currency = b.currency
        and fr.date <= b.fecha
      order by fr.date desc
      limit 1
    ) fx on b.currency is not null and b.currency <> 'EUR'
    -- El criterio manual: última valoración <= d…
    left join lateral (
      select v.date, v.value_cents
      from public.valuation v
      where v.user_id = b.user_id
        and v.position_id = b.id
        and v.date <= b.fecha
      order by v.date desc
      limit 1
    ) ult on true
    -- …más lo aportado después de ella (o todo, si aún no hay ninguna).
    left join lateral (
      select sum(t.amount_cents) as cents
      from public.transaction t
      where t.user_id = b.user_id
        and t.position_id = b.id
        and t.type = 'TRANSFER'
        and t.status <> 'DISCARDED'
        and t.occurred_on <= b.fecha
        and (ult.date is null or t.occurred_on > ult.date)
    ) despues on true
  ),
  decision as (
    select c.*,
           case
             when c.instrument_id is null then 'MANUAL'
             -- Una valoración del periodo posterior al último precio manda.
             when c.val_date is not null
                  and c.val_date >= c.alta_date
                  and (c.price_date is null or c.val_date > c.price_date) then 'RESPALDO'
             when c.price is not null and c.fx_rate is not null and c.units is not null then 'MERCADO'
             else 'MANUAL'
           end as fuente
    from calculo c
  )
  select d.id,
         d.user_id,
         d.account_id,
         d.fecha,
         case
           when d.fuente = 'MERCADO'
             then round(d.units * d.price * 100 / d.fx_rate)::bigint
           else d.manual_cents
         end,
         d.fuente,
         case when d.fuente = 'MERCADO' then d.price_date else d.val_date end,
         (d.fuente <> 'MERCADO' and d.val_date is null),
         d.instrument_id,
         d.alta_date,
         d.alta_contributed,
         d.anchor_date,
         d.units,
         d.units_estimadas,
         d.price,
         d.price_date,
         d.fx_rate,
         d.fx_date
  from decision d;
$$;

comment on function private.position_value_on(date[]) is
  'Valor de cada posición en cada fecha: manual (última valoración + aportes posteriores) o, si sigue un instrumento, participaciones × último precio × cambio, con respaldo de una valoración manual posterior al último precio. Base única del valor de las posiciones.';

revoke all on function private.position_value_on(date[]) from public, anon;
grant execute on function private.position_value_on(date[]) to authenticated;


-- ---------------------------------------------------------------------------
-- private.account_worth_on: el cuerpo de 20261005090000 salvo `posiciones`, que
-- ahora suma private.position_value_on. Mismas columnas, misma fórmula:
-- worth = saldo − aportado + valor de las posiciones (archivadas incluidas,
-- como antes: en el pasado existían).
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
    select pv.account_id as cuenta,
           pv.fecha,
           sum(pv.value_cents) as cents
    from private.position_value_on((select array_agg(f.fecha) from fechas f)) pv
    group by pv.account_id, pv.fecha
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
  'Valor de cada cuenta en cada fecha pedida: saldo, aportado a sus posiciones, valor de esas posiciones (private.position_value_on) y worth = saldo − aportado + posiciones. Base común del patrimonio diario, mensual y por cuenta.';

revoke all on function private.account_worth_on(date[]) from public, anon;
grant execute on function private.account_worth_on(date[]) to authenticated;


-- ---------------------------------------------------------------------------
-- v_position_value: mismas columnas y en el mismo orden (más dos al final).
-- El valor de HOY es el de la fecha 'infinity': última valoración o último
-- precio, y todas las aportaciones, también las de fecha futura, como hasta
-- ahora.
-- ---------------------------------------------------------------------------
create or replace view public.v_position_value with (security_invoker = true) as
select p.user_id,
       p.id as position_id,
       p.name,
       p.color,
       p.account_id,
       p.since,
       p.archived,
       c.contributed_cents,
       pv.valued_on,
       pv.value_cents,
       pv.sin_valorar,
       pv.fuente,
       pv.instrument_id
from public.investment_position p
left join public.v_position_contributions c on c.position_id = p.id
left join private.position_value_on(array['infinity'::date]) pv on pv.position_id = p.id;


-- ---------------------------------------------------------------------------
-- v_position_market: lo que la interfaz enseña de cada posición.
--
--   seguida            sigue un instrumento hoy
--   instrumento        símbolo, ISIN, nombre, tipo, divisa y mercado
--   units              participaciones actuales (derivadas del libro)
--   units_estimadas    alguna aportación desde el último ALTA/AJUSTE no traía
--                      sus participaciones y se han estimado
--   price, price_date  último cierre y SU FECHA: a qué día está actualizado
--   value_cents        valor (el mismo que v_position_value)
--   fuente             MERCADO, RESPALDO (manda una valoración manual
--                      posterior al último precio) o MANUAL
--   sin_precio         sigue un instrumento pero aún no hay precio (o cambio)
--   contributed_cents  coste: en una sincronizada, lo aportado declarado en el
--                      ALTA más lo aportado después; en una manual, lo
--                      aportado (v_position_contributions)
--   gain_cents         value − contributed
--   return_pct         gain / contributed en %, 2 decimales (derivado)
--   dias_sin_precio   días hábiles (lunes a viernes, sin contar festivos)
--                      desde la fecha del último precio hasta hoy
--   desactualizado     más de 3 días hábiles sin precio nuevo. Los fondos
--                      llegan con un día hábil de retraso y un festivo puede
--                      sumar otro: 3 deja margen para eso y salta cuando la
--                      descarga lleva de verdad días sin funcionar.
-- ---------------------------------------------------------------------------
create or replace view public.v_position_market with (security_invoker = true) as
select p.user_id,
       p.id                              as position_id,
       p.name,
       p.archived,
       (pv.instrument_id is not null)    as seguida,
       pv.instrument_id,
       i.yahoo_symbol,
       i.isin,
       i.name                            as instrument_name,
       i.kind                            as instrument_kind,
       i.currency,
       i.exchange,
       pv.alta_date,
       pv.anchor_date,
       pv.units,
       pv.units_estimadas,
       pv.price,
       pv.price_date,
       pv.fx_rate,
       pv.fx_date,
       pv.value_cents,
       pv.fuente,
       pv.valued_on,
       (pv.instrument_id is not null
          and (pv.price is null or pv.fx_rate is null)) as sin_precio,
       coste.cents                       as contributed_cents,
       (pv.value_cents - coste.cents)::bigint as gain_cents,
       -- El % se DERIVA (nunca se guarda): ganancia sobre el coste, como en
       -- position_return. NULL sin coste.
       round(100.0 * (pv.value_cents - coste.cents) / nullif(coste.cents, 0), 2) as return_pct,
       habiles.dias                      as dias_sin_precio,
       coalesce(habiles.dias > 3, false) as desactualizado
from public.investment_position p
join private.position_value_on(array['infinity'::date]) pv on pv.position_id = p.id
left join public.instrument i on i.id = pv.instrument_id
left join public.v_position_contributions c on c.position_id = p.id
cross join lateral (
  select case
           when pv.instrument_id is null then coalesce(c.contributed_cents, 0)
           else pv.alta_contributed_cents + coalesce((
             select sum(t.amount_cents)
             from public.transaction t
             where t.user_id = p.user_id
               and t.position_id = p.id
               and t.type = 'TRANSFER'
               and t.status <> 'DISCARDED'
               and t.occurred_on > pv.alta_date
           ), 0)
         end::bigint as cents
) coste
left join lateral (
  select count(*)::integer as dias
  from generate_series(pv.price_date + 1, current_date, interval '1 day') as g(d)
  where extract(isodow from g.d) < 6
) habiles on pv.price_date is not null;

comment on view public.v_position_market is
  'Por posición: instrumento seguido, participaciones actuales, último precio y su fecha, valor, coste, ganancia, si viene de un respaldo manual y si el precio está desactualizado (más de 3 días hábiles).';


-- ---------------------------------------------------------------------------
-- position_return: misma firma y mismas columnas. El valor de inicio y el de
-- fin salen de private.position_value_on:
--
--   inicio = valor(p_from)                  (sin valoración: lo aportado)
--   fin    = valor(p_to); 0 si sin_valorar  (como antes)
--
-- Para una posición manual son exactamente las cifras de 20261005090300. Las
-- aportaciones del periodo siguen siendo los traspasos, sin ponderar
-- (20260828090000).
-- ---------------------------------------------------------------------------
create or replace function public.position_return(p_from date, p_to date)
returns table (
  position_id         uuid,
  name                text,
  color               text,
  account_id          uuid,
  start_cents         bigint,
  end_cents           bigint,
  contributions_cents bigint,
  gain_cents          bigint,
  return_pct          numeric,
  valued_on           date,
  sin_valorar         boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with valores as (
    select pv.position_id, pv.fecha, pv.value_cents, pv.valued_on, pv.sin_valorar
    from private.position_value_on(array[p_from, p_to]) pv
  ),
  flujos as (
    select t.position_id, sum(t.amount_cents)::bigint as total
    from public.transaction t
    where t.type = 'TRANSFER'
      and t.status <> 'DISCARDED'
      and t.position_id is not null
      and t.occurred_on > p_from
      and t.occurred_on <= p_to
    group by t.position_id
  ),
  base as (
    select p.id,
           p.name,
           p.color,
           p.account_id,
           coalesce(v0.value_cents, 0)::bigint as inicio,
           case when v1.sin_valorar then 0 else v1.value_cents end::bigint as fin,
           coalesce(f.total, 0)::bigint as aportado,
           v1.valued_on as fecha,
           v1.sin_valorar
    from public.investment_position p
    left join valores v0 on v0.position_id = p.id and v0.fecha = p_from
    left join valores v1 on v1.position_id = p.id and v1.fecha = p_to
    left join flujos f on f.position_id = p.id
    where not p.archived
  )
  select b.id, b.name, b.color, b.account_id,
         b.inicio,
         b.fin,
         b.aportado,
         (b.fin - b.inicio - b.aportado)::bigint,
         round(
           100.0 * (b.fin - b.inicio - b.aportado)
           / nullif(b.inicio + b.aportado, 0),
           2
         ),
         b.fecha,
         b.sin_valorar
  from base b
  order by b.fin desc;
$$;


-- ---------------------------------------------------------------------------
-- position_performance: misma firma y columnas. Las fechas del gráfico son las
-- de las valoraciones del periodo MÁS las de los precios de los instrumentos
-- que se siguen (así una posición sincronizada dibuja su curva diaria). El
-- valor de cada punto sale de private.position_value_on; el coste sigue siendo
-- lo aportado (traspasos) hasta esa fecha.
--
-- Diferencia con la anterior (20260819090500): el valor de un punto ya incluye
-- lo aportado después de la última valoración, el criterio común desde
-- 20261005090300. Con los datos reales a fecha de esta migración no cambia
-- ningún punto (lo comprueba scripts/test-inversiones-sync.mjs).
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
  with fechas as (
    select v.date as fecha
    from public.valuation v
    where v.date between p_from and p_to
    union
    select ip.date
    from public.instrument_price ip
    where ip.date between p_from and p_to
      and ip.instrument_id in (
        select e.instrument_id
        from public.position_unit_event e
        where e.kind = 'ALTA'
      )
  ),
  pares as (
    select p.id, p.name, p.color, f.fecha
    from public.investment_position p
    cross join fechas f
    where not p.archived and p.since <= f.fecha
  ),
  valores as (
    select pv.position_id, pv.fecha, pv.value_cents
    from private.position_value_on((select array_agg(f.fecha) from fechas f)) pv
  ),
  costes as (
    select pr.id, pr.fecha,
           (select coalesce(sum(t.amount_cents), 0)
            from public.transaction t
            where t.position_id = pr.id
              and t.type = 'TRANSFER'
              and t.status <> 'DISCARDED'
              and t.occurred_on <= pr.fecha)::bigint as coste
    from pares pr
  )
  select pr.id,
         pr.name,
         pr.color,
         pr.fecha,
         v.value_cents,
         c.coste,
         round(100.0 * (v.value_cents - c.coste) / nullif(c.coste, 0), 2)
  from pares pr
  join valores v on v.position_id = pr.id and v.fecha = pr.fecha
  join costes c on c.id = pr.id and c.fecha = pr.fecha
  order by pr.name, pr.fecha;
$$;


-- ---------------------------------------------------------------------------
-- v_pending_valuation: el recordatorio de «valora este mes» no tiene sentido
-- para una posición que ya se valora sola. Mismas columnas; solo se excluyen
-- las que siguen un instrumento hoy.
-- ---------------------------------------------------------------------------
create or replace view public.v_pending_valuation with (security_invoker = true) as
select p.user_id,
       p.id as position_id,
       p.name,
       (select max(v.date) from public.valuation v where v.position_id = p.id) as last_valued_on
from public.investment_position p
where not p.archived
  and not exists (
    select 1 from public.valuation v
    where v.position_id = p.id
      and v.period_month = date_trunc('month', current_date)::date
  )
  and coalesce((
    select e.kind = 'ALTA'
    from public.position_unit_event e
    where e.user_id = p.user_id
      and e.position_id = p.id
      and e.kind in ('ALTA', 'BAJA')
      and e.date <= current_date
    order by e.date desc, e.seq desc
    limit 1
  ), false) = false;


-- ---------------------------------------------------------------------------
-- Dejar de seguir un instrumento, en una sola transacción.
--
-- Anota la BAJA y, para que el valor no salte, registra como valoración manual
-- el último valor de mercado de esa fecha (como si se hubiera tecleado): desde
-- ahí la posición sigue el criterio manual de siempre. Si ese mes ya tiene una
-- valoración con fecha POSTERIOR, se respeta (es información más reciente); si
-- la tiene anterior o del mismo día, se sustituye, como hace la pantalla al
-- valorar dos veces el mismo mes. Si ese día no mandaba el mercado (respaldo o
-- sin precio), no se escribe nada: ya manda una valoración manual.
--
-- security invoker: todo pasa por la RLS de quien llama. Devuelve el valor con
-- el que queda la posición, en céntimos.
-- ---------------------------------------------------------------------------
create or replace function public.unfollow_instrument(p_position_id uuid, p_date date)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user  uuid := (select private.current_user_id());
  v_valor bigint;
  v_fuente text;
  v_val_id   uuid;
  v_val_date date;
begin
  if v_user is null then
    raise exception 'Sesión no válida' using errcode = '42501';
  end if;
  if p_date is null or p_date > current_date then
    raise exception 'La fecha no puede ser futura' using errcode = '22023';
  end if;

  select pv.value_cents, pv.fuente into v_valor, v_fuente
  from private.position_value_on(array[p_date]) pv
  where pv.position_id = p_position_id;

  if not found then
    raise exception 'Posición no encontrada' using errcode = 'P0002';
  end if;

  -- El disparador del libro rechaza la BAJA si ese día no se seguía nada.
  insert into public.position_unit_event (user_id, position_id, kind, date)
  values (v_user, p_position_id, 'BAJA', p_date);

  if v_fuente = 'MERCADO' then
    select v.id, v.date into v_val_id, v_val_date
    from public.valuation v
    where v.position_id = p_position_id
      and v.period_month = date_trunc('month', p_date)::date;

    if v_val_id is null then
      insert into public.valuation (user_id, position_id, date, value_cents)
      values (v_user, p_position_id, p_date, v_valor);
    elsif v_val_date <= p_date then
      update public.valuation
         set date = p_date, value_cents = v_valor
       where id = v_val_id;
    end if;
  end if;

  return (
    select pv.value_cents
    from private.position_value_on(array[p_date]) pv
    where pv.position_id = p_position_id
  );
end $$;

comment on function public.unfollow_instrument(uuid, date) is
  'Deja de seguir el instrumento de una posición desde p_date: anota la BAJA y fija como valoración manual el último valor de mercado de ese día. Devuelve el valor resultante en céntimos.';

revoke all on function public.unfollow_instrument(uuid, date) from public, anon;
grant execute on function public.unfollow_instrument(uuid, date) to authenticated;


-- ---------------------------------------------------------------------------
-- Qué instrumentos hay que actualizar: los que sigue hoy alguna posición NO
-- archivada, con su último precio guardado y la fecha del ALTA más antigua
-- vigente (desde dónde rellenar si aún no hay precios).
--
-- Solo para el servidor (la ruta de precios, con service_role, que no tiene
-- RLS). No se concede a authenticated: no le hace falta, y así no hay ni que
-- pensar si revela algo.
-- ---------------------------------------------------------------------------
create or replace function public.instruments_to_refresh()
returns table (
  instrument_id   uuid,
  yahoo_symbol    text,
  currency        text,
  last_price_date date,
  desde           date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with vigentes as (
    select per.instrument_id, per.date
    from public.investment_position p
    cross join lateral (
      select e.kind, e.instrument_id, e.date
      from public.position_unit_event e
      where e.user_id = p.user_id
        and e.position_id = p.id
        and e.kind in ('ALTA', 'BAJA')
        and e.date <= current_date
      order by e.date desc, e.seq desc
      limit 1
    ) per
    where not p.archived
      and per.kind = 'ALTA'
  )
  select i.id,
         i.yahoo_symbol,
         i.currency,
         (select max(ip.date) from public.instrument_price ip where ip.instrument_id = i.id),
         min(v.date)
  from vigentes v
  join public.instrument i on i.id = v.instrument_id
  group by i.id, i.yahoo_symbol, i.currency
  order by i.yahoo_symbol;
$$;

comment on function public.instruments_to_refresh() is
  'Instrumentos que sigue hoy alguna posición no archivada, con su último precio guardado y el ALTA vigente más antigua. Solo service_role (ruta /api/precios).';

revoke all on function public.instruments_to_refresh() from public, anon, authenticated;
grant execute on function public.instruments_to_refresh() to service_role;
