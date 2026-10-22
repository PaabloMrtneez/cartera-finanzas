-- ===========================================================================
-- Alta y revocación de dispositivos de ingesta, con privilegios elevados.
--
-- Las tablas de dispositivos no tienen política de inserción ni de
-- modificación a propósito: si la tuvieran, cualquiera podría darse de alta un
-- dispositivo con un `token_hash` elegido por él y, sabiendo la preimagen,
-- escribir movimientos sin pasar por aquí.
--
-- Por eso estas dos funciones son `security definer`: son la ÚNICA vía para
-- crear o revocar un dispositivo. Resuelven el dueño con
-- private.current_user_id(), que además exige el segundo factor, y acotan cada
-- operación a ese usuario.
-- ===========================================================================

create or replace function public.create_ingest_device(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := (select private.current_user_id());
  v_secret text;
  v_token  text;
  v_id     uuid;
  v_count  integer;
begin
  if v_user is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  if length(btrim(p_name)) < 1 or length(btrim(p_name)) > 40 then
    raise exception 'El nombre debe tener entre 1 y 40 caracteres' using errcode = '23514';
  end if;

  -- Un tope razonable: nadie necesita veinte iPhones conectados, y así un fallo
  -- en bucle no llena la tabla.
  select count(*) into v_count
  from public.ingest_device
  where user_id = v_user and revoked_at is null;

  if v_count >= 5 then
    raise exception 'Ya tienes 5 dispositivos conectados. Revoca alguno antes.'
      using errcode = '23514';
  end if;

  -- 32 bytes de entropía. El token en claro se devuelve una sola vez: en la
  -- base de datos solo queda su hash.
  v_secret := encode(extensions.gen_random_bytes(32), 'hex');
  v_token  := 'cart_' || v_secret;

  insert into public.ingest_device (user_id, name, token_hash, token_prefix)
  values (v_user, btrim(p_name), extensions.digest(v_token, 'sha256'),
          'cart_' || left(v_secret, 6))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'name', btrim(p_name), 'token', v_token);
end $$;


create or replace function public.revoke_ingest_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select private.current_user_id());
begin
  if v_user is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  -- El filtro por user_id es lo que impide revocar el dispositivo de otro:
  -- al ser `security definer`, aquí no hay seguridad por filas que lo haga.
  update public.ingest_device
     set revoked_at = now()
   where id = p_device_id
     and user_id = v_user
     and revoked_at is null;
end $$;

revoke all on function public.create_ingest_device(text) from public, anon;
revoke all on function public.revoke_ingest_device(uuid) from public, anon;
grant execute on function public.create_ingest_device(text) to authenticated;
grant execute on function public.revoke_ingest_device(uuid) to authenticated;
