-- ===========================================================================
-- Un cargo repetido hereda la categoría que le pusiste la vez anterior.
--
-- Hasta ahora solo clasificaban las reglas de comercio, que hay que crear a
-- mano. Un peaje que entra cada semana con el mismo nombre acababa en la
-- bandeja de pendientes una y otra vez, aunque ya lo hubieras clasificado.
--
-- LA REGLA NO ES «COPIA LA ANTERIOR», y eso es lo importante. Es «hereda solo
-- si TODO el historial de ese comercio coincide».
--
-- La diferencia la enseñan los datos reales:
--
--   Castellana De Autopist  · 2 veces · 1 categoría   → hereda
--   Aucalsa Tarjetas        · 2 veces · 1 categoría   → hereda
--   Riverland Festival      · 4 veces · 3 categorías  → NO adivina
--
-- En un festival se pagan copas, ropa y regalos en el mismo comercio. Copiar la
-- última categoría habría metido tres cargos mal clasificados sin avisar, y un
-- gasto en la categoría equivocada es peor que uno sin clasificar: el segundo se
-- ve en la bandeja, el primero descuadra un límite en silencio.
--
-- Con el historial dividido no se inventa nada: sigue esperando en pendientes,
-- que es donde una decisión que solo tú puedes tomar tiene que estar.
-- ===========================================================================

create or replace function private.infer_category(p_user uuid, p_merchant text)
returns table (category_id uuid, category_type public.entry_type)
language sql
stable
security definer
set search_path = ''
as $$
  with historial as (
    select t.category_id, t.category_type
    from public.transaction t
    where t.user_id = p_user
      and t.category_id is not null
      and t.status <> 'DISCARDED'
      and t.type = 'EXPENSE'
      -- Se compara el texto crudo del comercio, que es lo que manda el Atajo,
      -- normalizado en mayúsculas y espacios. Nada de coincidencias parciales:
      -- para eso están las reglas de comercio, que las decides tú.
      and t.merchant_raw is not null
      and lower(btrim(t.merchant_raw)) = lower(btrim(p_merchant))
  )
  select h.category_id, h.category_type
  from historial h
  group by h.category_id, h.category_type
  -- El corazón del asunto: este grupo tiene que ser TODO el historial. Si hay
  -- dos categorías distintas, ninguna cumple y no se devuelve nada.
  having count(*) = (select count(*) from historial)
  limit 1;
$$;

comment on function private.infer_category is
  'La categoría de un comercio, solo si todo su historial coincide. Con el historial dividido no devuelve nada: no se adivina.';


-- ---------------------------------------------------------------------------
-- Se enchufa en la ingesta, después de las reglas y solo si ninguna acertó.
--
-- El orden importa: una regla de comercio es una decisión explícita y manda
-- sobre lo que se deduce del historial. Si creas una regla para cambiar de
-- criterio, gana la regla.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_transaction(
  p_token        text,
  p_amount_cents bigint,
  p_payload      jsonb
)
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
  v_card     text := nullif(regexp_replace(coalesce(p_payload ->> 'card', ''), '\D', '', 'g'), '');
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

  -- 4) Fecha local: los meses deben cuadrar en Madrid, no en UTC.
  v_when  := coalesce((p_payload ->> 'occurred_at')::timestamptz, now());
  v_local := v_when at time zone 'Europe/Madrid';

  -- 5) ¿A qué cuenta va? Primero por la tarjeta; si no, la cuenta que el
  --    usuario haya designado en Ajustes. Nunca se adivina: si no hay ninguna,
  --    se rechaza y queda registrado para poder recuperarlo después.
  select a.id into v_account
  from public.account a
  where a.user_id = v_dev.user_id and a.card_last4 = v_card and not a.archived
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
  --    espera en la bandeja de pendientes.
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
end $$;


-- ---------------------------------------------------------------------------
-- Y se aplica a lo que ya está esperando en la bandeja.
--
-- Los pendientes que hoy tienen un hermano de nombre idéntico y una sola
-- categoría en su historial se clasifican solos. Es la misma regla mirando
-- hacia atrás: si no se hiciera, seguirían ahí sin motivo.
-- ---------------------------------------------------------------------------
-- El cálculo va en una CTE y no en el `from` del update: PostgreSQL no deja
-- pasarle a una función columnas de la tabla que se está actualizando.
with candidatos as (
  select t.id, i.category_id, i.category_type
  from public.transaction t
  cross join lateral private.infer_category(t.user_id, t.merchant_raw) i
  where t.status = 'PENDING'
    and t.category_id is null
    and t.merchant_raw is not null
)
update public.transaction t
   set category_id   = c.category_id,
       category_type = c.category_type,
       status        = 'CONFIRMED'
  from candidatos c
 where c.id = t.id;
