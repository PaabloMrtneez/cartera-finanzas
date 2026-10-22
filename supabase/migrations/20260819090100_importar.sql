-- ===========================================================================
-- Importar movimientos de un extracto bancario.
--
-- Tres decisiones que sostienen todo lo demás:
--
-- 1. `p_dry_run` recorre EXACTAMENTE el mismo camino que la importación de
--    verdad; lo único que cambia es que no inserta. Una previsualización que
--    calculara sus cifras por otra vía podría prometer 40 movimientos y meter
--    38, y nadie se daría cuenta hasta cuadrar el saldo a mano.
--
-- 2. Se usa `private.match_rule`, la misma función que clasifica lo que llega
--    del Atajo. Copiar aquí la lógica de las reglas garantizaría que algún día
--    las dos se comportaran distinto ante el mismo comercio.
--
-- 3. Los duplicados se detectan contra lo que ya hay en la base Y dentro del
--    propio fichero. Sin lo segundo, la previsualización y la importación
--    darían números distintos: en seco no hay nada insertado con lo que choque
--    la segunda copia, pero en la real sí.
--
-- Lo importado entra CONFIRMED, no PENDING: ya ocurrió en el banco. La bandeja
-- de pendientes es para los cargos de Apple Pay que necesitan un visto bueno,
-- y meter ahí 300 apuntes de historia la volvería inservible.
-- ===========================================================================

create or replace function public.import_transactions(
  p_account_id      uuid,
  p_rows            jsonb,
  p_skip_duplicates boolean default true,
  p_dry_run         boolean default false
)
returns table (
  insertadas     integer,
  duplicadas     integer,
  clasificadas   integer,
  sin_clasificar integer
)
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

comment on function public.import_transactions is
  'Importa movimientos de un extracto. Con p_dry_run recorre el mismo camino sin escribir, para que la previsualización no pueda mentir.';
