-- ===========================================================================
-- Buscar movimientos: filtrado, paginación y totales, en una sola consulta.
--
-- Sustituye a la consulta que armaba la página, que tenía tres problemas y los
-- tres venían de lo mismo —hacer en memoria lo que toca hacer en la base:
--
-- 1. Se pedían 100 filas con `limit` y no había forma de ver el resto. Con el
--    filtro en «Todo» eso son los cien movimientos más recientes de tu vida.
--
-- 2. El «X € de gasto» de la cabecera sumaba SOLO esas cien filas. Con más
--    movimientos, la cifra era menor que la real sin avisar de nada.
--
-- 3. La búsqueda por texto solo llegaba a `description` y `merchant_raw` en la
--    base; los nombres de categoría y de cuenta se filtraban después, sobre las
--    cien filas ya traídas. Un movimiento de «Supermercado» que estuviera en la
--    fila 150 no aparecía nunca al buscar «super».
--
-- Aquí se filtra todo en SQL, y el total de filas y el gasto neto salen por
-- funciones de ventana sobre el conjunto COMPLETO, no sobre la página. Así la
-- cabecera dice la verdad independientemente de cuánto se haya cargado.
--
-- El gasto neto respeta el invariante: un ingreso que reembolsa un gasto resta.
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
    left join public.category c on c.id = t.category_id and c.user_id = t.user_id
    left join public.account  a on a.id = t.account_id  and a.user_id = t.user_id
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
      -- Los cuatro campos que busca el prototipo, los cuatro en la base.
      and (
        p_q is null or p_q = '' or
        t.description  ilike '%' || p_q || '%' or
        t.merchant_raw ilike '%' || p_q || '%' or
        c.name         ilike '%' || p_q || '%' or
        a.name         ilike '%' || p_q || '%'
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

comment on function public.search_transactions is
  'Movimientos filtrados y paginados. total_count y total_net_cents son del conjunto completo, no de la página: la cabecera dice la verdad aunque falten filas por cargar.';
