-- ===========================================================================
-- Gasto por comercio y mapa de calor hora × día de la semana.
--
-- Las dos salen de v_transaction_econ, así que heredan de una vez los tres
-- invariantes económicos: los traspasos no están, un ingreso normal no cuenta
-- como gasto, y un reembolso RESTA del gasto (net_expense_cents negativo).
--
-- Lo que añaden es DÓNDE se imputa el reembolso. v_transaction_econ lo imputa a
-- la categoría del gasto enlazado; aquí, por la misma razón, se imputa al
-- COMERCIO del gasto enlazado y a la HORA y DÍA en que se hizo ese gasto. Un
-- reembolso no es un gasto que ocurre cuando llega la transferencia: abarata
-- el gasto original, ahí donde ocurrió.
--
-- El PERIODO sí es el del reembolso, igual que en v_month_summary (un reembolso
-- de febrero de una compra de enero resta en febrero). Por eso la suma de
-- cualquiera de las dos funciones sobre un mes cuadra al céntimo con el gasto
-- neto de ese mes en v_month_summary. La contrapartida: una celda o un comercio
-- puede salir negativo si en el periodo solo cae el reembolso; la pantalla
-- decide cómo pintarlo.
--
-- Las dos son security invoker sin filtro de usuario explícito, como
-- category_breakdown y month_pace: la RLS de transaction manda.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Gasto por comercio: los p_limite comercios con más gasto neto del periodo,
-- más dos filas de cierre para que la suma cuadre siempre con el gasto neto:
--
--   grupo = 'COMERCIO'      un comercio del top, en orden (puesto 1..N)
--   grupo = 'OTROS'         todos los demás comercios juntos (y los que se
--                           quedan a cero o en negativo por un reembolso)
--   grupo = 'SIN_COMERCIO'  gastos sin texto de comercio: los apuntados a mano
--                           y los de suscripción no traen merchant_raw
--
-- Las filas OTROS y SIN_COMERCIO solo salen si tienen algún movimiento.
--
-- NORMALIZACIÓN. El comercio se agrupa por merchant_raw en minúsculas, sin
-- espacios en los bordes y con los espacios internos repetidos reducidos a uno:
-- la misma comparación que infer_category (lower(btrim(...))), un poco más
-- tolerante. El nombre que se enseña es la forma original más repetida (a
-- igualdad, la primera en orden alfabético). No se agrupan sufijos de tienda
-- («MERCADONA 1234» y «MERCADONA 5678» son dos): para unir comercios están las
-- reglas, que las decide el usuario.
--
--   net_cents         gasto neto (gastos − reembolsos imputados al comercio)
--   gross_cents       gasto bruto (solo los gastos)
--   reimbursed_cents  reembolsado (positivo)
--   cargos            número de gastos (los reembolsos no cuentan como cargo)
--   comercios         cuántos comercios distintos agrupa la fila
--   share             % del gasto neto del periodo (numeric, 1 decimal; NULL si
--                     el gasto neto del periodo no es positivo)
-- ---------------------------------------------------------------------------
create or replace function public.merchant_spend(
  p_desde  date,
  p_hasta  date,
  p_limite integer default 10
)
returns table (
  grupo            text,
  puesto           integer,
  merchant_key     text,
  merchant         text,
  net_cents        bigint,
  gross_cents      bigint,
  reimbursed_cents bigint,
  cargos           integer,
  comercios        integer,
  share            numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select e.net_expense_cents as neto,
           case when e.type = 'EXPENSE' then e.amount_cents else 0 end as bruto,
           case when e.is_reimbursement then e.amount_cents else 0 end as reembolso,
           (e.type = 'EXPENSE') as es_cargo,
           -- El comercio del propio gasto, o el del gasto que se reembolsa.
           regexp_replace(
             nullif(btrim(case when t.reimburses_id is not null then r.merchant_raw
                               else t.merchant_raw end), ''),
             '\s+', ' ', 'g'
           ) as crudo
    from public.v_transaction_econ e
    join public.transaction t
      on t.user_id = e.user_id and t.id = e.id
    left join public.transaction r
      on r.user_id = t.user_id and r.id = t.reimburses_id
    where e.occurred_on between p_desde and p_hasta
      and (e.type = 'EXPENSE' or e.is_reimbursement)
  ),
  por_comercio as (
    select lower(b.crudo) as clave,
           mode() within group (order by b.crudo) as nombre,
           sum(b.neto)      as neto,
           sum(b.bruto)     as bruto,
           sum(b.reembolso) as reembolso,
           count(*) filter (where b.es_cargo) as cargos
    from base b
    where b.crudo is not null
    group by lower(b.crudo)
  ),
  ranking as (
    select pc.*,
           case
             when pc.neto > 0
               then row_number() over (order by (pc.neto > 0) desc, pc.neto desc, pc.clave)
           end as pos
    from por_comercio pc
  ),
  total as (
    select nullif(sum(b.neto), 0) as t from base b
  ),
  filas as (
    select 'COMERCIO'::text as grupo,
           rk.pos::integer  as puesto,
           rk.clave,
           rk.nombre,
           rk.neto, rk.bruto, rk.reembolso, rk.cargos,
           1::bigint as comercios
    from ranking rk
    where rk.pos <= greatest(1, least(coalesce(p_limite, 10), 50))
    union all
    select 'OTROS', null, null, null,
           sum(rk.neto), sum(rk.bruto), sum(rk.reembolso), sum(rk.cargos), count(*)
    from ranking rk
    where rk.pos is null or rk.pos > greatest(1, least(coalesce(p_limite, 10), 50))
    having count(*) > 0
    union all
    select 'SIN_COMERCIO', null, null, null,
           sum(b.neto), sum(b.bruto), sum(b.reembolso), count(*) filter (where b.es_cargo), 0
    from base b
    where b.crudo is null
    having count(*) > 0
  )
  select f.grupo,
         f.puesto,
         f.clave,
         f.nombre,
         f.neto::bigint,
         f.bruto::bigint,
         f.reembolso::bigint,
         f.cargos::integer,
         f.comercios::integer,
         case when (select t from total) > 0
                then round(100.0 * f.neto / (select t from total), 1)
         end
  from filas f
  order by case f.grupo when 'COMERCIO' then 0 when 'OTROS' then 1 else 2 end,
           f.puesto;
