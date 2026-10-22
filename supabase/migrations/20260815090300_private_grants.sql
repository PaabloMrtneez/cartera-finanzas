-- ===========================================================================
-- Permisos mínimos sobre el esquema `private`.
--
-- El esquema se creó con todos los permisos revocados. Eso basta para las
-- políticas de seguridad por filas, que el motor evalúa por su cuenta, pero
-- rompe las funciones de `public` que el usuario invoca directamente
-- (create_ingest_device, apply_merchant_rule, preview_merchant_rule): al ser
-- `security invoker` se ejecutan con sus privilegios, y sin permiso de USO
-- sobre el esquema fallan con «permission denied for schema private».
--
-- Conceder USAGE no abre nada por sí solo: cada función sigue necesitando su
-- propio permiso de ejecución, y aquí se dan exactamente dos.
-- ===========================================================================

grant usage on schema private to authenticated;

-- Resuelve quién es el usuario y exige el segundo factor.
grant execute on function private.current_user_id() to authenticated;

-- Decide qué regla de comercio gana para un texto dado. La necesita
-- apply_merchant_rule, que se ejecuta con los privilegios de quien la llama.
grant execute on function private.match_rule(uuid, text) to authenticated;

-- Lo demás del esquema sigue fuera de su alcance.
revoke all on all tables in schema private from authenticated;
