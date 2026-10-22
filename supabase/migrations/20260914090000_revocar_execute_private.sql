-- ===========================================================================
-- Quitar el EXECUTE que dos funciones de `private` heredaron de PUBLIC.
--
-- Postgres concede EXECUTE a PUBLIC por defecto al crear una función. Las
-- funciones sensibles del proyecto (`ingest_transaction`, `record_ingest_
-- rejection`, las `claim_*`) ya se blindan con su `revoke`, y a `authenticated`
-- solo se le concede lo justo (`current_user_id`, `match_rule`). Pero dos
-- funciones de `private` conservaron el grant por defecto:
--
--   · private.infer_category(uuid, text) — SECURITY DEFINER, salta la RLS y
--     recibe un p_user ARBITRARIO. Hoy no es alcanzable por la API (PostgREST
--     solo expone `public`), pero es un primitivo latente de lectura entre
--     usuarios y una incoherencia con el patrón de blindaje del resto.
--   · private.handle_new_user() — disparador; no se puede invocar como RPC, pero
--     se le quita el grant por el mismo principio de mínimo privilegio.
--
-- Es defensa en profundidad: si algún día se expusiera el esquema `private` o
-- se creara un envoltorio público, esto ya estaría cerrado. Revoca solo de
-- PUBLIC; no toca los grants explícitos a `authenticated`, así que el motor de
-- reglas (`match_rule`) y el 2FA (`current_user_id`) siguen igual.
--
-- Migración solo hacia delante: revertir sería un grant nuevo, no editar esta.
-- ===========================================================================

revoke execute on function private.infer_category(uuid, text) from public;
revoke execute on function private.handle_new_user() from public;
