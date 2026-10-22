-- ===========================================================================
-- Cartera — esquema base
--
-- Dos ideas sostienen todo este fichero:
--
-- 1. NINGÚN SALDO SE ALMACENA. El saldo de una cuenta y el patrimonio neto se
--    derivan siempre de los movimientos. Una columna `balance` sería la fuente
--    garantizada de descuadres silenciosos, así que no existe y no debe crearse.
--
-- 2. TODAS LAS CLAVES FORÁNEAS SON COMPUESTAS CON user_id. Esto no es
--    decorativo: la seguridad a nivel de fila (RLS) NO protege las claves
--    foráneas, porque la comprobación de integridad referencial la ejecuta el
--    sistema con privilegios internos, no como el usuario. Sin la clave
--    compuesta, un usuario podría insertar un movimiento propio apuntando a una
--    categoría de otro, y la fila entraría: la política pasa (el user_id es el
--    suyo) y la FK simple pasa (la categoría existe). Con la clave compuesta el
--    INSERT falla con 23503. Es estructural, no una política que se pueda
--    olvidar.
-- ===========================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from anon, authenticated;

create type public.account_type as enum ('BANCO', 'EFECTIVO', 'AHORRO', 'INVERSION');
create type public.entry_type   as enum ('EXPENSE', 'INCOME', 'TRANSFER');
create type public.tx_source    as enum ('SHORTCUT', 'MANUAL', 'RECURRING');
create type public.tx_status    as enum ('PENDING', 'CONFIRMED', 'DISCARDED');
create type public.periodicity  as enum ('SEMANAL', 'MENSUAL', 'TRIMESTRAL', 'ANUAL');


-- ---------------------------------------------------------------------------
-- profile
-- ---------------------------------------------------------------------------
create table public.profile (
  user_id                   uuid primary key references auth.users(id) on delete cascade,
  display_name              text not null default '',
  -- Último mes que ya se mostró en el diálogo de cierre.
  last_shown_month          date,
  -- Cuenta a la que van los cargos del Atajo cuando la tarjeta no identifica
  -- ninguna. Si es NULL y no hay coincidencia por tarjeta, la ingesta rechaza
  -- el cargo en vez de adivinar.
  default_ingest_account_id uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint profile_last_shown_month_is_first_day
    check (last_shown_month is null or extract(day from last_shown_month) = 1)
);


-- ---------------------------------------------------------------------------
-- account — el saldo es derivado, aquí solo vive el punto de partida
-- ---------------------------------------------------------------------------
create table public.account (
  id                    uuid not null default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  name                  text not null,
  type                  public.account_type not null,
  -- Puede ser negativo: una tarjeta de crédito arranca en deuda.
  initial_balance_cents bigint not null default 0,
  color                 text not null default '#4a5568',
  -- Últimos 4 dígitos de la tarjeta asociada, para encaminar los cargos que
  -- manda el Atajo de iOS a la cuenta correcta.
  card_last4            text,
  archived              boolean not null default false,
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),        -- destino de las claves foráneas compuestas
  unique (user_id, id, type),  -- ídem, cuando además hay que fijar el tipo

  constraint account_name_len      check (length(btrim(name)) between 1 and 60),
  constraint account_color_hex     check (color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint account_card_last4    check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  constraint account_balance_range check (initial_balance_cents between -100000000000 and 100000000000),
  constraint account_archived_at   check (archived = (archived_at is not null))
);

-- Los nombres únicos van como índice y no como restricción: PostgreSQL no
-- admite expresiones dentro de un `unique (...)` de tabla.
create unique index account_name_uq
  on public.account (user_id, lower(btrim(name)));

create unique index account_card_last4_uq
  on public.account (user_id, card_last4) where card_last4 is not null;

alter table public.profile
  add constraint profile_default_ingest_account_fk
  foreign key (user_id, default_ingest_account_id)
  references public.account (user_id, id) on delete set null (default_ingest_account_id);


-- ---------------------------------------------------------------------------
-- category
--
-- No hay fila "Sin categoría": un movimiento sin clasificar tiene category_id
-- NULL y la interfaz lo pinta como «Sin categoría» con su candado. Así es
-- literalmente imposible borrarla, renombrarla o quedarse sin ella, y la app
-- arranca sin ningún dato sembrado.
-- ---------------------------------------------------------------------------
create table public.category (
  id         uuid not null default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  type       public.entry_type not null,
  color      text not null default '#4a5568',
  icon       text not null default 'circle-help',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),
  -- Este destino es el que garantiza a la vez que la categoría es del usuario
  -- Y que su tipo casa con el del movimiento. Dos invariantes, una sola clave.
  unique (user_id, id, type),

  constraint category_name_len  check (length(btrim(name)) between 1 and 40),
  constraint category_color_hex check (color ~ '^#[0-9A-Fa-f]{6}$')
);

