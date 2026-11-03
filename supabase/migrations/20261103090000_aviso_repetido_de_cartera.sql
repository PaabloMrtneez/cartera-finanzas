-- ===========================================================================
-- El mismo aviso de Cartera dos veces: pendiente y con «¿Repetido?».
--
-- Cartera (Wallet) avisa a veces DOS veces de un mismo pago: en una gasolinera
-- llega la preautorización y, un par de minutos después, el cargo, los dos con
-- el mismo importe. Cada aviso lleva su minuto, así que tienen identificadores
-- distintos y entraban los dos como gastos sin que nada lo señalara (un
-- repostaje de 65 € apuntado dos veces, el 31 de octubre).
--
-- La comparación con el OTRO camino (NFC frente a aviso) no lo cubría: aquí los
-- dos llegan por el mismo. Y no se puede fundir sin más: dos cafés seguidos en
-- el mismo bar, o tres partidas de 1 € en una máquina, son pagos de verdad.
--
-- Por eso, igual que con las demás dudas, un duplicado que ves es mejor que un
-- pago perdido: si en los 10 minutos anteriores entró otro AVISO con el mismo
-- comercio, importe y cuenta, el nuevo entra PENDIENTE y con una nota que dice
-- cuándo llegó el otro. Se confirma o se borra con un toque. El atajo NFC no
-- cambia.
--
-- Solo se redefine ingest_transaction, idéntica a la de 20261027090000 salvo el
-- paso 8b. Sigue security definer con search_path = '' y solo para service_role.
-- ===========================================================================

