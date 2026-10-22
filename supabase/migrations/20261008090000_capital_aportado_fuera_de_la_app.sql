-- ===========================================================================
-- El aportado declarado en el ALTA cuenta como coste: capital aportado FUERA
-- de la app.
--
-- Corrige 20261007110100_valor_de_mercado_de_las_posiciones.sql (ya aplicada:
-- no se edita). Allí el ALTA del libro guarda `contributed_cents`, «lo que
-- llevabas aportado en total ese día», y la ficha (v_position_market) lo usaba
-- como coste; pero position_return, portfolio_return y position_performance
-- solo contaban como aportado los traspasos. Una posición NUEVA que nace
-- sincronizada, sin traspasos enlazados, empezaba el periodo valiendo 0 y sin
-- flujos, así que TODO su valor salía como ganancia (visto en pantalla:
-- «Aportado 6000 €, Ganancia +7517 €, Rendimiento +125 %» mientras las fichas
-- cuadraban).
--
-- ── LA REGLA ─────────────────────────────────────────────────────────────────
--
-- El aportado de un ALTA es dinero que pusiste ANTES de que la app lo viera. La
-- parte que no está ya respaldada por aportaciones reales (traspasos a la
-- posición, sin descartar) con fecha <= la del ALTA es CAPITAL EXTERNO:
--
--     hueco(ALTA)   = aportado declarado − traspasos a la posición hasta su fecha
--     externo(ALTA) = greatest(0, hueco)
--
-- y ese capital es un FLUJO DE ENTRADA más, igual que un traspaso, en todo
-- cálculo de coste, ganancia y rendimiento. Así:
--
--   · Posición nueva sincronizada sin traspasos: aportado = lo declarado y
--     ganancia = valor − declarado, lo mismo que dice su ficha.
--   · Posición manual convertida cuyos traspasos ya suman lo declarado (la
--     pantalla lo pre-rellena así): externo 0, no cambia nada.
--   · Declaró MÁS que sus traspasos: la diferencia entra como capital externo.
--   · Declaró MENOS que sus traspasos: no se resta nada (greatest 0). Los
--     traspasos son movimientos reales que salieron de una cuenta; una cifra
--     tecleada no los deshace. El coste es lo traspasado. (Antes, la FICHA
--     sí creía la cifra declarada en este caso y daba un coste menor; ahora la
--     ficha usa la misma regla que el resto y las dos cifras coinciden.)
--   · AJUSTE: no crea flujo, solo corrige participaciones. BAJA: tampoco.
--
-- ── VARIOS ALTAS (volver a seguir tras una BAJA, o cambiar de instrumento) ──
--
-- Cada ALTA declara el TOTAL aportado a su fecha, no lo nuevo. Para no contar
-- dos veces el mismo capital, el externo acumulado es el MÁXIMO de los huecos
-- de los ALTA hasta ese (en el orden del libro: fecha y, a igual fecha, seq), y
-- cada ALTA solo aporta lo que ese máximo crece:
--
--     externo_acumulado(k) = greatest(0, max(hueco(1..k)))
--     flujo(k)             = externo_acumulado(k) − externo_acumulado(k − 1)
--
-- Volver a seguir declarando lo mismo de antes más lo traspasado desde
-- entonces: flujo 0. Declarando más (metiste dinero fuera de la app mientras
-- no se seguía): entra la diferencia. Declarando menos: nada se resta.
--
-- ── CUÁNDO ENTRA ESE FLUJO ───────────────────────────────────────────────────
--
-- «Antes de que la app lo viera» marca la fecha. La app ve una posición por
-- primera vez con su PRIMERA VALORACIÓN o con su ALTA, lo que antes ocurra:
--
--   · Posición nueva (sin valoraciones): el flujo entra en la fecha del ALTA.
--   · Posición manual que ya se valoraba y se pasa a seguir: el flujo entra en
--     la fecha de su PRIMERA valoración. Esas valoraciones ya contenían ese
--     dinero; si entrase en la fecha del ALTA, un periodo que empieza entre la
--     primera valoración y el ALTA lo contaría dos veces (en el valor de inicio
--     y como flujo) y el rendimiento saldría hundido —«−45 %» por convertir—.
--     Un periodo que empieza antes de la primera valoración sí lo cuenta.
--   · ALTAS posteriores (volver a seguir): su crecimiento entra en la fecha de
--     ese ALTA. Es dinero del que la app no sabía nada hasta entonces.
--
-- ── LO QUE NO CAMBIA ─────────────────────────────────────────────────────────
--
-- El PATRIMONIO. El valor de la posición (private.position_value_on) ya cuenta
-- entero en el patrimonio; esto solo cambia contra qué se mide. Ni
-- v_position_contributions (que es lo TRASPASADO y v_net_worth, v_account_worth
-- y private.account_worth_on restan del saldo para no contar dos veces el
-- dinero que pasó de caja a posición) ni v_position_value, ni el patrimonio
-- diario, mensual o por cuenta, ni las metas: el capital externo no salió de
-- ninguna cuenta de la app, no hay nada que restar.
--
-- Cambian:
--   · private.position_external_contributions()  nueva: los flujos externos
--   · position_return       contributions_cents incluye el capital externo
--                           del periodo (y con ella portfolio_return, que
--                           suma sus filas y no se toca)
--   · position_performance  cost_cents incluye el capital externo hasta la
--                           fecha (la curva «Aportado frente a valor»)
--   · v_position_market     contributed_cents = traspasos + capital externo
--                           (la ficha y la cabecera de /inversiones)
--
-- Con los datos reales a fecha de esta migración no cambia ninguna cifra:
-- ninguna posición real tiene ALTA. Lo comprueba
-- scripts/test-rendimiento-alta.mjs.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Los flujos de capital externo: una fila por ALTA que hace crecer el
-- externo acumulado de su posición (las de crecimiento 0 no salen).
--
-- security invoker: la RLS del libro, de los movimientos y de las
-- valoraciones decide qué filas entran; cada usuario solo ve las suyas.
-- ---------------------------------------------------------------------------
create or replace function private.position_external_contributions()
returns table (
  user_id     uuid,
  position_id uuid,
  fecha       date,
  cents       bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with altas as (
    select e.user_id,
           e.position_id,
           e.date,
           e.seq,
           e.contributed_cents - coalesce((
             select sum(t.amount_cents)
             from public.transaction t
             where t.user_id = e.user_id
               and t.position_id = e.position_id
               and t.type = 'TRANSFER'
               and t.status <> 'DISCARDED'
               and t.occurred_on <= e.date
           ), 0) as hueco,
           row_number() over w as orden
    from public.position_unit_event e
    where e.kind = 'ALTA'
    window w as (partition by e.user_id, e.position_id order by e.date, e.seq)
  ),
  acumulado as (
    select a.*,
           greatest(0, max(a.hueco) over w) as externo
    from altas a
    window w as (partition by a.user_id, a.position_id order by a.date, a.seq
                 rows between unbounded preceding and current row)
  ),
  crecimiento as (
    select a.*,
           a.externo - coalesce(lag(a.externo) over w, 0) as cents
    from acumulado a
    window w as (partition by a.user_id, a.position_id order by a.date, a.seq)
  )
  select c.user_id,
         c.position_id,
         case
           -- El primer ALTA: cuando la app vio la posición por primera vez
           -- (least ignora el NULL de una posición sin valoraciones).
           when c.orden = 1 then least(c.date, (
             select min(v.date)
             from public.valuation v
             where v.user_id = c.user_id
               and v.position_id = c.position_id
           ))
           else c.date
         end,
         c.cents::bigint
  from crecimiento c
  where c.cents > 0;
$$;

comment on function private.position_external_contributions() is
  'Capital aportado fuera de la app: por cada ALTA, lo que crece greatest(0, max(aportado declarado − traspasos hasta su fecha)). El del primer ALTA entra en la fecha de la primera valoración si es anterior. Flujo de entrada para coste y rendimiento; no toca el patrimonio.';

revoke all on function private.position_external_contributions() from public, anon;
grant execute on function private.position_external_contributions() to authenticated;


-- ---------------------------------------------------------------------------
-- position_return: copia de 20261007110100 salvo `flujos`, que suma al
-- traspaso el capital externo con fecha dentro del periodo. Misma firma y
-- mismas columnas. portfolio_return suma sus filas: se corrige con ella.
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
    select x.position_id, sum(x.cents)::bigint as total
    from (
      select t.position_id, t.amount_cents as cents
      from public.transaction t
      where t.type = 'TRANSFER'
        and t.status <> 'DISCARDED'
        and t.position_id is not null
        and t.occurred_on > p_from
        and t.occurred_on <= p_to
      union all
      select ext.position_id, ext.cents
      from private.position_external_contributions() ext
      where ext.fecha > p_from
        and ext.fecha <= p_to
    ) x
    group by x.position_id
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
-- position_performance: copia de 20261007110100 salvo `costes`: lo traspasado
-- hasta la fecha MÁS el capital externo con fecha <= ella.
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
  externos as (
    select ext.position_id, ext.fecha, ext.cents
    from private.position_external_contributions() ext
  ),
  costes as (
    select pr.id, pr.fecha,
           ((select coalesce(sum(t.amount_cents), 0)
             from public.transaction t
             where t.position_id = pr.id
               and t.type = 'TRANSFER'
               and t.status <> 'DISCARDED'
               and t.occurred_on <= pr.fecha)
            + (select coalesce(sum(x.cents), 0)
               from externos x
               where x.position_id = pr.id
                 and x.fecha <= pr.fecha))::bigint as coste
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
-- v_position_market: mismas columnas, en el mismo orden y con los mismos
-- tipos. Solo cambia el coste (contributed_cents, y con él gain_cents y
-- return_pct): lo traspasado más TODO el capital externo de la posición, la
-- siga hoy o no. Una posición que dejó de seguirse conserva como coste el
-- capital que declaró al seguirla (antes volvía a contar solo los traspasos y
-- ese capital pasaba a ser ganancia).
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
left join (
  select ext.position_id, sum(ext.cents) as cents
  from private.position_external_contributions() ext
  group by ext.position_id
) externo on externo.position_id = p.id
cross join lateral (
  select (coalesce(c.contributed_cents, 0) + coalesce(externo.cents, 0))::bigint as cents
) coste
left join lateral (
  select count(*)::integer as dias
  from generate_series(pv.price_date + 1, current_date, interval '1 day') as g(d)
  where extract(isodow from g.d) < 6
) habiles on pv.price_date is not null;

comment on view public.v_position_market is
  'Por posición: instrumento seguido, participaciones actuales, último precio y su fecha, valor, coste (traspasos + capital aportado fuera de la app declarado en el ALTA), ganancia, si viene de un respaldo manual y si el precio está desactualizado (más de 3 días hábiles).';
