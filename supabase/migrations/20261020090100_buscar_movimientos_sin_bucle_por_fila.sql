-- ===========================================================================
-- Cierre de la v1, hallazgo A2 de docs/pruebas/informe-datos.md.
-- Prueba: scripts/test-valor-posicion.mjs (mismos resultados de búsqueda antes
-- y después) y scripts/test-buscar.mjs.
--
-- search_transactions sin un recorrido de category y account POR FILA.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- Las funciones SQL se planifican con los parámetros como incógnitas (plan
-- genérico). Con los filtros opcionales `(p_x is null or col = p_x)` el
-- planificador estima muy pocas filas y une category y account con un bucle
-- anidado que las recorre enteras por cada movimiento. Con 48.000 movimientos
-- (perfil intenso de scripts/bench-volumen.mjs): 48.065 seq scans de cada una y
-- ~1,3 s para buscar un texto en todo el histórico o pedir 5.000 filas
-- (frente a ~45 ms con 2.000 movimientos).
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
-- Las uniones solo existían para buscar el texto en el nombre de la categoría
-- y de la cuenta. Se cambian por dos semiuniones `in (select id …)` sin
-- correlación, que Postgres resuelve UNA vez (subplan con hash) y no por fila.
-- Un id es único y la FK compuesta ata t.category_id y t.account_id al mismo
-- usuario (y la RLS ya deja solo las suyas), así que casan exactamente las
-- mismas filas. Mismo resultado, misma firma.
-- ===========================================================================

create or replace function public.search_transactions(
  p_from          date    default null,
  p_to            date    default null,
  p_type          public.entry_type default null,
  p_account       uuid    default null,
  p_category      uuid    default null,
  p_uncategorized boolean default false,
  p_only_shortcut boolean default false,
  p_only_pending  boolean default false,
  p_q             text    default null,
  p_limit         integer default 100
)
returns table (
  id                     uuid,
  user_id                uuid,
  type                   public.entry_type,
  amount_cents           bigint,
  description            text,
  occurred_on            date,
  occurred_time          time,
  occurred_at            timestamptz,
  account_id             uuid,
  to_account_id          uuid,
  category_id            uuid,
  category_type          public.entry_type,
  note                   text,
  reimburses_id          uuid,
  reimburses_target_type public.entry_type,
  source                 public.tx_source,
  status                 public.tx_status,
  merchant_raw           text,
  card_last4             text,
  external_id            text,
  device_id              uuid,
  subscription_id        uuid,
  position_id            uuid,
  period_month           date,
  total_count            bigint,
  total_net_cents        bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
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
               when f.type = 'INCOME' and f.reimburses_id is not null then -f.amount_cents
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
  order by occurred_on desc, occurred_time desc, created_at desc
  limit greatest(p_limit, 1);
$$;