create or replace function public.ingest_transaction(p_token text, p_amount_cents bigint, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  -- Por dónde llega: el aviso de Cartera o el atajo NFC de siempre.
  v_origen   text := case when upper(coalesce(p_payload ->> 'origin', '')) = 'CARTERA'
                          then 'CARTERA' else 'NFC' end;
  v_tarjeta  text := nullif(btrim(p_payload ->> 'wallet_card'), '');
  v_when     timestamptz;
  v_local    timestamp;
  v_ext      text := nullif(btrim(p_payload ->> 'external_id'), '');
  v_account  uuid;
  v_por_defecto boolean := false;
  v_destino  uuid;
  v_cat      uuid;
  v_cat_type public.entry_type;
  v_id       uuid;
  v_dup      boolean := false;
  v_heredada boolean := false;
  v_nota     text;
  v_mismas   integer;
  v_todas    integer;
  v_gemelo   uuid;
  v_fundido  record;
  v_previo   record;
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

  --    Pasado el límite se deja UNA marca por ventana (la petición 61), no una
  --    fila por petición: con un token robado, cada envío de más guardaba su
  --    payload entero y la tabla crecía sin tope.
  if v_hits > 60 then
    if v_hits = 61 then
      insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
      values (v_dev.id, v_dev.user_id, 'RATE_LIMITED', p_payload);
    end if;
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

  -- 5) ¿A qué cuenta va?
  --    · Aviso de Cartera: por el nombre de la tarjeta (`wallet_card`); si no
  --      está, una cuenta que se llame igual, solo si hay UNA.
  --    · Atajo NFC: por los cuatro dígitos (`public.card`).
  --    Si nada la identifica, la cuenta que el usuario haya designado en
  --    Ajustes; un aviso que acaba ahí va PENDIENTE y con nota, porque es una
  --    suposición. Sin cuenta por defecto, se rechaza y queda registrado.
  if v_origen = 'CARTERA' then
    if v_tarjeta is not null then
      select wc.account_id into v_account
      from public.wallet_card wc
      join public.account a on a.user_id = wc.user_id and a.id = wc.account_id
      where wc.user_id = v_dev.user_id
        and wc.name_norm = private.nombre_normalizado(v_tarjeta)
        and not a.archived and a.type::text <> 'PRESTAMO';

      if v_account is null then
        select (array_agg(a.id))[1] into v_account
        from public.account a
        where a.user_id = v_dev.user_id and not a.archived and a.type::text <> 'PRESTAMO'
          and private.nombre_normalizado(a.name) = private.nombre_normalizado(v_tarjeta)
        having count(*) = 1;
      end if;
    end if;
  else
    select a.id into v_account
    from public.card ct
    join public.account a
      on a.user_id = ct.user_id and a.id = ct.account_id
    where ct.user_id = v_dev.user_id and ct.last4 = v_card and not a.archived
    limit 1;
  end if;

  if v_account is null then
    select p.default_ingest_account_id into v_account
    from public.profile p where p.user_id = v_dev.user_id;
    v_por_defecto := v_origen = 'CARTERA' and v_account is not null;
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

  -- 6b) Un envío de este usuario cada vez: los dos atajos de un mismo pago
  --     corren a la vez, y sin esto cada uno buscaría al otro antes de que
  --     existiera y entrarían los dos.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cartera.ingesta:' || v_dev.user_id::text, 0));

  --     ¿Este mismo envío ya entró (reintento)? Como pago propio o fundido con
  --     otro: se responde lo mismo y no se crea nada.
  select t.id into v_id
  from public.transaction t
  where t.user_id = v_dev.user_id and t.external_id = v_ext;
  if v_id is null then
    select m.transaction_id into v_id
    from public.ingest_merged m
    where m.user_id = v_dev.user_id and m.external_id = v_ext;
  end if;
  if v_id is not null then
    return private.ingest_respuesta(v_id, true, false, p_amount_cents);
  end if;

  -- 7) Recarga: el comercio es otra de tus tarjetas de Cartera. Es dinero que
  --    pasa de una cuenta tuya a otra: un traspaso, no un gasto. Solo con la
  --    cuenta de origen segura (no la de por defecto) y destino distinto.
  if v_origen = 'CARTERA' and v_merchant is not null and not v_por_defecto then
    select wc.account_id into v_destino
    from public.wallet_card wc
    join public.account a on a.user_id = wc.user_id and a.id = wc.account_id
    where wc.user_id = v_dev.user_id
      and wc.name_norm = private.nombre_normalizado(v_merchant)
      and wc.account_id <> v_account
      and not a.archived and a.type::text <> 'PRESTAMO';

    if v_destino is not null then
      insert into public.transaction (
        user_id, type, amount_cents, description,
        occurred_on, occurred_time, occurred_at,
        account_id, to_account_id,
        source, status, merchant_raw, external_id, device_id
      )
      values (
        v_dev.user_id, 'TRANSFER', p_amount_cents,
        'Recarga de ' || (select a.name from public.account a where a.id = v_destino),
        v_local::date, v_local::time, v_when,
        v_account, v_destino,
        'SHORTCUT', 'CONFIRMED', v_merchant, v_ext, v_dev.id
      )
      returning id into v_id;

      return private.ingest_respuesta(v_id, false, false, p_amount_cents);
    end if;
  end if;

  -- 8) ¿El mismo pago, que ya entró por el OTRO camino? Mismo importe, ±15
  --    minutos, sin emparejar todavía. En la misma cuenta y uno solo: es él.
  with candidatos as (
    select t.id, t.account_id
    from public.transaction t
    where t.user_id = v_dev.user_id
      and t.source = 'SHORTCUT'
      and t.type = 'EXPENSE'
      and t.status <> 'DISCARDED'
      and t.amount_cents = p_amount_cents
      and t.occurred_at between v_when - interval '15 minutes' and v_when + interval '15 minutes'
      and (t.external_id like 'cartera\_%') = (v_origen = 'NFC')
      and not exists (
        select 1 from public.ingest_merged m
        where m.user_id = t.user_id and m.transaction_id = t.id)
  )
  select count(*) filter (where c.account_id = v_account),
         count(*),
         (array_agg(c.id) filter (where c.account_id = v_account))[1]
    into v_mismas, v_todas, v_gemelo
  from candidatos c;

  if v_mismas = 1 then
    insert into public.ingest_merged (user_id, external_id, transaction_id, transaction_type)
    values (v_dev.user_id, v_ext, v_gemelo, 'EXPENSE');
    return private.ingest_respuesta(v_gemelo, true, true, p_amount_cents);
  end if;

  if v_todas > 0 then
    v_nota := format(
      '¿Repetido? En esos minutos ya %s %s de %s por el otro atajo. Si era el mismo pago, borra uno de los dos.',
      case when v_todas = 1 then 'entró' else 'entraron' end,
      case when v_todas = 1 then 'un pago' else v_todas || ' pagos' end,
      private.euros(p_amount_cents));
  end if;

  -- 8b) El mismo aviso dos veces. Cartera avisa a veces dos veces de un mismo
  --     pago —en una gasolinera, la preautorización y el cargo—, y como cada
  --     aviso lleva su minuto, entraban los dos sin que nada lo señalara. No se
  --     funde ni se descarta: dos cafés seguidos son dos pagos. Si en los 10
  --     minutos anteriores entró otro AVISO con el mismo comercio, importe y
  --     cuenta, este entra PENDIENTE y con una nota que lo dice.
  if v_origen = 'CARTERA' and v_merchant is not null then
    select t.occurred_at
      into v_previo
    from public.transaction t
    where t.user_id = v_dev.user_id
      and t.source = 'SHORTCUT'
      and t.type = 'EXPENSE'
      and t.status <> 'DISCARDED'
      and t.external_id like 'cartera\_%'
      and t.account_id = v_account
      and t.amount_cents = p_amount_cents
      and t.occurred_at between v_when - interval '10 minutes' and v_when
      and private.nombre_normalizado(t.merchant_raw) = private.nombre_normalizado(v_merchant)
    order by t.occurred_at desc
    limit 1;

    if found then
      v_nota := concat_ws(' ', v_nota, format(
        '¿Repetido? %s entró otro aviso igual: %s en %s. Cartera a veces avisa dos veces del mismo pago (en gasolineras es habitual): si tu banco solo te cobró uno, borra este.',
        case when v_when - v_previo.occurred_at < interval '1 minute' then 'En el mismo minuto'
             else 'Hace ' || floor(extract(epoch from v_when - v_previo.occurred_at) / 60)::int || ' min' end,
        private.euros(p_amount_cents),
        v_merchant));
    end if;
  end if;

  if v_por_defecto then
    v_nota := concat_ws(' ', v_nota, format(
      'La tarjeta «%s» de Cartera no tiene cuenta: elígela en Ajustes → El Atajo del iPhone.',
      coalesce(v_tarjeta, 'sin nombre')));
  end if;

  -- 9) Motor de reglas.
  select m.category_id, m.category_type into v_cat, v_cat_type
  from private.match_rule(v_dev.user_id, v_merchant) m;

  -- 9b) Si ninguna regla acierta, se mira qué hiciste con este mismo comercio.
  --     Solo hereda si todo su historial coincide; con dos criterios distintos
  --     se queda pendiente y lo decides tú.
  if v_cat is null and v_merchant is not null then
    select i.category_id, i.category_type into v_cat, v_cat_type
    from private.infer_category(v_dev.user_id, v_merchant) i;

    v_heredada := v_cat is not null;
  end if;

  -- 10) Insertar. Con categoría —por regla o heredada— y sin nada que revisar
  --     entra confirmado; si no, espera en la bandeja de pendientes. Si la base
  --     lo rechaza por lo que sea (un CHECK nuevo, un dato raro), el pago queda
  --     en ingest_dead_letter con el código del error (DB_ERROR) en vez de
  --     perderse con un 500.
  begin
  insert into public.transaction (
    user_id, type, amount_cents, description,
    occurred_on, occurred_time, occurred_at,
    account_id, category_id, category_type,
    source, status, merchant_raw, card_last4, external_id, device_id, note
  )
  values (
    v_dev.user_id, 'EXPENSE', p_amount_cents, coalesce(v_merchant, 'Cargo'),
    v_local::date, v_local::time, v_when,
    v_account, v_cat, v_cat_type,
    'SHORTCUT',
    case when v_cat is null or v_nota is not null
         then 'PENDING'::public.tx_status else 'CONFIRMED'::public.tx_status end,
    v_merchant, v_card, v_ext, v_dev.id, v_nota
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

  return private.ingest_respuesta(v_id, v_dup, false, p_amount_cents)
         || jsonb_build_object('inherited', v_heredada);
end $$;

revoke all on function public.ingest_transaction(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_transaction(text, bigint, jsonb) to service_role;
