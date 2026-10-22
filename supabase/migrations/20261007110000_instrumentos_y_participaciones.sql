-- ===========================================================================
-- Inversiones que se actualizan solas (1/2): instrumentos, precios y
-- participaciones.
--
-- Hasta ahora una posición valía lo que dijera la última valoración tecleada a
-- mano. Esta migración pone los cimientos para que una posición pueda SEGUIR un
-- instrumento de mercado (fondo, ETF o acción) y valga participaciones × precio
-- del día. El cálculo vive en la migración siguiente
-- (20261007110100_valor_de_mercado_de_las_posiciones.sql); aquí solo hay datos.
--
-- ── DOS CLASES DE DATOS ────────────────────────────────────────────────────
--
--   · COMPARTIDOS (no son de nadie): el catálogo de instrumentos, sus precios
--     diarios y los tipos de cambio del BCE. Son datos públicos de mercado: que
--     un fondo cerró a 14,6592 € el lunes es lo mismo para los cuatro usuarios.
--     No llevan user_id. Los LEE cualquier sesión autenticada con 2FA y los
--     ESCRIBE solo el servidor con service_role (tras validar el símbolo contra
--     Yahoo). Ningún usuario puede insertar, cambiar ni borrar un precio: si
--     pudiera, movería el patrimonio de los demás.
--
--   · DE CADA USUARIO: el libro de participaciones de cada posición
--     (position_unit_event) y las participaciones de cada aportación
--     (transaction.position_units). Con user_id, RLS y claves foráneas
--     compuestas, como todo lo demás (invariante 5).
--
--   La clave foránea de un evento al instrumento NO es compuesta con user_id, y
--   no tiene que serlo: el instrumento no pertenece a nadie, así que apuntar a
--   él no puede filtrar ni tocar datos de otro usuario.
--
-- ── NADA DE «PARTICIPACIONES ACTUALES» GUARDADAS ───────────────────────────
--
-- No hay una columna que diga cuántas participaciones tienes hoy y se vaya
-- pisando: se DERIVAN (invariante 2, aplicado a las participaciones). El libro
-- solo anota hechos con fecha, y nunca se edita ni se borra:
--
--   ALTA    empiezas a seguir un instrumento: cuál, cuántas participaciones
--           tenías ese día y cuánto llevabas aportado en total.
--   AJUSTE  «MyInvestor dice que tengo X participaciones a fecha D». Es un
--           nuevo punto de partida, como una valoración lo es para el valor.
--   BAJA    dejas de seguirlo: la posición vuelve a valorarse a mano.
--
-- y cada aportación (traspaso a la posición) puede traer sus participaciones.
-- Las participaciones en una fecha son las del último ALTA o AJUSTE más las de
-- las aportaciones posteriores. Un error se corrige con otro AJUSTE, no
-- reescribiendo el pasado: el libro entero es la auditoría.
--
-- Unidades y precios son `numeric` exacto, nunca coma flotante: participaciones
-- con 8 decimales, precios con 6, tipos de cambio con 8. Los importes, como
-- siempre, enteros en céntimos (invariante 1).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Catálogo de instrumentos (compartido).
-- ---------------------------------------------------------------------------
create type public.instrument_kind as enum ('FONDO', 'ETF', 'ACCION');

