-- ===========================================================================
-- Una posición SEGUIDA sin precio (o sin tipo de cambio) vale lo aportado.
--
-- Cierre de la v1: hallazgo A1 de docs/pruebas/informe-datos.md.
-- Prueba: scripts/test-valor-posicion.mjs (bloque A1) y test-casos-limite.mjs.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- private.position_value_on decide la fuente del valor: MERCADO
-- (participaciones × precio × cambio), RESPALDO (una valoración manual del
-- periodo posterior al último precio) o MANUAL. Una posición que sigue un
-- instrumento pero no tiene AÚN ningún precio —se acaba de dar de alta, Yahoo
-- no lo encuentra— o cuya divisa no tiene tipo de cambio cae en MANUAL, y
-- MANUAL es «última valoración + lo traspasado después». Sin valoraciones, eso
-- es solo lo traspasado desde la app: el capital declarado en el ALTA
-- (contributed_cents) no entra. Resultado: valor 0 con 1.000 € declarados,
-- ganancia −100 % y el patrimonio invertido sin la posición. La cabecera de
-- 20261007110100 ya decía que en ese caso «vale lo aportado»; el código no.
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
-- Para una posición seguida en esa fecha, sin precio que mande y sin
-- valoración DEL PERIODO (posterior o igual al ALTA), el valor es lo aportado
-- en el periodo: max(lo declarado en el ALTA, lo traspasado hasta ese día) +
-- lo traspasado después, hasta la fecha. Coincide con el coste que usa
-- v_position_market (traspasos + capital externo del ALTA), así que la
-- ganancia de una posición sin precio es 0 y no −100 %.
--
-- No cambia nada más: MERCADO y RESPALDO igual; las posiciones no seguidas
-- (manuales) igual; sin_valorar sigue siendo «ni precio ni valoración». Es la
-- función de 20261020090000 (sin recálculos) con ese único cambio; la suma
-- nueva usa el índice tx_position_flow_idx de esa migración.
-- ===========================================================================

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
           (coalesce(ult.value_cents, 0) + coalesce(despues.cents, 0))::bigint as manual_cents,
           -- Lo aportado en este periodo de seguimiento: lo declarado en el
           -- ALTA (o lo traspasado hasta ese día, si fue más) más lo traspasado
           -- después, hasta la fecha. Es lo que vale una posición seguida que
           -- aún no tiene precio (o cambio) ni valoración propia del periodo.
           (greatest(coalesce(b.alta_contributed, 0), coalesce(apo.hasta_alta, 0))
              + coalesce(apo.tras_alta, 0))::bigint as aportado_cents
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
    left join lateral (
      select sum(t.amount_cents) filter (where t.occurred_on <= b.alta_date) as hasta_alta,
             sum(t.amount_cents) filter (where t.occurred_on >  b.alta_date) as tras_alta
      from public.transaction t
      where t.user_id = b.user_id
        and t.position_id = b.id
        and t.type = 'TRANSFER'
        and t.status <> 'DISCARDED'
        and t.occurred_on <= b.fecha
    ) apo on b.instrument_id is not null
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
           -- Seguida, sin precio o sin cambio, y sin valoración del periodo:
           -- vale lo aportado (antes caía a la valoración anterior al ALTA o
           -- a 0, y el patrimonio perdía la posición entera).
           when d.instrument_id is not null
                and (d.val_date is null or d.val_date < d.alta_date)
             then d.aportado_cents
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
