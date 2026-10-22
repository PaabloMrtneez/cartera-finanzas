-- ===========================================================================
-- Varias tarjetas por cuenta.
--
-- Hasta ahora una cuenta tenía como mucho UN último4 (`account.card_last4`), y
-- el Atajo encaminaba cada pago casando esos cuatro dígitos contra la cuenta.
-- En la vida real una misma cuenta tiene varias tarjetas —la física, la de
-- Apple Pay, una desechable para sitios dudosos— y cada una con sus propios
-- cuatro dígitos.
--
-- La tarjeta es SOLO UNA ETIQUETA. No hay modelo de crédito ni de pasivo: todas
-- las tarjetas de una cuenta gastan del saldo de esa cuenta. El `type`
-- (débito/crédito/prepago) es informativo, para verlas; el trabajo de verdad lo
-- hace `last4`, que es lo que el Atajo usa para enrutar el pago a su cuenta.
--
-- Esta migración es ADITIVA: NO toca `account.card_last4` ni `v_account_balance`.
-- La columna vieja se retirará en una limpieza posterior, cuando la interfaz ya
-- no la lea. De momento conviven: el backfill siembra `card` a partir de ella y
-- la ingesta pasa a resolver la cuenta por `card`.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- El tipo de tarjeta. Etiqueta, no comportamiento: ninguna de las tres cambia
-- de dónde sale el dinero.
-- ---------------------------------------------------------------------------
create type public.card_type as enum ('DEBITO', 'CREDITO', 'PREPAGO');


-- ---------------------------------------------------------------------------
-- card — una tarjeta es un último4 con nombre, colgado de una cuenta.
--
-- Sigue las convenciones del esquema base (ver 20260815090000_schema.sql):
--   · user_id apunta a auth.users, igual que account.
--   · unique (user_id, id) para poder ser destino de claves foráneas compuestas.
--   · La FK a account es COMPUESTA con user_id (invariante 5): la RLS no protege
--     las claves foráneas, así que sin la clave compuesta un usuario podría
--     colgar una tarjeta suya de la cuenta de otro y la fila entraría.
--   · unique (user_id, last4): un último4 pertenece a una sola tarjeta por
--     usuario. Es lo que hace determinista el enrutado del Atajo.
-- ---------------------------------------------------------------------------
create table public.card (
  id         uuid not null default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null,
  last4      text not null,
  type       public.card_type not null default 'DEBITO',
  -- Alias para distinguir tarjetas de un vistazo: «física», «Apple Pay»,
  -- «desechable sitios no seguros»… Opcional.
  nickname   text,
  created_at timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),            -- destino de futuras claves foráneas compuestas
  unique (user_id, last4),         -- un último4 = una tarjeta; lo exige el enrutado

  constraint card_last4_fmt     check (last4 ~ '^[0-9]{4}$'),
  constraint card_nickname_len  check (nickname is null or length(btrim(nickname)) between 1 and 40),

  -- Clave foránea COMPUESTA con user_id. Si se borra la cuenta, caen sus tarjetas.
  foreign key (user_id, account_id)
    references public.account (user_id, id) on delete cascade
);

-- PostgreSQL no indexa las claves foráneas por su cuenta; este índice acelera la
-- cascada al borrar una cuenta y el listado de tarjetas por cuenta.
create index card_account_idx on public.card (user_id, account_id);

comment on table public.card is
  'Tarjetas de una cuenta. Etiqueta, no crédito: todas gastan del saldo de su cuenta. last4 enruta los pagos del Atajo.';


-- ---------------------------------------------------------------------------
-- Seguridad a nivel de fila: las cuatro políticas, igual que las demás tablas
-- del usuario. La tarjeta SÍ se borra desde el cliente (a diferencia de las
-- cuentas, que se archivan): conserva su política de borrado.
-- ---------------------------------------------------------------------------
alter table public.card enable row level security;
alter table public.card force row level security;   -- aplica también al dueño de la tabla
revoke all on table public.card from anon;

create policy card_sel on public.card for select to authenticated
  using (user_id = (select private.current_user_id()));
create policy card_ins on public.card for insert to authenticated
  with check (user_id = (select private.current_user_id()));
create policy card_upd on public.card for update to authenticated
  using (user_id = (select private.current_user_id()))
  with check (user_id = (select private.current_user_id()));
create policy card_del on public.card for delete to authenticated
  using (user_id = (select private.current_user_id()));

-- Reasignar una fila a otro usuario no es nunca legítimo (además del WITH CHECK).
revoke update (user_id) on public.card from authenticated;


-- ---------------------------------------------------------------------------
-- Backfill: por cada cuenta con un último4, una tarjeta de débito.
--
-- El tipo por defecto es DEBITO porque es lo que había: la columna vieja no
-- distinguía tipos. Si alguna era de crédito, se corrige a mano después.
-- El unique (user_id, last4) no da guerra: account.card_last4 ya era único por
-- usuario (account_card_last4_uq), así que no hay dos cuentas con el mismo.
-- ---------------------------------------------------------------------------
insert into public.card (user_id, account_id, last4, type)
select a.user_id, a.id, a.card_last4, 'DEBITO'
from public.account a
where a.card_last4 is not null;


-- ---------------------------------------------------------------------------
-- La ingesta pasa a resolver la cuenta por `card`, no por `account.card_last4`.
--
-- Es copia LITERAL de la función vigente (20260827090000_heredar_categoria.sql):
-- lo único que cambia es el paso 5, la resolución de la cuenta. Todo lo demás
-- —autenticación por hash, límite de 60/10 min por dispositivo, validación del
-- importe, idempotencia por external_id, motor de reglas, herencia de categoría,
-- registro de rechazos y objeto de respuesta— se mantiene byte a byte. En una
-- función `security definer` que mueve dinero, partir del texto vigente y tocar
-- solo lo imprescindible es la única forma sensata.
--
-- Antes: casaba v_card contra account.card_last4 (una tarjeta por cuenta).
-- Ahora: casa v_card contra card.last4 y sube a su account_id. Como
-- (user_id, last4) es único, la resolución sigue siendo determinista, y dos
-- tarjetas de la MISMA cuenta encaminan ambas a esa cuenta. Se conserva el
-- filtro `not a.archived`: una tarjeta de una cuenta archivada no enruta.
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