$$;

comment on function public.merchant_spend is
  'Top p_limite comercios por gasto neto del periodo (reembolsos imputados al comercio del gasto enlazado), más OTROS y SIN_COMERCIO para que la suma cuadre con el gasto neto de v_month_summary.';

revoke all on function public.merchant_spend(date, date, integer) from public, anon;
grant execute on function public.merchant_spend(date, date, integer) to authenticated;


-- ---------------------------------------------------------------------------
-- Mapa de calor: gasto neto por día de la semana y hora del día.
--
-- Devuelve la rejilla COMPLETA, siempre 175 filas: 7 días × (24 horas + una
-- fila «sin hora»), con ceros donde no hay nada, para que la pantalla no tenga
-- que rellenar huecos.
--
--   dia_semana  1 = lunes … 7 = domingo (ISO, como se lee en España)
--   hora        0 … 23, o NULL = «sin hora»
--   net_cents   gasto neto de la celda
--   cargos      número de gastos de la celda (los reembolsos no cuentan)
--
-- «SIN HORA». occurred_time es NOT NULL con valor por defecto 00:00, así que un
-- movimiento apuntado a mano sin hora (y los de suscripción, que nacen sin ella)
-- llega como 00:00:00 exacto. Esa hora exacta se trata como «sin hora»: el Atajo
-- manda la hora real con segundos, y un pago a las 00:00:00 en punto es
-- improbable. Dejarlos en la columna de medianoche inventaría un pico de
-- madrugada que no existe.
--
-- Un reembolso se coloca en el día y la hora del GASTO que reembolsa (ver
-- cabecera); si ese gasto no tenía hora, va a «sin hora».
-- ---------------------------------------------------------------------------
create or replace function public.spend_heatmap(p_desde date, p_hasta date)
returns table (
  dia_semana integer,
  hora       integer,
  net_cents  bigint,
  cargos     integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select e.net_expense_cents as neto,
           (e.type = 'EXPENSE') as es_cargo,
           -- Un gasto nunca reembolsa nada, así que r solo existe en los
           -- reembolsos: ahí manda el momento del gasto enlazado.
           coalesce(r.occurred_on, t.occurred_on)     as dia,
           coalesce(r.occurred_time, t.occurred_time) as hora_exacta
    from public.v_transaction_econ e
    join public.transaction t
      on t.user_id = e.user_id and t.id = e.id
    left join public.transaction r
      on r.user_id = t.user_id and r.id = t.reimburses_id
    where e.occurred_on between p_desde and p_hasta
      and (e.type = 'EXPENSE' or e.is_reimbursement)
  ),
  celdas as (
    select extract(isodow from b.dia)::integer as d,
           -- -1 es «sin hora» solo aquí dentro, para poder casar por igualdad.
           case when b.hora_exacta = time '00:00' then -1
                else extract(hour from b.hora_exacta)::integer
           end as h,
           sum(b.neto) as neto,
           count(*) filter (where b.es_cargo) as cargos
    from base b
    group by 1, 2
  ),
  rejilla as (
    select d.n as d, h.n as h
    from generate_series(1, 7) as d(n)
    cross join generate_series(-1, 23) as h(n)
  )
  select g.d,
         nullif(g.h, -1),
         coalesce(c.neto, 0)::bigint,
         coalesce(c.cargos, 0)::integer
  from rejilla g
  left join celdas c on c.d = g.d and c.h = g.h
  -- Por día, las 24 horas en orden y «sin hora» al final.
  order by g.d, (g.h = -1), g.h;
$$;

comment on function public.spend_heatmap is
  'Gasto neto por día de la semana (1 = lunes) y hora (0-23; NULL = sin hora, que es occurred_time 00:00:00 exacto). Rejilla completa de 175 celdas; los reembolsos se colocan en el momento del gasto enlazado.';

revoke all on function public.spend_heatmap(date, date) from public, anon;
grant execute on function public.spend_heatmap(date, date) to authenticated;
