-- ===========================================================================
-- Listas que se pueden leer por páginas y una curva de Inversiones que no
-- revienta el tope de 1.000 filas.
--
-- Cierre de la v1: hallazgo C2 de docs/pruebas/informe-datos.md, lado SQL (el
-- lado TS, leer por páginas, es src/lib/supabase/paginar.ts).
-- Prueba: scripts/test-curva-y-paginas.mjs.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- PostgREST corta cada respuesta a 1.000 filas sin avisar.
--  · position_performance devuelve un punto por posición y por CADA día con
--    precio o valoración: 1.260 filas en «Año» (el rango por defecto) con 6
--    fondos y 15.852 en «Todo». La curva se cortaba (perdía los últimos fondos
--    por nombre) y además tardaba: era la consulta más cara de la app.
--  · search_transactions ordenaba por (fecha, hora, created_at), que empata en
--    los movimientos importados juntos: leer por páginas podía repetir o
--    saltarse filas.
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
--  · position_performance: un punto por día hasta ~6 meses, por semana hasta
--    ~3 años y por mes más allá (el último día con dato de cada tramo, y el
--    primero del rango). «Año» con 6 fondos: ~310 filas; «Todo» con 10 años:
--    ~720. Los valores de cada punto son EXACTAMENTE los de antes (mismo
--    cálculo); solo hay menos puntos en los rangos largos. Misma firma.
--  · search_transactions: `id` como último criterio de orden. Mismo resultado,
--    ahora determinista.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.search_transactions(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_type public.entry_type DEFAULT NULL::public.entry_type, p_account uuid DEFAULT NULL::uuid, p_category uuid DEFAULT NULL::uuid, p_uncategorized boolean DEFAULT false, p_only_shortcut boolean DEFAULT false, p_only_pending boolean DEFAULT false, p_q text DEFAULT NULL::text, p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, user_id uuid, type public.entry_type, amount_cents bigint, description text, occurred_on date, occurred_time time without time zone, occurred_at timestamp with time zone, account_id uuid, to_account_id uuid, category_id uuid, category_type public.entry_type, note text, reimburses_id uuid, reimburses_target_type public.entry_type, source public.tx_source, status public.tx_status, merchant_raw text, card_last4 text, external_id text, device_id uuid, subscription_id uuid, position_id uuid, period_month date, total_count bigint, total_net_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with filtrados as (
    select t.*
    from public.transaction t
    where t.status <> 'DISCARDED'
      and (p_from is null or t.occurred_on >= p_from)
      and (p_to   is null or t.occurred_on <= p_to)
      and (p_type is null or t.type = p_type)
      and (p_account is null or t.account_id = p_account)
      -- «Sin categoría» no es una fila: es la ausencia de una.
      and (not p_uncategorized or t.category_id is null)
      and (p_category is null or t.category_id = p_category)
      and (not p_only_shortcut or t.source = 'SHORTCUT')
      and (not p_only_pending  or t.status = 'PENDING')
      -- Los cuatro campos que busca el prototipo, los cuatro en la base. Las
      -- categorías y cuentas que casan se buscan una vez, no por movimiento.
      and (
        p_q is null or p_q = '' or
        t.description  ilike '%' || p_q || '%' or
        t.merchant_raw ilike '%' || p_q || '%' or
        -- Sin correlación con t (si no, el subplan no se puede «hashear» y
        -- vuelve a ser por fila). No hace falta: un id es único y la FK
        -- compuesta ya ata t.category_id / t.account_id al mismo usuario.
        t.category_id in (
          select c.id from public.category c where c.name ilike '%' || p_q || '%'
        ) or
        t.account_id in (
          select a.id from public.account a where a.name ilike '%' || p_q || '%'
        )
      )
  ),
  -- Los totales, sobre TODO lo que casa y no sobre la página.
  con_totales as (
    select f.*,
           count(*) over ()::bigint as total_count,
           sum(
             case
               when f.type = 'EXPENSE'                              then  f.amount_cents
               -- El reembolso de un gasto descartado no resta (20261020090400).
               when f.type = 'INCOME' and f.reimburses_id is not null
                    and not exists (select 1 from public.transaction g
                                    where g.user_id = f.user_id and g.id = f.reimburses_id
                                      and g.status = 'DISCARDED') then -f.amount_cents
               else 0
             end
           ) over ()::bigint as total_net_cents
    from filtrados f
  )
  select id, user_id, type, amount_cents, description, occurred_on, occurred_time,
         occurred_at, account_id, to_account_id, category_id, category_type, note,
         reimburses_id, reimburses_target_type, source, status, merchant_raw,
         card_last4, external_id, device_id, subscription_id, position_id,
         period_month, total_count, total_net_cents
  from con_totales
  -- `id` al final: un orden TOTAL. Sin él, dos movimientos importados juntos
  -- (misma fecha, hora y created_at) podían salir en cualquier orden, y al
  -- pedir la lista por páginas (.range) una fila se repetía y otra faltaba.
  order by occurred_on desc, occurred_time desc, created_at desc, id desc
  limit greatest(p_limit, 1);
$function$;

CREATE OR REPLACE FUNCTION public.position_performance(p_from date, p_to date)
 RETURNS TABLE(position_id uuid, name text, color text, fecha date, value_cents bigint, cost_cents bigint, return_pct numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with dias as (
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
  -- Un punto por día hasta ~6 meses, uno por semana hasta ~3 años y uno por mes
  -- más allá: el ÚLTIMO día con dato de cada tramo (su valor de cierre), más el
  -- primero del rango, para que la curva arranque donde empieza. El último día
  -- con dato siempre está, así que el final de la curva es el valor de hoy.
  paso as (
    select case
             when p_to - p_from <= 190  then 'day'
             when p_to - p_from <= 1100 then 'week'
             else 'month'
           end as unidad
  ),
  fechas as (
    select max(d.fecha) as fecha
    from dias d
    cross join paso
    group by date_trunc(paso.unidad, d.fecha::timestamp)
    union
    select min(d.fecha)
    from dias d
    having count(*) > 0
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
$function$;