create unique index category_name_uq
  on public.category (user_id, type, lower(btrim(name)));


-- ---------------------------------------------------------------------------
-- investment_position
--
-- Se llama así y no `position` porque POSITION es una palabra clave de SQL
-- (`POSITION(x IN y)`) y usarla como nombre de tabla invita a sorpresas.
-- ---------------------------------------------------------------------------
create table public.investment_position (
  id           uuid not null default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  account_id   uuid not null,
  account_type public.account_type not null default 'INVERSION',
  color        text not null default '#4a5568',
  since        date not null default current_date,
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),

  constraint position_name_len   check (length(btrim(name)) between 1 and 60),
  constraint position_color_hex  check (color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint position_is_invest  check (account_type = 'INVERSION'),

  -- Fijar el tipo en la clave tiene un efecto secundario deseable: no se puede
  -- cambiar el tipo de una cuenta de inversión mientras tenga posiciones.
  foreign key (user_id, account_id, account_type)
    references public.account (user_id, id, type) on delete restrict
);

create unique index position_name_uq
  on public.investment_position (user_id, lower(btrim(name)));


-- ---------------------------------------------------------------------------
-- subscription
-- ---------------------------------------------------------------------------
create table public.subscription (
  id                uuid not null default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  description       text not null,
  amount_cents      bigint not null,
  periodicity       public.periodicity not null,
  next_charge_date  date not null,
  category_id       uuid,
  category_type     public.entry_type,
  account_id        uuid not null,
  active            boolean not null default true,
  started_at        date not null default current_date,
  last_generated_on date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),

  constraint sub_desc_len         check (length(btrim(description)) between 1 and 60),
  constraint sub_amount_positive  check (amount_cents > 0),
  constraint sub_category_pair    check ((category_id is null) = (category_type is null)),
  constraint sub_category_expense check (category_type is null or category_type = 'EXPENSE'),
  constraint sub_next_after_start check (next_charge_date >= started_at),

  foreign key (user_id, account_id)
    references public.account (user_id, id) on delete restrict,
  foreign key (user_id, category_id, category_type)
    references public.category (user_id, id, type) on delete set null (category_id, category_type)
);


