-- ===========================================================================
-- Que un rechazo deje rastro.
--
-- Hasta ahora, un envío del Atajo que el endpoint rechazaba antes de llegar a
-- la base de datos —un importe que no se entiende, una moneda que no es euro—
-- desaparecía sin más: ni apunte, ni contador, ni forma de saber que había
-- pasado algo. En Ajustes seguía diciendo «0 envíos», que se lee como «el Atajo
-- no está llegando» cuando en realidad llegaba y se tiraba a la basura.
--
-- Con dos pagos reales perdidos hizo falta rebuscar en la base para averiguar
-- qué estaba mandando el iPhone. Eso es exactamente lo que no debe pasar: el
-- rastro tiene que estar guardado antes de que alguien pregunte.
--
-- Esta función se llama SOLO cuando el token ya tiene la forma correcta, así
-- que la basura de internet sigue sin tocar la base de datos.
-- ===========================================================================

alter table public.ingest_device
  add column if not exists rejected_count integer not null default 0;

create or replace function public.record_ingest_rejection(
  p_token   text,
  p_reason  text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev record;
begin
  select d.* into v_dev
  from public.ingest_device d
  where d.token_hash = extensions.digest(p_token, 'sha256')
    and d.revoked_at is null;

  -- Token que no existe: no se guarda nada. Si no, cualquiera podría llenar la
  -- tabla desde fuera mandando tokens inventados.
  if v_dev is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
  values (v_dev.id, v_dev.user_id, p_reason, p_payload);

  -- El intento cuenta como intento. Que «último uso» se mueva es la señal de
  -- que el Atajo SÍ está llegando, que es justo lo que no se sabía.
  update public.ingest_device
     set last_used_at = now(),
         rejected_count = coalesce(rejected_count, 0) + 1
   where id = v_dev.id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.record_ingest_rejection(text, text, jsonb) from public, anon, authenticated;

comment on function public.record_ingest_rejection is
  'Guarda un envío del Atajo que el endpoint rechazó antes de la base de datos. Sin esto, un rechazo no deja rastro y «0 envíos» miente.';
