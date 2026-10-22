-- ===========================================================================
-- Retirar la columna vestigial `account.card_last4`.
--
-- Las tarjetas viven en `public.card` desde `20260924090000`: la ingesta enruta
-- por ahí y la interfaz la lee/escribe ahí. `account.card_last4` ya no la usa
-- nadie —quedaba de cuando una cuenta tenía como mucho una tarjeta—.
--
-- El único obstáculo para soltarla es que `v_account_balance` la exponía. Quitar
-- una columna de esa vista obligaría a recrear la cadena de vistas del dinero que
-- cuelga de ella (v_account_worth, v_net_worth), y no merece ese riesgo por una
-- limpieza. En su lugar se desengancha la vista de la columna con `null::text`
-- (misma forma de salida: `create or replace` lo admite sin tocar dependientes) y
-- luego se suelta la columna de la tabla. La vista conserva un `card_last4`
-- siempre nulo, inofensivo, que ningún consumidor lee.
--
-- Al soltar la columna caen con ella su índice único (`account_card_last4_uq`) y
-- su check (`account_card_last4`). Hacia delante, como todas.
-- ===========================================================================

-- 1) Desenganchar la vista de la columna. Idéntica a la vigente salvo `card_last4`,
--    que pasa de `a.card_last4` a `null::text`. security_invoker se conserva
--    (invariante: toda vista lo lleva).
create or replace view public.v_account_balance with (security_invoker = true) as
select a.user_id,
       a.id                as account_id,
       a.name,
       a.type,
       a.color,
       null::text          as card_last4,   -- retirada: las tarjetas viven en public.card
       a.archived,
       a.initial_balance_cents,
       a.initial_balance_cents::numeric + coalesce(m.sum_delta, 0::numeric) as balance_cents,
       coalesce(m.movement_count, 0::bigint)                                as movement_count
from public.account a
     left join lateral (
       select sum(v.delta_cents) as sum_delta,
              count(*)           as movement_count
       from public.v_account_movement v
       where v.account_id = a.id
     ) m on true;

-- 2) Soltar la columna. Sin CASCADE a propósito: si algo aún dependiera de ella,
--    que falle en voz alta en vez de arrastrar objetos por sorpresa.
alter table public.account drop column card_last4;