-- ---------------------------------------------------------------------------
-- transaction — el corazón
-- ---------------------------------------------------------------------------
create table public.transaction (
  id            uuid not null default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  type          public.entry_type not null,
  -- Siempre positivo: el signo lo da el tipo, nunca el importe.
  amount_cents  bigint not null,
  description   text not null default '',
  -- Fecha LOCAL (Europe/Madrid). Guardar la fecha ya resuelta es lo que evita
  -- que un cargo de las 00:30 del día 1 acabe contando en el mes anterior según
  -- la zona horaria del servidor.
  occurred_on   date not null,
  occurred_time time not null default '00:00',
  -- Instante original tal cual llegó, solo para auditoría de la ingesta.
  occurred_at   timestamptz,

  account_id    uuid not null,
  to_account_id uuid,
  category_id   uuid,
  -- Espejo de category.type. No es redundancia: es lo que permite que la clave
  -- foránea compuesta imponga que un gasto no cuelgue de una categoría de ingreso.
  category_type public.entry_type,
  note          text,

  reimburses_id          uuid,
  reimburses_target_type public.entry_type,

  source        public.tx_source not null default 'MANUAL',
  status        public.tx_status not null default 'CONFIRMED',

  merchant_raw    text,
  card_last4      text,
  external_id     text,
  device_id       uuid,
  subscription_id uuid,
  -- Aportación dirigida a una posición concreta. Sin esto no se puede calcular
  -- el rendimiento por posición descontando las aportaciones.
  position_id     uuid,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  period_month  date generated always as (date_trunc('month', occurred_on::timestamp)::date) stored,

  primary key (id),
  unique (user_id, id),
  unique (user_id, id, type),

  -- ── Invariantes de negocio ───────────────────────────────────────────────
  constraint tx_amount_positive check (amount_cents > 0 and amount_cents <= 100000000000),

  -- Un reembolso solo puede vivir en un INGRESO, y solo puede apuntar a un GASTO.
  constraint tx_reimburses_only_income check (reimburses_id is null or type = 'INCOME'),
  constraint tx_reimburses_pair        check ((reimburses_id is null) = (reimburses_target_type is null)),
  constraint tx_reimburses_target      check (reimburses_target_type is null or reimburses_target_type = 'EXPENSE'),
  constraint tx_no_self_reimburse      check (reimburses_id is distinct from id),

  -- Un traspaso siempre tiene destino, y nada más lo tiene. Y el destino no
  -- puede ser el origen.
  constraint tx_to_account_only_transfer check (
    (type = 'TRANSFER' and to_account_id is not null and to_account_id <> account_id)
    or (type <> 'TRANSFER' and to_account_id is null)),

  constraint tx_category_pair check ((category_id is null) = (category_type is null)),

  -- Higiene de la ingesta
  constraint tx_card_last4_fmt        check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  constraint tx_shortcut_has_external check (source <> 'SHORTCUT' or external_id is not null),
  constraint tx_pending_only_shortcut check (status <> 'PENDING' or source = 'SHORTCUT'),
  constraint tx_position_only_transfer check (position_id is null or type = 'TRANSFER'),
  constraint tx_date_sane             check (occurred_on between date '2000-01-01' and current_date + 400),

  -- ── Claves foráneas compuestas: imposible tocar filas de otro usuario ────
  foreign key (user_id, account_id)
    references public.account (user_id, id) on delete restrict,
  foreign key (user_id, to_account_id)
    references public.account (user_id, id) on delete restrict,
  foreign key (user_id, category_id, category_type)
    references public.category (user_id, id, type) on delete set null (category_id, category_type),
  -- Como reimburses_target_type está fijado a 'EXPENSE' por CHECK, esta clave
  -- hace imposible por construcción una cadena de reembolsos de reembolsos.
  foreign key (user_id, reimburses_id, reimburses_target_type)
    references public.transaction (user_id, id, type) on delete set null (reimburses_id, reimburses_target_type),
  foreign key (user_id, subscription_id)
    references public.subscription (user_id, id) on delete set null (subscription_id),
  foreign key (user_id, position_id)
    references public.investment_position (user_id, id) on delete set null (position_id)
);

-- PostgreSQL no indexa las claves foráneas por su cuenta.
create index tx_user_date_idx     on public.transaction (user_id, occurred_on desc, occurred_time desc);
create index tx_user_month_idx    on public.transaction (user_id, period_month, type);
create index tx_account_idx       on public.transaction (user_id, account_id, occurred_on);
create index tx_to_account_idx    on public.transaction (user_id, to_account_id) where to_account_id is not null;
create index tx_category_idx      on public.transaction (user_id, category_id) where category_id is not null;
create index tx_reimburses_idx    on public.transaction (user_id, reimburses_id) where reimburses_id is not null;
create index tx_unclassified_idx  on public.transaction (user_id, period_month) where category_id is null;
create index tx_pending_idx       on public.transaction (user_id) where status = 'PENDING';
create index tx_position_idx      on public.transaction (user_id, position_id) where position_id is not null;

-- Idempotencia de la ingesta: el disparador Wallet de iOS agota el tiempo de
-- espera y reintenta, así que los reenvíos son lo normal, no la excepción.
create unique index tx_external_id_uq
  on public.transaction (user_id, external_id) where external_id is not null;

-- Que un doble clic en «Generar pendientes» no cobre dos veces la suscripción.
create unique index tx_subscription_period_uq
  on public.transaction (user_id, subscription_id, occurred_on) where subscription_id is not null;


-- ---------------------------------------------------------------------------
-- merchant_rule — el motor de categorización automática
-- ---------------------------------------------------------------------------
create table public.merchant_rule (
  id            uuid not null default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  match_text    text not null,
  match_norm    text generated always as (lower(btrim(match_text))) stored,
  category_id   uuid not null,
  category_type public.entry_type not null,
  hit_count     integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),
  unique (user_id, match_norm),

  constraint rule_match_len    check (length(btrim(match_text)) between 2 and 60),
  constraint rule_not_transfer check (category_type <> 'TRANSFER'),

  foreign key (user_id, category_id, category_type)
    references public.category (user_id, id, type) on delete cascade
);

-- El desempate es por longitud: gana la regla más específica.
create index rule_user_len_idx on public.merchant_rule (user_id, length(match_norm) desc, created_at);


