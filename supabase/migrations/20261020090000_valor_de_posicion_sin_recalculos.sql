-- ===========================================================================
-- Cierre de la v1, hallazgo C1 de docs/pruebas/informe-datos.md.
-- Prueba: scripts/test-valor-posicion.mjs (cifras idénticas antes y después,
-- con datos sintéticos y con los de los usuarios reales, sin imprimirlas).
--
-- Valor de las posiciones sin recálculos: MISMAS cifras, al céntimo, con un
-- coste que deja de crecer con (posiciones × fechas × aportaciones).
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- private.position_value_on calcula en el CTE `aportes` las participaciones de
-- CADA aportación (con tres búsquedas laterales: instrumento, precio y cambio
-- del día) y lo usa una sola vez, dentro del lateral `mov`, que se evalúa por
-- cada par (posición, fecha). Postgres 12+ INLINEA un CTE que se referencia una
-- vez: el CTE entero se recalcula por cada par. Con 10 años (6 posiciones, 600
-- aportaciones) eso son ~6·D·600 búsquedas por consulta, D = fechas pedidas:
--                                           antes     con esta migración (reloj)
--   net_worth_daily (3M + previo, D = 184)   6,5 s     0,9 s   (tope de authenticated: 8 s)
--   net_worth_monthly(120) («Todo»)          2,3 s     0,5 s
--   position_performance «Año» (por defecto) 7,0 s     0,4 s
--   position_performance «Todo» (D ≈ 2.600)  88 s      3,6 s
-- (scripts/bench-volumen.mjs, perfil intenso; ver docs/pruebas/informe-datos.md).
-- Las 17 consultas de la huella del banco (patrimonio, curvas, posiciones,
-- rendimiento, búsqueda) dan EXACTAMENTE lo mismo antes y después.
--
-- position_performance suma además, por cada par (posición, fecha), TODO lo
-- traspasado hasta esa fecha con una subconsulta correlacionada: O(pares ×
-- aportaciones).
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
--  1. `aportes as materialized`: se calcula UNA vez por consulta.
--  2. position_performance: el coste acumulado con una suma de ventana
--     (como account_worth_on hace con los saldos), no una subconsulta por par,
--     materializada, y el join final desde ella.
--  3. Un índice parcial que cubre la suma «aportado después de la última
--     valoración» (lateral `despues`) y la de v_position_contributions, con
--     occurred_on y amount_cents dentro: búsqueda por rango, sin ir al heap.
--
-- Nada cambia de firma, ni de seguridad: security invoker, search_path = '' y
-- los mismos permisos (create or replace los conserva).
-- ===========================================================================

create index if not exists tx_position_flow_idx
  on public.transaction (user_id, position_id, occurred_on) include (amount_cents)
  where position_id is not null and type = 'TRANSFER' and status <> 'DISCARDED';

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
  -- MATERIALIZED: se calcula una vez, no una vez por cada (posición, fecha).
  aportes as materialized (
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
    left join lateral (
      select v.date, v.value_cents
      from public.valuation v
      where v.user_id = b.user_id
        and v.position_id = b.id
        and v.date <= b.fecha
      order by v.date desc
      limit 1
    ) ult on true
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

-- ---------------------------------------------------------------------------
-- position_performance: el mismo resultado; el coste acumulado por ventana.
-- Un traspaso o capital externo con fecha <= la del punto cuenta (orden 0
-- antes que el punto, orden 1, en la misma fecha), igual que el `<=` de antes.
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
  pares as materialized (
    select p.id, p.name, p.color, f.fecha
    from public.investment_position p
    cross join fechas f
    where not p.archived and p.since <= f.fecha
  ),
  valores as (
    select pv.position_id, pv.fecha, pv.value_cents
    from private.position_value_on((select array_agg(f.fecha) from fechas f)) pv
  ),
  flujos as (
    select t.position_id, t.occurred_on as fecha, sum(t.amount_cents) as cents
    from public.transaction t
    where t.position_id is not null
      and t.type = 'TRANSFER'
      and t.status <> 'DISCARDED'
    group by t.position_id, t.occurred_on
    union all
    select ext.position_id, ext.fecha, ext.cents
    from private.position_external_contributions() ext
  ),
  linea as (
    select f.position_id, f.fecha, 0 as orden, f.cents
    from flujos f
    union all
    select pr.id, pr.fecha, 1, 0
    from pares pr
  ),
  -- MATERIALIZED: si no, Postgres empuja `position_id = pr.id` dentro de la
  -- ventana (es su clave de partición) y la recalcula por cada punto.
  costes as materialized (
    select x.position_id as id, x.fecha, x.coste
    from (
      select l.position_id, l.fecha, l.orden,
             (sum(l.cents) over (partition by l.position_id order by l.fecha, l.orden
                                 rows between unbounded preceding and current row))::bigint as coste
      from linea l
    ) x
    where x.orden = 1
  )
  -- `costes` ya tiene una fila por cada par (posición, fecha) de `pares`: se
  -- parte de ella y no de `pares` otra vez. Con `pares` en el join final, el
  -- planificador (que estima ~20 filas para un CTE) llegó a elegir un bucle
  -- anidado de pares × pares: 15.852² comparaciones y 40-65 s en «Todo».
  select c.id,
         p.name,
         p.color,
         c.fecha,
         v.value_cents,
         c.coste,
         round(100.0 * (v.value_cents - c.coste) / nullif(c.coste, 0), 2)
  from costes c
  join public.investment_position p on p.id = c.id
  join valores v on v.position_id = c.id and v.fecha = c.fecha
  order by p.name, c.fecha;
$$;