create table public.instrument (
  id           uuid not null default gen_random_uuid() primary key,
  kind         public.instrument_kind not null,
  -- El ISIN identifica el producto, no la cotización: el mismo fondo cotiza en
  -- Fráncfort y en Stuttgart con símbolos distintos. Por eso no es único, y es
  -- opcional (de una acción no siempre se conoce).
  isin         text,
  -- Lo que se le pide a Yahoo. Este sí es único: una fila por cotización.
  yahoo_symbol text not null unique,
  name         text not null,
  -- Divisa en la que Yahoo da el precio, ya normalizada (los peniques de
  -- Londres, «GBp», se guardan como GBP con el precio dividido entre 100).
  currency     text not null,
  exchange     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint instrument_symbol_fmt   check (yahoo_symbol ~ '^[A-Za-z0-9.^=-]{1,32}$'),
  constraint instrument_isin_fmt     check (isin is null or isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  constraint instrument_name_len     check (length(btrim(name)) between 1 and 200),
  constraint instrument_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint instrument_exchange_len check (exchange is null or length(exchange) <= 60)
);

create index instrument_isin_idx on public.instrument (isin) where isin is not null;

create trigger instrument_touch before update on public.instrument
  for each row execute function private.tg_touch_updated_at();

comment on table public.instrument is
  'Catálogo COMPARTIDO de instrumentos de mercado (fondo, ETF, acción). Dato público, sin user_id: lo leen los usuarios autenticados y lo escribe solo el servidor (service_role) tras validar el símbolo contra Yahoo.';


-- ---------------------------------------------------------------------------
-- Precio de cierre de cada instrumento cada día (compartido).
--
-- Yahoo da los cierres en coma flotante (14.659199714660645); el servidor los
-- normaliza a 6 decimales exactos ANTES de guardarlos. Aquí no entra un float.
-- La fecha es el día de mercado en la zona horaria de la bolsa. Puede llegar a
-- ser «mañana» respecto a la base (que va en UTC) en una bolsa asiática; por
-- eso el tope es current_date + 1 y no current_date.
-- ---------------------------------------------------------------------------
create table public.instrument_price (
  instrument_id uuid not null references public.instrument (id) on delete cascade,
  date          date not null,
  close         numeric(20, 6) not null,
  source        text not null default 'YAHOO',
  fetched_at    timestamptz not null default now(),

  primary key (instrument_id, date),

  constraint instrument_price_positive check (close > 0),
  constraint instrument_price_source   check (source in ('YAHOO')),
  constraint instrument_price_date     check (date between date '1970-01-01' and current_date + 1)
);

comment on table public.instrument_price is
  'Cierre diario de cada instrumento (numeric exacto, 6 decimales), en su divisa. Compartido; escribe solo service_role. La clave (instrument_id, date) hace idempotente la descarga: se actualiza con upsert.';


-- ---------------------------------------------------------------------------
-- Tipo de cambio de referencia del BCE (compartido).
--
-- `rate` son unidades de la divisa por 1 EUR, que es como lo publica el BCE
-- (USD 1,1269 = un euro vale 1,1269 dólares). Así, un precio en dólares pasa a
-- euros DIVIDIENDO entre `rate`. El euro no tiene fila: vale 1.
-- ---------------------------------------------------------------------------
create table public.fx_rate (
  currency   text not null,
  date       date not null,
  rate       numeric(20, 8) not null,
  source     text not null default 'BCE',
  fetched_at timestamptz not null default now(),

  primary key (currency, date),

  constraint fx_rate_currency_fmt check (currency ~ '^[A-Z]{3}$' and currency <> 'EUR'),
  constraint fx_rate_positive     check (rate > 0),
  constraint fx_rate_source       check (source in ('BCE')),
  constraint fx_rate_date         check (date between date '1999-01-01' and current_date + 1)
);

comment on table public.fx_rate is
  'Tipo de cambio de referencia del BCE: unidades de `currency` por 1 EUR. Compartido; escribe solo service_role.';


-- ---------------------------------------------------------------------------
-- Libro de participaciones de cada posición (del usuario).
--
-- `seq` ordena los eventos del mismo día de forma determinista: el último
-- insertado manda. No se usa created_at porque dos filas de la misma
-- transacción comparten now().
-- ---------------------------------------------------------------------------
create type public.position_event_kind as enum ('ALTA', 'AJUSTE', 'BAJA');

create table public.position_unit_event (
  id                uuid not null default gen_random_uuid(),
  seq               bigint generated always as identity,
  user_id           uuid not null references auth.users (id) on delete cascade,
  position_id       uuid not null,
  kind              public.position_event_kind not null,
  date              date not null,
  -- Solo en el ALTA: qué se sigue.
  instrument_id     uuid references public.instrument (id) on delete restrict,
  -- ALTA: participaciones que se tenían ese día. AJUSTE: las que dice el
  -- bróker ese día (el total, no la diferencia). BAJA: nada.
  units             numeric(24, 8),
  -- Solo en el ALTA: total aportado hasta ese día, el «importe invertido» del
  -- bróker. Es el coste con el que se compara el valor para dar la ganancia.
  contributed_cents bigint,
  note              text,
  created_at        timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),

  constraint unit_event_alta check (
    kind <> 'ALTA'
    or (instrument_id is not null and units is not null and units > 0
        and contributed_cents is not null and contributed_cents >= 0)),
  constraint unit_event_ajuste check (
    kind <> 'AJUSTE'
    or (instrument_id is null and units is not null and units >= 0 and contributed_cents is null)),
  constraint unit_event_baja check (
    kind <> 'BAJA'
    or (instrument_id is null and units is null and contributed_cents is null)),
  constraint unit_event_contributed_max check (
    contributed_cents is null or contributed_cents <= 100000000000),
  constraint unit_event_date check (date between date '2000-01-01' and current_date),
  constraint unit_event_note_len check (note is null or length(note) <= 200),

  foreign key (user_id, position_id)
    references public.investment_position (user_id, id) on delete cascade
);