-- ---------------------------------------------------------------------------
-- budget — los límites nunca bloquean, solo avisan
-- ---------------------------------------------------------------------------
create table public.budget (
  id                      uuid not null default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  category_id             uuid not null,
  category_type           public.entry_type not null default 'EXPENSE',
  monthly_cap_cents       bigint not null,
  warn_at_80              boolean not null default true,
  discount_reimbursements boolean not null default true,
  rollover_unspent        boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),
  unique (user_id, category_id),

  constraint budget_cap_positive check (monthly_cap_cents > 0),
  -- Un ingreso o un traspaso no consumen tope.
  constraint budget_only_expense check (category_type = 'EXPENSE'),

  foreign key (user_id, category_id, category_type)
    references public.category (user_id, id, type) on delete cascade
);

-- El 80 % avisa una vez y el 100 % otra: la clave primaria ES el mecanismo
-- anti-repetición. Un INSERT ... ON CONFLICT DO NOTHING que devuelva fila
-- significa «avisa»; que no devuelva nada, «ya avisaste».
create table public.budget_alert (
  user_id      uuid not null references auth.users(id) on delete cascade,
  budget_id    uuid not null,
  period_month date not null,
  threshold    smallint not null,
  notified_at  timestamptz not null default now(),

  primary key (budget_id, period_month, threshold),
  constraint alert_threshold   check (threshold in (80, 100)),
  constraint alert_month_first check (extract(day from period_month) = 1),

  foreign key (user_id, budget_id) references public.budget (user_id, id) on delete cascade
);


-- ---------------------------------------------------------------------------
-- valuation — un registro con fecha; el porcentaje SIEMPRE se deriva
-- ---------------------------------------------------------------------------
create table public.valuation (
  id           uuid not null default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  position_id  uuid not null,
  date         date not null,
  value_cents  bigint not null,
  created_at   timestamptz not null default now(),
  period_month date generated always as (date_trunc('month', date::timestamp)::date) stored,

  primary key (id),
  unique (user_id, id),

  constraint valuation_non_negative check (value_cents >= 0),
  constraint valuation_not_future   check (date <= current_date),

  foreign key (user_id, position_id)
    references public.investment_position (user_id, id) on delete cascade
);

-- Se valora una vez al mes, a cierre.
create unique index valuation_one_per_month on public.valuation (position_id, period_month);
create index valuation_lookup_idx on public.valuation (user_id, position_id, date desc);


-- ---------------------------------------------------------------------------
-- Ingesta desde el Atajo de iOS
-- ---------------------------------------------------------------------------
create table public.ingest_device (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  -- Solo el hash. El token en claro se enseña una vez, al crearlo, y no se
  -- vuelve a poder recuperar.
  token_hash    bytea not null unique,
  token_prefix  text not null,
  created_at    timestamptz not null default now(),
  -- Permite avisar de «el atajo lleva 6 días callado».
  last_used_at  timestamptz,
  last_error_at timestamptz,
  request_count bigint not null default 0,
  revoked_at    timestamptz,

  constraint device_name_len check (length(btrim(name)) between 1 and 40)
);

create index ingest_device_user_idx on public.ingest_device (user_id) where revoked_at is null;

create table public.ingest_bucket (
  device_id    uuid not null references public.ingest_device(id) on delete cascade,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (device_id, window_start)
);

-- Nada se pierde en silencio: lo que la ingesta rechaza queda aquí.
create table public.ingest_dead_letter (
  id          bigserial primary key,
  device_id   uuid references public.ingest_device(id) on delete cascade,
  user_id     uuid,
  received_at timestamptz not null default now(),
  reason      text not null,
  payload     jsonb not null
);

create index ingest_dead_letter_user_idx on public.ingest_dead_letter (user_id, received_at desc);


-- ---------------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------------
create or replace function private.tg_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'profile', 'account', 'category', 'investment_position',
    'subscription', 'transaction', 'merchant_rule', 'budget'
  ] loop
    execute format(
      'create trigger %1$s_touch before update on public.%1$I
         for each row execute function private.tg_touch_updated_at()', t);
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- El tipo de una categoría es inmutable una vez creada.
-- Dos capas: privilegio de columna (PostgREST ni lo intenta) y disparador
-- (mensaje legible, y cubre las rutas SECURITY DEFINER).
-- ---------------------------------------------------------------------------
create or replace function private.tg_category_type_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.type is distinct from old.type then
    raise exception 'El tipo de una categoría no se puede cambiar una vez creada'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger category_type_immutable before update on public.category
  for each row execute function private.tg_category_type_immutable();
