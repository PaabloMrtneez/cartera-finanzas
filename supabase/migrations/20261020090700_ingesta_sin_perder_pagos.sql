-- ===========================================================================
-- La ingesta del Atajo no pierde pagos por una tarjeta o una fecha raras.
--
-- Cierre de la v1: H-02 de docs/pruebas/informe-robustez.md, lado SQL (la
-- validación en la ruta TS es de otro cambio). Prueba: scripts/test-ingesta-rara.mjs.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- public.ingest_transaction hacía `(p_payload ->> 'occurred_at')::timestamptz`
-- (una fecha que no se entiende LANZA) y guardaba los dígitos de la tarjeta en
-- card_last4, cuyo CHECK exige exactamente 4 (con 5, o con 2, LANZA). Al lanzar
-- se deshacía todo, también el registro del rechazo: la ruta respondía 500 y
-- el pago desaparecía sin dejar rastro en ingest_dead_letter.
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
--  · Tarjeta: de un número de 4 o más dígitos se usan los 4 últimos (para
--    enrutar y guardar; nunca más). Con 1-3 dígitos: ingest_dead_letter con
--    motivo BAD_CARD y error 'invalid_card'. Sin dígitos, como antes (sin
--    tarjeta: la cuenta por defecto).
--  · Fecha: si no se entiende, o queda fuera de lo razonable (antes de 2000 o
--    más de 400 días en el futuro, el CHECK de los movimientos), BAD_DATE y
--    error 'invalid_date'. Vacía, ahora (como antes).
--  · Cualquier otro rechazo de la base al insertar: DB_ERROR (con el SQLSTATE
--    en el payload guardado) y error 'db_error', en vez de un 500.
--  Todo lo demás, igual (es la definición vigente con esos cambios): sigue
--  siendo security definer con search_path = '', con los mismos permisos.
--
-- Motivos nuevos en ingest_dead_letter: BAD_CARD, BAD_DATE, DB_ERROR (la
-- pantalla de Ajustes los debe traducir, como NO_ACCOUNT).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.ingest_transaction(p_token text, p_amount_cents bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dev      public.ingest_device%rowtype;
  v_window   timestamptz := date_trunc('hour', now())
                            + floor(extract(minute from now()) / 10) * interval '10 minutes';
  v_hits     integer;
  v_merchant text := nullif(btrim(p_payload ->> 'merchant'), '');
  -- Solo los dígitos; de un número largo, los cuatro últimos (nunca se guarda
  -- más). Con 1-3 dígitos no es una tarjeta: se rechaza con rastro (BAD_CARD).
  v_digitos  text := regexp_replace(coalesce(p_payload ->> 'card', ''), '\D', '', 'g');
  v_card     text := case when length(v_digitos) >= 4 then right(v_digitos, 4) end;
  v_when     timestamptz;
  v_local    timestamp;
  v_ext      text := nullif(btrim(p_payload ->> 'external_id'), '');
  v_account  uuid;
  v_cat      uuid;
  v_cat_type public.entry_type;
  v_id       uuid;
  v_dup      boolean := false;
  v_heredada boolean := false;
begin
  -- 1) Autenticar el dispositivo. La búsqueda va por el hash, nunca por el
  --    secreto, y el índice único sobre token_hash la hace inmediata.
  select * into v_dev
  from public.ingest_device
  where token_hash = extensions.digest(p_token, 'sha256')
    and revoked_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  -- 2) Limitar peticiones: 60 cada 10 minutos y por dispositivo.
  insert into public.ingest_bucket (device_id, window_start, hits)
  values (v_dev.id, v_window, 1)
  on conflict (device_id, window_start)
    do update set hits = public.ingest_bucket.hits + 1
  returning hits into v_hits;

  if v_hits > 60 then
    insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
    values (v_dev.id, v_dev.user_id, 'RATE_LIMITED', p_payload);
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'retry_after', 600);
  end if;

  update public.ingest_device
     set last_used_at = now(), request_count = request_count + 1
   where id = v_dev.id;

  -- 3) El importe ya viene normalizado y validado por la ruta de la API.
  if p_amount_cents is null or p_amount_cents <= 0 then
    insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
    values (v_dev.id, v_dev.user_id, 'BAD_AMOUNT', p_payload);
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  -- 3b) Una tarjeta con 1-3 dígitos no identifica nada: antes reventaba el
  --     CHECK tx_card_last4_fmt y el pago se perdía sin rastro.
  if length(v_digitos) between 1 and 3 then
    insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
    values (v_dev.id, v_dev.user_id, 'BAD_CARD', p_payload);
    return jsonb_build_object('ok', false, 'error', 'invalid_card');
  end if;

  -- 4) Fecha local: los meses deben cuadrar en Madrid, no en UTC. Una fecha
  --    que no se entiende (o fuera de lo razonable) se rechaza con rastro
  --    (BAD_DATE); antes el cast lanzaba y el pago se perdía.
  begin
    v_when := coalesce(nullif(btrim(p_payload ->> 'occurred_at'), '')::timestamptz, now());
  exception when others then
    v_when := null;
  end;
  v_local := v_when at time zone 'Europe/Madrid';

  if v_when is null or v_local::date < date '2000-01-01' or v_local::date > private.hoy() + 400 then
    insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
    values (v_dev.id, v_dev.user_id, 'BAD_DATE', p_payload);
    return jsonb_build_object('ok', false, 'error', 'invalid_date');
  end if;

  -- 5) ¿A qué cuenta va? Primero por la tarjeta: `public.card` enruta cada
  --    último4 a su cuenta, y una cuenta puede tener varias tarjetas. Si la
  --    tarjeta no identifica ninguna, la cuenta que el usuario haya designado en
  --    Ajustes. Nunca se adivina: si no hay ninguna, se rechaza y queda
  --    registrado para poder recuperarlo después.
  select a.id into v_account
  from public.card ct
  join public.account a
    on a.user_id = ct.user_id and a.id = ct.account_id
  where ct.user_id = v_dev.user_id and ct.last4 = v_card and not a.archived
  limit 1;

  if v_account is null then
    select p.default_ingest_account_id into v_account
    from public.profile p where p.user_id = v_dev.user_id;
  end if;

  if v_account is null then
    insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
    values (v_dev.id, v_dev.user_id, 'NO_ACCOUNT', p_payload);
    return jsonb_build_object('ok', false, 'error', 'no_account_configured');
  end if;

  -- 6) Idempotencia. Lo ideal es que el Atajo mande un identificador propio por
  --    ejecución; si no lo hace, se sintetiza uno determinista para que un
  --    reintento no duplique el cargo.
  if v_ext is null then
    v_ext := 'syn_' || encode(extensions.digest(
               v_dev.user_id::text || '|' || coalesce(v_merchant, '') || '|'
               || p_amount_cents::text || '|' || to_char(v_local, 'YYYYMMDDHH24MI')
               || '|' || coalesce(v_card, ''), 'sha256'), 'hex');
  end if;

  -- 7) Motor de reglas.
  select m.category_id, m.category_type into v_cat, v_cat_type
  from private.match_rule(v_dev.user_id, v_merchant) m;

  -- 7b) Si ninguna regla acierta, se mira qué hiciste con este mismo comercio.
  --     Solo hereda si todo su historial coincide; con dos criterios distintos
  --     se queda pendiente y lo decides tú.
  if v_cat is null and v_merchant is not null then
    select i.category_id, i.category_type into v_cat, v_cat_type
    from private.infer_category(v_dev.user_id, v_merchant) i;

    v_heredada := v_cat is not null;
  end if;

  -- 8) Insertar. Con categoría —por regla o heredada— entra confirmado; si no,
  --    espera en la bandeja de pendientes. Si la base lo rechaza por lo que
  --    sea (un CHECK nuevo, un dato raro), el pago queda en ingest_dead_letter
  --    con el código del error (DB_ERROR) en vez de perderse con un 500.
  begin
  insert into public.transaction (
    user_id, type, amount_cents, description,
    occurred_on, occurred_time, occurred_at,
    account_id, category_id, category_type,
    source, status, merchant_raw, card_last4, external_id, device_id
  )
  values (
    v_dev.user_id, 'EXPENSE', p_amount_cents, coalesce(v_merchant, 'Cargo'),
    v_local::date, v_local::time, v_when,
    v_account, v_cat, v_cat_type,
    'SHORTCUT',
    case when v_cat is null then 'PENDING'::public.tx_status else 'CONFIRMED'::public.tx_status end,
    v_merchant, v_card, v_ext, v_dev.id
  )
  on conflict (user_id, external_id) where external_id is not null do nothing
  returning id into v_id;
  exception when others then
    insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
    values (v_dev.id, v_dev.user_id, 'DB_ERROR',
            p_payload || jsonb_build_object('_sqlstate', sqlstate));
    return jsonb_build_object('ok', false, 'error', 'db_error');
  end;

  if v_id is null then
    v_dup := true;
    select id into v_id
    from public.transaction
    where user_id = v_dev.user_id and external_id = v_ext;
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'duplicate', v_dup,
    'amount_cents', p_amount_cents,
    'status', case when v_cat is null then 'PENDING' else 'CONFIRMED' end,
    'category', (select c.name from public.category c where c.id = v_cat),
    'user_id', v_dev.user_id,
    'merchant', v_merchant,
    'account', (select a.name from public.account a where a.id = v_account),
    -- Para poder decirlo en el aviso: heredar no es lo mismo que acertar por
    -- regla, y quien lo recibe tiene derecho a saber de dónde salió.
    'inherited', v_heredada
  );
end $function$;