create index unit_event_lookup_idx
  on public.position_unit_event (user_id, position_id, date desc, seq desc);
create index unit_event_instrument_idx
  on public.position_unit_event (instrument_id) where instrument_id is not null;

comment on table public.position_unit_event is
  'Libro de participaciones de cada posición: ALTA (empieza a seguir un instrumento), AJUSTE (participaciones según el bróker) y BAJA (vuelve a manual). Solo se añade: ni se edita ni se borra. Las participaciones actuales se derivan.';


-- ---------------------------------------------------------------------------
-- Coherencia del libro, en la base y no en un `if` de la app.
--
-- Un AJUSTE o una BAJA solo tienen sentido mientras la posición sigue un
-- instrumento en esa fecha. El periodo vigente en una fecha es el del último
-- ALTA o BAJA con fecha <= ella (a igual fecha, el último insertado).
--
-- Corre con los permisos de quien inserta (security invoker): la RLS limita la
-- consulta a los eventos propios, que son los únicos que importan aquí.
-- ---------------------------------------------------------------------------
create or replace function private.tg_unit_event_coherente()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_vigente public.position_event_kind;
begin
  if new.kind in ('AJUSTE', 'BAJA') then
    select e.kind into v_vigente
    from public.position_unit_event e
    where e.user_id = new.user_id
      and e.position_id = new.position_id
      and e.kind in ('ALTA', 'BAJA')
      and e.date <= new.date
    order by e.date desc, e.seq desc
    limit 1;

    if v_vigente is distinct from 'ALTA' then
      raise exception 'Esa posición no sigue ningún instrumento en esa fecha'
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger unit_event_coherente before insert on public.position_unit_event
  for each row execute function private.tg_unit_event_coherente();

revoke all on function private.tg_unit_event_coherente() from public, anon;


-- ---------------------------------------------------------------------------
-- Participaciones de cada aportación.
--
-- Una aportación es un traspaso con position_id (ver v_position_contributions).
-- Si el usuario sabe cuántas participaciones compró, se anotan aquí; si no, el
-- cálculo las estima con el precio de esa fecha (y lo marca como estimación).
-- Vive en el propio movimiento y no en una tabla aparte para que viaje con él:
-- si el movimiento se descarta, se borra o cambia de posición, sus
-- participaciones no se quedan huérfanas apuntando a la posición equivocada.
-- ---------------------------------------------------------------------------
alter table public.transaction
  add column position_units numeric(24, 8);

alter table public.transaction
  add constraint tx_units_only_position
    check (position_units is null or (position_id is not null and position_units > 0));

comment on column public.transaction.position_units is
  'Participaciones compradas con esta aportación (traspaso a una posición). NULL: se estiman con el precio de la fecha.';


-- ---------------------------------------------------------------------------
-- Seguridad a nivel de fila.
-- ---------------------------------------------------------------------------

-- Los compartidos: lectura para cualquier sesión autenticada CON 2FA (la misma
-- regla que el resto de tablas, vía private.current_user_id(), que es NULL sin
-- aal2); escritura para nadie salvo service_role, que se salta la RLS.
do $$
declare t text;
begin
  foreach t in array array['instrument', 'instrument_price', 'fx_rate'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
    execute format($p$
      create policy %1$s_sel on public.%1$I for select to authenticated
        using ((select private.current_user_id()) is not null)$p$, t);
  end loop;
end $$;

-- El libro: el usuario lee y añade lo suyo. No hay política de UPDATE ni de
-- DELETE, y además se retira el privilegio: el libro solo crece. (Al borrar la
-- posición con delete_account, sus eventos caen en cascada con ella.)
alter table public.position_unit_event enable row level security;
alter table public.position_unit_event force row level security;
revoke all on table public.position_unit_event from public, anon, authenticated;
grant select, insert on table public.position_unit_event to authenticated;
grant select, insert, update, delete on table public.position_unit_event to service_role;

create policy position_unit_event_sel on public.position_unit_event for select to authenticated
  using (user_id = (select private.current_user_id()));
create policy position_unit_event_ins on public.position_unit_event for insert to authenticated
  with check (user_id = (select private.current_user_id()));
