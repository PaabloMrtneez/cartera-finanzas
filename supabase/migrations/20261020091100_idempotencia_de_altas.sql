-- ===========================================================================
-- Idempotencia del alta manual y de la importación.
--
-- Cierre de la v1: H-22 de docs/pruebas/informe-robustez.md, lado SQL.
-- Prueba: scripts/test-idempotencia.mjs.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- Ni el alta manual de un movimiento ni la importación tenían clave de
-- idempotencia: solo los protegía el botón deshabilitado mientras se envía.
-- Un doble envío (doble toque, reintento de red) podía dejar dos copias.
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
--  · transaction.client_id (uuid, opcional) con un índice ÚNICO parcial
--    (user_id, client_id): el formulario genera un uuid al abrirse y lo manda
--    con el alta; un segundo envío del mismo formulario choca (23505) y la
--    acción puede responder «ya estaba guardado». Sin client_id, como antes.
--    (El lado TS —el campo oculto y el insert— queda para la acción de alta.)
--  · import_transactions toma un candado de transacción por cuenta
--    (pg_advisory_xact_lock): dos importaciones a la misma cuenta van una
--    detrás de otra, y la segunda ve como duplicadas las filas de la primera.
--    Todo lo demás de la función, igual (definición vigente con ese añadido).
-- ===========================================================================

alter table public.transaction add column client_id uuid;

comment on column public.transaction.client_id is
  'Clave de idempotencia del alta manual: un uuid por formulario. Único por usuario.';

create unique index tx_client_id_uq
  on public.transaction (user_id, client_id)
  where client_id is not null;

CREATE OR REPLACE FUNCTION public.import_transactions(p_account_id uuid, p_rows jsonb, p_skip_duplicates boolean DEFAULT true, p_dry_run boolean DEFAULT false)
 RETURNS TABLE(insertadas integer, duplicadas integer, clasificadas integer, sin_clasificar integer)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select private.current_user_id());
begin
  if v_user is null then
    raise exception 'Sesión no válida';
  end if;

  -- La cuenta tiene que ser tuya. Las políticas de fila ya lo impedirían, pero
  -- así el mensaje dice qué ha pasado en lugar de importar cero sin explicación.
  if not exists (
    select 1 from public.account a
    where a.id = p_account_id and a.user_id = v_user and not a.archived
  ) then
    raise exception 'La cuenta no existe o está archivada';
  end if;

  -- H-22: una importación por cuenta a la vez. Dos envíos del mismo extracto
  -- (doble toque, reintento) ya no se cuelan los dos: el segundo espera a que
  -- el primero termine y entonces SÍ ve sus filas como duplicadas.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cartera.importar:' || p_account_id::text, 0));

  return query
  with entrada as (
    select row_number() over () as n,
           (e->>'occurred_on')::date            as occurred_on,
           coalesce(e->>'description', '')      as description,
           (e->>'amount_cents')::bigint         as cents
    from jsonb_array_elements(p_rows) e
  ),
  tipada as (
    -- El importe se guarda SIEMPRE en positivo: el signo del extracto solo
    -- decide si fue gasto o ingreso.
    select n,
           occurred_on,
           description,
           abs(cents) as amount_cents,
           (case when cents < 0 then 'EXPENSE' else 'INCOME' end)::public.entry_type as type
    from entrada
    where cents <> 0
  ),
  -- Repetidos dentro del mismo fichero: se queda el primero.
  numerada as (
    select t.*,
           row_number() over (
             partition by t.occurred_on, t.description, t.amount_cents, t.type
             order by t.n
           ) as repeticion
    from tipada t
  ),
  marcada as (
    select nu.*,
           (nu.repeticion > 1) or exists (
             select 1
             from public.transaction x
             where x.user_id     = v_user
               and x.account_id  = p_account_id
               and x.occurred_on = nu.occurred_on
               and x.amount_cents = nu.amount_cents
               and x.type        = nu.type
               and x.description = nu.description
               and x.status <> 'DISCARDED'
           ) as es_duplicado
    from numerada nu
  ),
  elegidas as (
    select * from marcada m
    where not (m.es_duplicado and p_skip_duplicates)
  ),
  clasificada as (
    select el.*,
           r.category_id,
           r.category_type
    from elegidas el
    left join lateral (
      select m.category_id, m.category_type
      from private.match_rule(v_user, el.description) m
      -- Solo se aplica la regla si su categoría es del mismo signo que el
      -- apunte. Una regla «NOMINA» apuntando a una categoría de ingreso no
      -- puede colgarse de un gasto que mencione «NOMINA»: aparecería en el
      -- reparto de gastos bajo una categoría de ingresos.
      where m.category_type = el.type
    ) r on true
  ),
  insertada as (
    insert into public.transaction (
      user_id, type, amount_cents, description, occurred_on,
      account_id, category_id, category_type, merchant_raw, source, status
    )
    select v_user, c.type, c.amount_cents, c.description, c.occurred_on,
           p_account_id, c.category_id, c.category_type,
           -- El concepto del extracto ES el texto del comercio: guardarlo
           -- también aquí es lo que permite que las reglas funcionen después
           -- sobre lo ya importado.
           c.description, 'IMPORT', 'CONFIRMED'
    from clasificada c
    where not p_dry_run
    returning 1
  )
  select (select count(*) from clasificada)::integer,
         (select count(*) from marcada where marcada.es_duplicado)::integer,
         (select count(*) from clasificada where clasificada.category_id is not null)::integer,
         (select count(*) from clasificada where clasificada.category_id is null)::integer;
end;
$function$;
