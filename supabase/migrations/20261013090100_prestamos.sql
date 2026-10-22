-- ===========================================================================
-- Préstamos personales: cuadro francés, cuotas que se cobran solas y la deuda
-- en el patrimonio.
--
-- ── EL MODELO ──────────────────────────────────────────────────────────────
-- Cada préstamo tiene su propia cuenta-PASIVO (tipo PRESTAMO, ver
-- 20261013090000_tipo_de_cuenta_prestamo.sql) cuyo saldo es NEGATIVO y vale lo
-- que se debe. Todo lo demás son movimientos normales, enlazados al préstamo
-- (`transaction.loan_id` + `loan_period` + `loan_part`):
--
--   · DESEMBOLSO   traspaso cuenta-pasivo → cuenta de pago, por el principal.
--                  La deuda pasa a −P y el banco sube P: el patrimonio NO cambia.
--   · COMISION     gasto en la cuenta de pago (la comisión de apertura).
--   · INTERESES    gasto en la cuenta de pago, cada cuota (categoría «Intereses»).
--   · CAPITAL      traspaso cuenta de pago → cuenta-pasivo, cada cuota. Baja la
--                  deuda y baja el banco: no es gasto (invariante 3).
--   · LIQUIDACION  traspaso del pendiente al liquidar antes de tiempo.
--   · COMISION_CANCELACION  gasto, si la cancelación anticipada la cobra.
--
-- Por construcción: el saldo de la cuenta-pasivo se DERIVA de los movimientos
-- (invariante 2: no hay columna de saldo ni de pendiente); el gasto, el
-- ingreso, el reparto y los límites solo ven intereses y comisiones, porque
-- `v_transaction_econ` ya excluye los traspasos (invariante 3); y el
-- patrimonio refleja la deuda sin tocar nada más.
--
-- «YA LO TENÍA APUNTADO». Un préstamo que ya existía no mueve dinero: la deuda
-- arranca como SALDO INICIAL negativo de la cuenta-pasivo, igual al capital
-- pendiente según el cuadro a la fecha de alta, y la app solo genera las
-- cuotas con fecha POSTERIOR al alta (lo de hasta hoy ya está en tus cuentas).
-- Es la misma convención que cualquier cuenta con saldo inicial; no hace falta
-- una contrapartida que altere otras cuentas. Sin comisión.
--
-- ── EL CUADRO ES DERIVADO ──────────────────────────────────────────────────
-- `loan_plan` lo calcula entero desde las condiciones, en enteros exactos
-- (`numeric`), y `src/lib/prestamos.ts` hace exactamente lo mismo en BigInt
-- para la vista previa: scripts/test-prestamos.mjs los compara al céntimo.
--   cuota       = redondeo(P·T·(D+T)ⁿ / (D·((D+T)ⁿ − Dⁿ)))   (T: TIN en
--                 diezmilésimas de punto; D = 12·100·10⁴; T = 0 → P/n)
--   intereses_k = redondeo(pendiente_k · T / D)
--   capital_k   = cuota − intereses_k; la ÚLTIMA paga todo el pendiente.
--   redondeo(a/b) = ⌊(2a + b) / 2b⌋: mitad hacia arriba.
--
-- ── SE COBRA SOLO ──────────────────────────────────────────────────────────
-- `private.loan_generate` crea las cuotas vencidas (fecha ≤ hoy en Madrid) que
-- falten, en orden, y marca el préstamo LIQUIDADO con la última. Es idempotente
-- por dos vías: la marca `last_generated_period` (como `next_charge_date` en
-- las suscripciones: una cuota que borres a mano no vuelve) y los índices
-- únicos por (préstamo, periodo, parte). La llaman:
--   · `generate_loan_installments()` — el usuario (aal2), solo lo suyo.
--   · `generate_loan_installments_all()` — SOLO service_role, desde el cron de
--     /api/notificar (cada dos horas). Es `security invoker`: service_role se
--     salta la RLS por ser BYPASSRLS, así que no hace falta `security definer`,
--     y como ni `authenticated` ni `anon` tienen EXECUTE, una sesión normal no
--     puede usarla para escribir en préstamos de otro.
--
-- Todo es `security invoker`: la RLS de cada tabla se aplica a cada sentencia,
-- así que ninguna de estas funciones puede tocar una fila de otro usuario
-- aunque el filtro explícito por user_id fallara.
--
-- ── POR QUÉ `type::text = 'PRESTAMO'` ──────────────────────────────────────
-- En las vistas, las funciones SQL y los CHECK se compara el tipo de cuenta
-- como TEXTO. Un literal de enum se valida al crear el objeto, y Postgres no
-- deja usar un valor de enum añadido en la misma transacción; comparando como
-- texto, esta migración puede aplicarse —y probarse dentro de una transacción
-- que se deshace— junto a la que añade el valor. Las funciones plpgsql usan el
-- literal sin más: se valida al ejecutarlas, no al crearlas.
-- ===========================================================================


-- service_role (el cron) llama a public.generate_loan_installments_all, que es
-- security invoker y usa las funciones de `private` de abajo: necesita USO del
-- esquema. No le abre nada que no tuviera: service_role ya se salta la RLS, y
-- cada función de `private` sigue necesitando su EXECUTE explícito.
grant usage on schema private to service_role;


-- ---------------------------------------------------------------------------
-- loan
-- ---------------------------------------------------------------------------
create table public.loan (
  id                     uuid not null default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  name                   text not null,
  -- Desde dónde se paga (y adónde entra el dinero si se desembolsa).
  payment_account_id     uuid not null,
  -- La cuenta-pasivo. El tipo va en la clave para fijarlo a PRESTAMO.
  liability_account_id   uuid not null,
  liability_account_type public.account_type not null,
  principal_cents        bigint not null,
  term_months            smallint not null,
  -- TIN y TAE anuales en %, decimales exactos. La TAE es la del contrato, si
  -- el usuario la mete; si no, v_loan_status enseña la calculada.
  tin_pct                numeric(7,4) not null,
  tae_pct                numeric(7,4),
  opening_fee_cents      bigint not null default 0,
  charge_day             smallint not null default 1,
  -- Fecha del desembolso (o de la firma, si ya existía).
  start_on               date not null,
  first_charge_on        date not null,
  -- true: «el dinero entra ahora» (hay movimiento de desembolso).
  -- false: «ya lo tenía apuntado» (la deuda es el saldo inicial de la cuenta).
  disbursed              boolean not null,
  -- Primera cuota que genera la app (1 si se desembolsa ahora).
  tracked_from_period    smallint not null default 1,
  -- Última cuota generada (o pagada antes del alta). Marca de agua: la
  -- generación sigue desde aquí, como `next_charge_date` en suscripciones.
  last_generated_period  smallint not null default 0,
  -- Última cuota de la que ya se avisó (push).
  notified_period        smallint not null default 0,
  interest_category_id   uuid,
  interest_category_type public.entry_type,
  status                 text not null default 'ACTIVO',
  closed_on              date,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),
  -- Una cuenta-pasivo por préstamo.
  unique (user_id, liability_account_id),

  constraint loan_name_len            check (length(btrim(name)) between 1 and 40),
  constraint loan_principal_range     check (principal_cents between 10000 and 1000000000),
  constraint loan_term_range          check (term_months between 1 and 480),
  constraint loan_tin_range           check (tin_pct between 0 and 50),
  constraint loan_tae_range           check (tae_pct is null or tae_pct between 0 and 100),
  constraint loan_fee_range           check (opening_fee_cents >= 0 and opening_fee_cents < principal_cents),
  constraint loan_fee_only_disbursed  check (disbursed or opening_fee_cents = 0),
  constraint loan_charge_day_range    check (charge_day between 1 and 28),
  constraint loan_first_after_start   check (first_charge_on > start_on),
  constraint loan_first_on_charge_day check (extract(day from first_charge_on) = charge_day),
  constraint loan_start_sane          check (start_on >= date '2000-01-01'),
  constraint loan_tracked_range       check (tracked_from_period between 1 and term_months),
  constraint loan_generated_range     check (last_generated_period between tracked_from_period - 1 and term_months),
  constraint loan_notified_range      check (notified_period between 0 and last_generated_period),
  constraint loan_status_valid        check (status in ('ACTIVO', 'LIQUIDADO', 'CANCELADO')),
  constraint loan_closed_pair         check ((status = 'ACTIVO') = (closed_on is null)),
  constraint loan_category_pair       check ((interest_category_id is null) = (interest_category_type is null)),
  constraint loan_category_expense    check (interest_category_type is null or interest_category_type = 'EXPENSE'),
  constraint loan_liability_type      check (liability_account_type::text = 'PRESTAMO'),
  constraint loan_accounts_distinct   check (payment_account_id <> liability_account_id),

  -- Claves compuestas con user_id (invariante 5): un préstamo no puede apuntar
  -- a la cuenta o a la categoría de otro usuario.
  constraint loan_payment_account_fk
    foreign key (user_id, payment_account_id)
    references public.account (user_id, id) on delete restrict,
  -- Fijar el tipo en la clave impide además cambiarle el tipo a la cuenta-pasivo.
  constraint loan_liability_account_fk
    foreign key (user_id, liability_account_id, liability_account_type)
    references public.account (user_id, id, type) on delete restrict,
  constraint loan_interest_category_fk
    foreign key (user_id, interest_category_id, interest_category_type)
    references public.category (user_id, id, type)
    on delete set null (interest_category_id, interest_category_type)
);

create index loan_payment_account_idx on public.loan (user_id, payment_account_id);
create index loan_active_idx on public.loan (user_id) where status = 'ACTIVO';

create trigger loan_touch before update on public.loan
  for each row execute function private.tg_touch_updated_at();

comment on table public.loan is
  'Préstamo personal (sistema francés). Nada de saldos: el pendiente es −saldo de la cuenta-pasivo (v_loan_status) y el cuadro se deriva con loan_plan.';


-- ---------------------------------------------------------------------------
-- Las condiciones financieras no cambian una vez cobrada alguna cuota: el
-- cuadro de lo ya cobrado dejaría de cuadrar con los movimientos. Va en un
-- disparador para que valga también para un UPDATE directo por PostgREST.
-- ---------------------------------------------------------------------------
create or replace function private.tg_loan_terms_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.last_generated_period >= old.tracked_from_period
     and (new.principal_cents, new.term_months, new.tin_pct, new.opening_fee_cents,
          new.charge_day, new.start_on, new.first_charge_on, new.disbursed,
          new.tracked_from_period, new.payment_account_id, new.liability_account_id)
         is distinct from
         (old.principal_cents, old.term_months, old.tin_pct, old.opening_fee_cents,
          old.charge_day, old.start_on, old.first_charge_on, old.disbursed,
          old.tracked_from_period, old.payment_account_id, old.liability_account_id)
  then
    raise exception 'Este préstamo ya tiene cuotas cobradas: sus condiciones no se pueden cambiar'
      using errcode = '23514';
  end if;
  return new;
end $$;

revoke all on function private.tg_loan_terms_immutable() from public, anon;

create trigger loan_terms_immutable before update on public.loan
  for each row execute function private.tg_loan_terms_immutable();


-- ---------------------------------------------------------------------------
-- Seguridad a nivel de fila: las de siempre, y el borrado cerrado salvo dentro
-- de delete_loan (mismo mecanismo que account con `cartera.cuenta_a_borrar`).
-- ---------------------------------------------------------------------------
alter table public.loan enable row level security;
alter table public.loan force row level security;
revoke all on table public.loan from anon;

create policy loan_sel on public.loan for select to authenticated
  using (user_id = (select private.current_user_id()));
create policy loan_ins on public.loan for insert to authenticated
  with check (user_id = (select private.current_user_id()));
create policy loan_upd on public.loan for update to authenticated
  using (user_id = (select private.current_user_id()))
  with check (user_id = (select private.current_user_id()));
create policy loan_del on public.loan for delete to authenticated
  using (
    user_id = (select private.current_user_id())
    and id::text = (select current_setting('cartera.prestamo_a_borrar', true))
  );

revoke update (user_id) on public.loan from authenticated;


-- ---------------------------------------------------------------------------
-- El enlace en `transaction`.
-- ---------------------------------------------------------------------------
alter table public.transaction
  add column loan_id     uuid,
  add column loan_period smallint,
  add column loan_part   text;

alter table public.transaction
  add constraint tx_loan_part_valid check (
    loan_part is null or loan_part in
      ('DESEMBOLSO', 'COMISION', 'INTERESES', 'CAPITAL', 'LIQUIDACION', 'COMISION_CANCELACION')),
  add constraint tx_loan_pair check ((loan_id is null) = (loan_part is null)),
  -- Solo las dos partes de una cuota llevan número de cuota, y lo llevan siempre.
  add constraint tx_loan_period_cuota check (
    case when loan_part in ('INTERESES', 'CAPITAL')
         then loan_period is not null and loan_period >= 1
         else loan_period is null
    end),
  -- Cada parte tiene su tipo: el capital y el desembolso son traspasos (sin
  -- signo), los intereses y las comisiones son gasto.
  add constraint tx_loan_part_type check (
    loan_part is null
    or (loan_part in ('DESEMBOLSO', 'CAPITAL', 'LIQUIDACION') and type = 'TRANSFER')
    or (loan_part in ('COMISION', 'INTERESES', 'COMISION_CANCELACION') and type = 'EXPENSE')),
  add constraint transaction_loan_fk
    foreign key (user_id, loan_id)
    references public.loan (user_id, id) on delete restrict;

create index tx_loan_idx on public.transaction (user_id, loan_id) where loan_id is not null;

-- La generación es idempotente: nunca dos veces la misma parte de la misma cuota…
create unique index tx_loan_cuota_uq
  on public.transaction (user_id, loan_id, loan_period, loan_part) where loan_period is not null;
-- …ni dos desembolsos, comisiones o liquidaciones del mismo préstamo.
create unique index tx_loan_evento_uq
  on public.transaction (user_id, loan_id, loan_part) where loan_id is not null and loan_period is null;


-- ---------------------------------------------------------------------------
-- loan_plan — el cuadro de amortización, derivado. Función pura.
-- ---------------------------------------------------------------------------
create or replace function public.loan_plan(
  p_principal_cents bigint,
  p_term_months     integer,
  p_tin_pct         numeric,
  p_first_charge_on date
)
returns table (
  period              integer,
  due_on              date,
  payment_cents       bigint,
  interest_cents      bigint,
  principal_cents     bigint,
  balance_after_cents bigint
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- 12 meses × 100 (%) × 10⁴ (cuatro decimales del TIN).
  c_d     constant numeric := 12000000;
  v_t     numeric;          -- TIN en diezmilésimas de punto: 6,5 % → 65000
  v_q     numeric := 1;     -- (D+T)ⁿ
  v_dn    numeric := 1;     -- Dⁿ
  v_cuota numeric;
  v_pend  numeric;
  v_int   numeric;
  v_cap   numeric;
  k       integer;
begin
  if p_principal_cents is null or p_principal_cents <= 0 then
    raise exception 'El importe del préstamo tiene que ser mayor que cero' using errcode = '22023';
  end if;
  if p_term_months is null or p_term_months < 1 or p_term_months > 480 then
    raise exception 'El plazo va de 1 a 480 meses' using errcode = '22023';
  end if;
  if p_tin_pct is null or p_tin_pct < 0 or p_tin_pct > 50 or p_tin_pct <> round(p_tin_pct, 4) then
    raise exception 'El TIN va de 0 a 50 %%, con cuatro decimales como mucho' using errcode = '22023';
  end if;
  if p_first_charge_on is null then
    raise exception 'Falta la fecha de la primera cuota' using errcode = '22023';
  end if;

  v_t := p_tin_pct * 10000;
  v_pend := p_principal_cents;

  -- div() es la división entera (trunca; con positivos, un suelo):
  -- ⌊(2a + b) / 2b⌋ redondea a/b con el empate hacia arriba.
  if v_t = 0 then
    v_cuota := div(2 * v_pend + p_term_months, 2 * p_term_months);
  else
    for k in 1 .. p_term_months loop
      v_q  := v_q * (c_d + v_t);
      v_dn := v_dn * c_d;
    end loop;
    v_cuota := div(2 * v_pend * v_t * v_q + c_d * (v_q - v_dn), 2 * c_d * (v_q - v_dn));
  end if;

  for k in 1 .. p_term_months loop
    v_int := div(2 * v_pend * v_t + c_d, 2 * c_d);
    if k < p_term_months then
      v_cap := v_cuota - v_int;
    else
      v_cap := v_pend;   -- la última cuota ajusta: el pendiente queda en 0
    end if;
    if v_cap < 0 or (k < p_term_months and v_pend - v_cap <= 0) then
      raise exception 'Con ese importe, el plazo es demasiado largo: la cuota no llega a amortizar'
        using errcode = '22023';
    end if;
    v_pend := v_pend - v_cap;

    period              := k;
    due_on              := (p_first_charge_on + make_interval(months => k - 1))::date;
    payment_cents       := (v_int + v_cap)::bigint;
    interest_cents      := v_int::bigint;
    principal_cents     := v_cap::bigint;
    balance_after_cents := v_pend::bigint;
    return next;
  end loop;
end $$;

comment on function public.loan_plan(bigint, integer, numeric, date) is
  'Cuadro de amortización francés en céntimos exactos (mitad hacia arriba por periodo; la última cuota ajusta). Espejo de cuadroAmortizacion() en src/lib/prestamos.ts.';

revoke all on function public.loan_plan(bigint, integer, numeric, date) from public, anon;
grant execute on function public.loan_plan(bigint, integer, numeric, date) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- loan_tae — la TAE informativa: la tasa efectiva anual que iguala lo recibido
-- (principal − comisión) con las cuotas del cuadro. Bisección en dobles, con el
-- MISMO orden de operaciones que taeCalculada() en src/lib/prestamos.ts.
-- No es un importe (invariante 1): es un porcentaje que se enseña, nada más.
-- ---------------------------------------------------------------------------
create or replace function private.loan_npv(
  p_cuotas double precision[],
  p_neto   double precision,
  p_r      double precision
)
returns double precision
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_v      double precision := 1 / (1 + p_r);
  v_factor double precision := 1;
  v_suma   double precision := 0;
  v_c      double precision;
begin
  foreach v_c in array p_cuotas loop
    v_factor := v_factor * v_v;
    v_suma   := v_suma + v_c * v_factor;
  end loop;
  return v_suma - p_neto;
end $$;

revoke all on function private.loan_npv(double precision[], double precision, double precision) from public, anon;
grant execute on function private.loan_npv(double precision[], double precision, double precision)
  to authenticated, service_role;

create or replace function public.loan_tae(
  p_principal_cents   bigint,
  p_term_months       integer,
  p_tin_pct           numeric,
  p_opening_fee_cents bigint
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_cuotas double precision[];
  v_neto   double precision;
  v_bajo   double precision := 0;
  v_alto   double precision := 1;
  v_medio  double precision;
  v_r      double precision;
  v_anual  double precision := 1;
  i        integer;
begin
  select array_agg(p.payment_cents::double precision order by p.period)
    into v_cuotas
  from public.loan_plan(p_principal_cents, p_term_months, p_tin_pct, date '2000-01-01') p;

  v_neto := (p_principal_cents - coalesce(p_opening_fee_cents, 0))::double precision;
  if v_neto <= 0 then
    return null;
  end if;
  if private.loan_npv(v_cuotas, v_neto, 0) <= 0 then
    return 0;
  end if;
  -- Un tipo mensual por encima del 100 %: no hay TAE que enseñar.
  if private.loan_npv(v_cuotas, v_neto, 1) > 0 then
    return null;
  end if;

  for i in 1 .. 100 loop
    v_medio := (v_bajo + v_alto) / 2;
    if private.loan_npv(v_cuotas, v_neto, v_medio) > 0 then
      v_bajo := v_medio;
    else
      v_alto := v_medio;
    end if;
  end loop;

  v_r := (v_bajo + v_alto) / 2;
  for i in 1 .. 12 loop
    v_anual := v_anual * (1 + v_r);
  end loop;
  return round(((v_anual - 1) * 100)::numeric, 2);
end $$;

comment on function public.loan_tae(bigint, integer, numeric, bigint) is
  'TAE informativa (en %, dos decimales): tipo efectivo anual que iguala principal − comisión con las cuotas de loan_plan. Periodos mensuales, no días/365. Espejo de taeCalculada().';

revoke all on function public.loan_tae(bigint, integer, numeric, bigint) from public, anon;
grant execute on function public.loan_tae(bigint, integer, numeric, bigint) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- La categoría «Intereses» del usuario: la que haya (sin distinguir
-- mayúsculas) o una nueva. `category_name_uq` hace que dos llamadas a la vez
-- no creen dos: la segunda choca, no inserta y lee la de la primera.
-- ---------------------------------------------------------------------------
create or replace function private.loan_interest_category(p_user uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id
  from public.category c
  where c.user_id = p_user and c.type = 'EXPENSE' and lower(btrim(c.name)) = 'intereses';

  if v_id is null then
    insert into public.category (user_id, name, type, color, icon)
    values (p_user, 'Intereses', 'EXPENSE', '#b5541f', 'hand-coins')
    on conflict (user_id, type, (lower(btrim(name)))) do nothing
    returning id into v_id;

    if v_id is null then
      select c.id into v_id
      from public.category c
      where c.user_id = p_user and c.type = 'EXPENSE' and lower(btrim(c.name)) = 'intereses';
    end if;
  end if;

  return v_id;
end $$;

revoke all on function private.loan_interest_category(uuid) from public, anon;
grant execute on function private.loan_interest_category(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Comprueba unas condiciones y devuelve la primera cuota (la dada o la de por
-- defecto: el día de cobro del mes siguiente al de inicio) y la primera cuota
-- que generará la app. Lanza 22023 con un mensaje legible si algo no vale.
-- La comparten create_loan y update_loan_terms.
-- ---------------------------------------------------------------------------
create or replace function private.loan_check_terms(
  p_user               uuid,
  p_payment_account_id uuid,
  p_principal_cents    bigint,
  p_term_months        integer,
  p_tin_pct            numeric,
  p_opening_fee_cents  bigint,
  p_charge_day         integer,
  p_start_on           date,
  p_first_charge_on    date,
  p_disbursed          boolean,
  p_hoy                date,
  out first_charge_on  date,
  out tracked_from     integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tipo      text;
  v_archivada boolean;
begin
  select a.type::text, a.archived into v_tipo, v_archivada
  from public.account a
  where a.id = p_payment_account_id and a.user_id = p_user;

  if not found then
    raise exception 'La cuenta de pago no existe' using errcode = '22023';
  end if;
  if v_tipo = 'PRESTAMO' then
    raise exception 'Un préstamo no se paga desde la cuenta de otro préstamo' using errcode = '22023';
  end if;
  if v_archivada then
    raise exception 'La cuenta de pago está archivada' using errcode = '22023';
  end if;

  if p_principal_cents is null or p_principal_cents < 10000 or p_principal_cents > 1000000000 then
    raise exception 'El importe va de 100 € a 10 millones' using errcode = '22023';
  end if;
  if p_disbursed is null then
    raise exception 'Indica si el dinero entra ahora o ya lo tenías apuntado' using errcode = '22023';
  end if;
  if coalesce(p_opening_fee_cents, 0) < 0 or coalesce(p_opening_fee_cents, 0) >= p_principal_cents then
    raise exception 'La comisión de apertura no puede ser negativa ni llegar al importe' using errcode = '22023';
  end if;
  if not p_disbursed and coalesce(p_opening_fee_cents, 0) > 0 then
    raise exception 'Un préstamo que ya tenías apuntado no lleva comisión de apertura' using errcode = '22023';
  end if;
  if p_charge_day is null or p_charge_day < 1 or p_charge_day > 28 then
    raise exception 'El día de cobro va del 1 al 28' using errcode = '22023';
  end if;
  if p_start_on is null or p_start_on < date '2000-01-01' then
    raise exception 'La fecha de inicio no es válida' using errcode = '22023';
  end if;
  if p_start_on > p_hoy then
    raise exception 'La fecha de inicio no puede ser futura' using errcode = '22023';
  end if;

  first_charge_on := coalesce(
    p_first_charge_on,
    (date_trunc('month', p_start_on::timestamp) + interval '1 month'
       + make_interval(days => p_charge_day - 1))::date);

  if first_charge_on <= p_start_on then
    raise exception 'La primera cuota tiene que ser posterior a la fecha de inicio' using errcode = '22023';
  end if;
  if extract(day from first_charge_on) <> p_charge_day then
    raise exception 'La primera cuota tiene que caer en el día de cobro' using errcode = '22023';
  end if;

  -- El cuadro valida plazo, TIN y que la cuota amortice.
  if p_disbursed then
    perform count(*) from public.loan_plan(p_principal_cents, p_term_months, p_tin_pct, first_charge_on);
    tracked_from := 1;
  else
    select min(p.period) into tracked_from
    from public.loan_plan(p_principal_cents, p_term_months, p_tin_pct, first_charge_on) p
    where p.due_on > p_hoy;

    if tracked_from is null then
      raise exception 'Todas las cuotas de este préstamo ya han pasado: estaría pagado' using errcode = '22023';
    end if;
  end if;
end $$;

revoke all on function private.loan_check_terms(uuid, uuid, bigint, integer, numeric, bigint, integer, date, date, boolean, date)
  from public, anon;
grant execute on function private.loan_check_terms(uuid, uuid, bigint, integer, numeric, bigint, integer, date, date, boolean, date)
  to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- (Re)hace el ARRANQUE de un préstamo según sus condiciones: el saldo inicial
-- de la cuenta-pasivo y, si se desembolsa, el traspaso del principal y la
-- comisión de apertura. La comparten create_loan y update_loan_terms (que solo
-- se permite sin cuotas cobradas).
-- ---------------------------------------------------------------------------
create or replace function private.loan_rebuild_opening(p_loan_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  l      public.loan%rowtype;
  v_pend bigint;
  v_cat  uuid;
begin
  select * into l from public.loan where id = p_loan_id for update;
  if not found then
    raise exception 'Préstamo no encontrado' using errcode = 'P0002';
  end if;

  delete from public.transaction t
  where t.user_id = l.user_id and t.loan_id = l.id
    and t.loan_period is null and t.loan_part in ('DESEMBOLSO', 'COMISION');

  if l.disbursed then
    v_pend := 0;
  elsif l.tracked_from_period = 1 then
    v_pend := l.principal_cents;
  else
    select p.balance_after_cents into v_pend
    from public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
    where p.period = l.tracked_from_period - 1;
  end if;

  -- «Ya lo tenía apuntado»: la deuda arranca como saldo inicial negativo.
  update public.account a
     set initial_balance_cents = -v_pend
   where a.user_id = l.user_id and a.id = l.liability_account_id;

  if l.disbursed then
    insert into public.transaction (
      user_id, type, amount_cents, description, occurred_on,
      account_id, to_account_id, source, status, loan_id, loan_part
    )
    values (
      l.user_id, 'TRANSFER', l.principal_cents, format('Préstamo %s: el dinero entra', l.name),
      l.start_on, l.liability_account_id, l.payment_account_id,
      'MANUAL', 'CONFIRMED', l.id, 'DESEMBOLSO'
    );

    if l.opening_fee_cents > 0 then
      v_cat := coalesce(l.interest_category_id, private.loan_interest_category(l.user_id));
      if l.interest_category_id is null then
        update public.loan set interest_category_id = v_cat, interest_category_type = 'EXPENSE'
         where id = l.id;
      end if;

      insert into public.transaction (
        user_id, type, amount_cents, description, occurred_on,
        account_id, category_id, category_type, source, status, loan_id, loan_part
      )
      values (
        l.user_id, 'EXPENSE', l.opening_fee_cents, format('Comisión de apertura · %s', l.name),
        l.start_on, l.payment_account_id, v_cat, 'EXPENSE',
        'MANUAL', 'CONFIRMED', l.id, 'COMISION'
      );
    end if;
  end if;
end $$;

revoke all on function private.loan_rebuild_opening(uuid) from public, anon;
grant execute on function private.loan_rebuild_opening(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- private.loan_generate — el corazón de «se cobra solo».
--
-- Para cada préstamo ACTIVO visible (por la RLS para un usuario; todos para
-- service_role), crea en orden las cuotas con fecha ≤ hoy que falten: un gasto
-- por los intereses (si los hay) y un traspaso por el capital (si lo hay). Con
-- la última, LIQUIDADO y la cuenta-pasivo archivada (su saldo ya es 0).
--
-- «Hoy» es la fecha de MADRID, no la del servidor (UTC): una cuota del día 1
-- se cobra a partir de las 00:00 de Madrid. `p_hoy` solo puede ADELANTAR el
-- corte hacia el pasado (las pruebas lo usan); nunca genera cuotas futuras.
--
-- `FOR UPDATE` sobre el préstamo serializa al cron y al usuario si coinciden:
-- el segundo espera, relee la marca de agua y no repite nada.
-- ---------------------------------------------------------------------------
create or replace function private.loan_generate(
  p_user   uuid,
  p_loan   uuid,
  p_hoy    date,
  p_marcar boolean
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_hoy     date := least(coalesce(p_hoy, (now() at time zone 'Europe/Madrid')::date),
                          (now() at time zone 'Europe/Madrid')::date);
  l         record;
  c         record;
  v_cat     uuid;
  v_ultimo  integer;
  v_fin     date;
  v_creadas integer := 0;
begin
  for l in
    select *
    from public.loan lo
    where lo.status = 'ACTIVO'
      and lo.last_generated_period < lo.term_months
      and (p_user is null or lo.user_id = p_user)
      and (p_loan is null or lo.id = p_loan)
    order by lo.user_id, lo.id
    for update
  loop
    v_ultimo := l.last_generated_period;
    v_cat := l.interest_category_id;

    for c in
      select p.*
      from public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
      where p.period > l.last_generated_period
        and p.due_on <= v_hoy
      order by p.period
    loop
      if c.interest_cents > 0 then
        if v_cat is null then
          v_cat := private.loan_interest_category(l.user_id);
          update public.loan set interest_category_id = v_cat, interest_category_type = 'EXPENSE'
           where id = l.id;
        end if;

        insert into public.transaction (
          user_id, type, amount_cents, description, occurred_on,
          account_id, category_id, category_type, source, status,
          loan_id, loan_period, loan_part
        )
        values (
          l.user_id, 'EXPENSE', c.interest_cents,
          format('Intereses · %s (cuota %s/%s)', l.name, c.period, l.term_months),
          c.due_on, l.payment_account_id, v_cat, 'EXPENSE', 'RECURRING', 'CONFIRMED',
          l.id, c.period, 'INTERESES'
        )
        on conflict (user_id, loan_id, loan_period, loan_part) where loan_period is not null do nothing;
      end if;

      if c.principal_cents > 0 then
        insert into public.transaction (
          user_id, type, amount_cents, description, occurred_on,
          account_id, to_account_id, source, status,
          loan_id, loan_period, loan_part
        )
        values (
          l.user_id, 'TRANSFER', c.principal_cents,
          format('Capital · %s (cuota %s/%s)', l.name, c.period, l.term_months),
          c.due_on, l.payment_account_id, l.liability_account_id, 'RECURRING', 'CONFIRMED',
          l.id, c.period, 'CAPITAL'
        )
        on conflict (user_id, loan_id, loan_period, loan_part) where loan_period is not null do nothing;
      end if;

      v_ultimo := c.period;
      v_fin := c.due_on;
      v_creadas := v_creadas + 1;
    end loop;

    if v_ultimo > l.last_generated_period then
      update public.loan lo
         set last_generated_period = v_ultimo,
             notified_period = case when p_marcar then v_ultimo else lo.notified_period end,
             status = case when v_ultimo = lo.term_months then 'LIQUIDADO' else lo.status end,
             closed_on = case when v_ultimo = lo.term_months then v_fin else lo.closed_on end
       where lo.id = l.id;

      if v_ultimo = l.term_months then
        update public.account a
           set archived = true, archived_at = now()
         where a.user_id = l.user_id and a.id = l.liability_account_id and not a.archived;
      end if;
    end if;
  end loop;

  return v_creadas;
end $$;

revoke all on function private.loan_generate(uuid, uuid, date, boolean) from public, anon;
grant execute on function private.loan_generate(uuid, uuid, date, boolean) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- La generación, para el usuario: solo lo suyo y marcando como ya avisado (lo
-- está viendo en la app; no hace falta un push).
-- ---------------------------------------------------------------------------
create or replace function public.generate_loan_installments()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select private.current_user_id());
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;
  return private.loan_generate(v_uid, null, null, true);
end $$;

revoke all on function public.generate_loan_installments() from public, anon;
grant execute on function public.generate_loan_installments() to authenticated;


-- ---------------------------------------------------------------------------
-- La generación de TODOS los usuarios, para el cron. Solo service_role.
-- ---------------------------------------------------------------------------
create or replace function public.generate_loan_installments_all()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.loan_generate(null, null, null, false);
end $$;

comment on function public.generate_loan_installments_all() is
  'Genera las cuotas vencidas de todos los préstamos activos. Solo service_role (cron de /api/notificar), que se salta la RLS: sin security definer.';

revoke all on function public.generate_loan_installments_all() from public, anon, authenticated;
grant execute on function public.generate_loan_installments_all() to service_role;


-- ---------------------------------------------------------------------------
-- Avisos de cuota cobrada: devuelve, una sola vez, las cuotas generadas por el
-- cron de las que aún no se avisó, y las marca ANTES de devolverlas (como las
-- claim_* de los límites). Solo service_role.
-- ---------------------------------------------------------------------------
create or replace function public.claim_loan_installment_notices()
returns table (
  user_id      uuid,
  loan_id      uuid,
  loan_name    text,
  from_period  integer,
  to_period    integer,
  term_months  integer,
  amount_cents bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  l record;
begin
  for l in
    select lo.*
    from public.loan lo
    where lo.last_generated_period > lo.notified_period
      and lo.status <> 'CANCELADO'
    order by lo.user_id, lo.id
    for update
  loop
    update public.loan lo set notified_period = l.last_generated_period where lo.id = l.id;

    user_id     := l.user_id;
    loan_id     := l.id;
    loan_name   := l.name;
    from_period := greatest(l.notified_period + 1, l.tracked_from_period);
    to_period   := l.last_generated_period;
    term_months := l.term_months;
    select coalesce(sum(p.payment_cents), 0)::bigint into amount_cents
    from public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
    where p.period between greatest(l.notified_period + 1, l.tracked_from_period) and l.last_generated_period;
    return next;
  end loop;
end $$;

revoke all on function public.claim_loan_installment_notices() from public, anon, authenticated;
grant execute on function public.claim_loan_installment_notices() to service_role;


-- ---------------------------------------------------------------------------
-- create_loan — alta con todo: cuenta-pasivo, arranque y cuotas ya vencidas.
-- ---------------------------------------------------------------------------
create or replace function public.create_loan(
  p_name               text,
  p_payment_account_id uuid,
  p_principal_cents    bigint,
  p_term_months        integer,
  p_tin_pct            numeric,
  p_tae_pct            numeric,
  p_opening_fee_cents  bigint,
  p_charge_day         integer,
  p_start_on           date,
  p_first_charge_on    date,
  p_disbursed          boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select private.current_user_id());
  v_hoy     date := (now() at time zone 'Europe/Madrid')::date;
  v_nombre  text := btrim(coalesce(p_name, ''));
  v_terms   record;
  v_cuenta  uuid;
  v_loan    uuid;
  v_creadas integer;
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;
  if length(v_nombre) not between 1 and 40 then
    raise exception 'El nombre va de 1 a 40 caracteres' using errcode = '22023';
  end if;
  if p_tae_pct is not null and (p_tae_pct < 0 or p_tae_pct > 100 or p_tae_pct <> round(p_tae_pct, 4)) then
    raise exception 'La TAE va de 0 a 100 %%, con cuatro decimales como mucho' using errcode = '22023';
  end if;

  select * into v_terms
  from private.loan_check_terms(
    v_uid, p_payment_account_id, p_principal_cents, p_term_months, p_tin_pct,
    coalesce(p_opening_fee_cents, 0), coalesce(p_charge_day, 1), p_start_on, p_first_charge_on,
    p_disbursed, v_hoy);

  insert into public.account (user_id, name, type, initial_balance_cents, color)
  values (v_uid, 'Préstamo · ' || v_nombre, 'PRESTAMO', 0, '#b3261e')
  returning id into v_cuenta;

  insert into public.loan (
    user_id, name, payment_account_id, liability_account_id, liability_account_type,
    principal_cents, term_months, tin_pct, tae_pct, opening_fee_cents, charge_day,
    start_on, first_charge_on, disbursed,
    tracked_from_period, last_generated_period, notified_period
  )
  values (
    v_uid, v_nombre, p_payment_account_id, v_cuenta, 'PRESTAMO',
    p_principal_cents, p_term_months, p_tin_pct, p_tae_pct, coalesce(p_opening_fee_cents, 0),
    coalesce(p_charge_day, 1), p_start_on, v_terms.first_charge_on, p_disbursed,
    v_terms.tracked_from, v_terms.tracked_from - 1, v_terms.tracked_from - 1
  )
  returning id into v_loan;

  perform private.loan_rebuild_opening(v_loan);

  -- Las cuotas ya vencidas se generan ahora, y como el usuario las está viendo,
  -- no se avisan por push.
  v_creadas := private.loan_generate(v_uid, v_loan, v_hoy, true);

  return jsonb_build_object(
    'loan_id', v_loan,
    'liability_account_id', v_cuenta,
    'first_charge_on', v_terms.first_charge_on,
    'tracked_from_period', v_terms.tracked_from,
    'generated', v_creadas
  );
end $$;

revoke all on function public.create_loan(text, uuid, bigint, integer, numeric, numeric, bigint, integer, date, date, boolean)
  from public, anon;
grant execute on function public.create_loan(text, uuid, bigint, integer, numeric, numeric, bigint, integer, date, date, boolean)
  to authenticated;


-- ---------------------------------------------------------------------------
-- update_loan — lo que se puede cambiar siempre: el nombre (y el de su
-- cuenta-pasivo) y la TAE del contrato, que es informativa.
-- ---------------------------------------------------------------------------
create or replace function public.update_loan(p_loan_id uuid, p_name text, p_tae_pct numeric)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid    uuid := (select private.current_user_id());
  v_nombre text := btrim(coalesce(p_name, ''));
  v_cuenta uuid;
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;
  if length(v_nombre) not between 1 and 40 then
    raise exception 'El nombre va de 1 a 40 caracteres' using errcode = '22023';
  end if;
  if p_tae_pct is not null and (p_tae_pct < 0 or p_tae_pct > 100 or p_tae_pct <> round(p_tae_pct, 4)) then
    raise exception 'La TAE va de 0 a 100 %%, con cuatro decimales como mucho' using errcode = '22023';
  end if;

  update public.loan l
     set name = v_nombre, tae_pct = p_tae_pct
   where l.id = p_loan_id and l.user_id = v_uid
  returning l.liability_account_id into v_cuenta;

  if v_cuenta is null then
    raise exception 'Préstamo no encontrado' using errcode = 'P0002';
  end if;

  update public.account a
     set name = 'Préstamo · ' || v_nombre
   where a.user_id = v_uid and a.id = v_cuenta;
end $$;

revoke all on function public.update_loan(uuid, text, numeric) from public, anon;
grant execute on function public.update_loan(uuid, text, numeric) to authenticated;


-- ---------------------------------------------------------------------------
-- update_loan_terms — las condiciones financieras, SOLO mientras no haya
-- ninguna cuota cobrada. Rehace el arranque y genera lo que ya toque.
-- ---------------------------------------------------------------------------
create or replace function public.update_loan_terms(
  p_loan_id            uuid,
  p_payment_account_id uuid,
  p_principal_cents    bigint,
  p_term_months        integer,
  p_tin_pct            numeric,
  p_opening_fee_cents  bigint,
  p_charge_day         integer,
  p_start_on           date,
  p_first_charge_on    date,
  p_disbursed          boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select private.current_user_id());
  v_hoy     date := (now() at time zone 'Europe/Madrid')::date;
  l         public.loan%rowtype;
  v_terms   record;
  v_creadas integer;
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  select * into l from public.loan where id = p_loan_id and user_id = v_uid for update;
  if not found then
    raise exception 'Préstamo no encontrado' using errcode = 'P0002';
  end if;
  if l.status <> 'ACTIVO' then
    raise exception 'Este préstamo ya no está activo' using errcode = '22023';
  end if;
  if l.last_generated_period >= l.tracked_from_period then
    raise exception 'Este préstamo ya tiene cuotas cobradas: sus condiciones no se pueden cambiar'
      using errcode = '23514';
  end if;

  select * into v_terms
  from private.loan_check_terms(
    v_uid, p_payment_account_id, p_principal_cents, p_term_months, p_tin_pct,
    coalesce(p_opening_fee_cents, 0), coalesce(p_charge_day, 1), p_start_on, p_first_charge_on,
    p_disbursed, v_hoy);

  update public.loan
     set payment_account_id    = p_payment_account_id,
         principal_cents       = p_principal_cents,
         term_months           = p_term_months,
         tin_pct               = p_tin_pct,
         opening_fee_cents     = coalesce(p_opening_fee_cents, 0),
         charge_day            = coalesce(p_charge_day, 1),
         start_on              = p_start_on,
         first_charge_on       = v_terms.first_charge_on,
         disbursed             = p_disbursed,
         tracked_from_period   = v_terms.tracked_from,
         last_generated_period = v_terms.tracked_from - 1,
         notified_period       = v_terms.tracked_from - 1
   where id = l.id;

  perform private.loan_rebuild_opening(l.id);
  v_creadas := private.loan_generate(v_uid, l.id, v_hoy, true);

  return jsonb_build_object(
    'first_charge_on', v_terms.first_charge_on,
    'tracked_from_period', v_terms.tracked_from,
    'generated', v_creadas
  );
end $$;

revoke all on function public.update_loan_terms(uuid, uuid, bigint, integer, numeric, bigint, integer, date, date, boolean)
  from public, anon;
grant execute on function public.update_loan_terms(uuid, uuid, bigint, integer, numeric, bigint, integer, date, date, boolean)
  to authenticated;


-- ---------------------------------------------------------------------------
-- cancel_loan — dejar de seguirlo: no genera más cuotas. No mueve dinero: la
-- deuda que quede sigue en la cuenta-pasivo (y en el patrimonio) hasta que se
-- liquide o se elimine el préstamo.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_loan(p_loan_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select private.current_user_id());
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  update public.loan
     set status = 'CANCELADO', closed_on = (now() at time zone 'Europe/Madrid')::date
   where id = p_loan_id and user_id = v_uid and status = 'ACTIVO';

  if not found then
    raise exception 'Préstamo no encontrado o ya cerrado' using errcode = 'P0002';
  end if;
end $$;

revoke all on function public.cancel_loan(uuid) from public, anon;
grant execute on function public.cancel_loan(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- settle_loan — liquidación anticipada: genera las cuotas vencidas hasta la
-- fecha, paga el pendiente REAL (−saldo de la cuenta-pasivo, derivado de los
-- movimientos) con un traspaso, apunta la comisión de cancelación si la hay y
-- cierra el préstamo.
-- ---------------------------------------------------------------------------
create or replace function public.settle_loan(p_loan_id uuid, p_on date, p_fee_cents bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid    uuid := (select private.current_user_id());
  v_hoy    date := (now() at time zone 'Europe/Madrid')::date;
  v_on     date := coalesce(p_on, (now() at time zone 'Europe/Madrid')::date);
  v_fee    bigint := coalesce(p_fee_cents, 0);
  l        public.loan%rowtype;
  v_ultima date;
  v_pend   bigint;
  v_cat    uuid;
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  select * into l from public.loan where id = p_loan_id and user_id = v_uid for update;
  if not found then
    raise exception 'Préstamo no encontrado' using errcode = 'P0002';
  end if;
  if l.status <> 'ACTIVO' then
    raise exception 'Este préstamo ya no está activo' using errcode = '22023';
  end if;
  if v_on > v_hoy or v_on < l.start_on then
    raise exception 'La fecha de liquidación tiene que estar entre el inicio y hoy' using errcode = '22023';
  end if;
  if v_fee < 0 or v_fee > 100000000 then
    raise exception 'La comisión de cancelación no es válida' using errcode = '22023';
  end if;

  -- Lo vencido hasta esa fecha se cobra antes; lo posterior ya no se cobrará.
  perform private.loan_generate(v_uid, l.id, v_on, true);
  select * into l from public.loan where id = p_loan_id;

  if l.status <> 'ACTIVO' then
    -- La última cuota ya entraba en la fecha: queda liquidado por sí solo.
    return jsonb_build_object('settled_cents', 0, 'fee_cents', 0);
  end if;

  if l.last_generated_period >= 1 then
    v_ultima := (l.first_charge_on + make_interval(months => l.last_generated_period - 1))::date;
    if v_on < v_ultima then
      raise exception 'Ya hay una cuota cobrada después de esa fecha' using errcode = '22023';
    end if;
  end if;

  select (-b.balance_cents)::bigint into v_pend
  from public.v_account_balance b
  where b.account_id = l.liability_account_id;

  if v_pend > 0 then
    insert into public.transaction (
      user_id, type, amount_cents, description, occurred_on,
      account_id, to_account_id, source, status, loan_id, loan_part
    )
    values (
      v_uid, 'TRANSFER', v_pend, format('Liquidación · %s', l.name), v_on,
      l.payment_account_id, l.liability_account_id, 'MANUAL', 'CONFIRMED', l.id, 'LIQUIDACION'
    );
  end if;

  if v_fee > 0 then
    v_cat := coalesce(l.interest_category_id, private.loan_interest_category(v_uid));
    insert into public.transaction (
      user_id, type, amount_cents, description, occurred_on,
      account_id, category_id, category_type, source, status, loan_id, loan_part
    )
    values (
      v_uid, 'EXPENSE', v_fee, format('Comisión de cancelación · %s', l.name), v_on,
      l.payment_account_id, v_cat, 'EXPENSE', 'MANUAL', 'CONFIRMED', l.id, 'COMISION_CANCELACION'
    );
  end if;

  update public.loan
     set status = 'LIQUIDADO', closed_on = v_on, notified_period = last_generated_period,
         interest_category_id = coalesce(interest_category_id, v_cat),
         interest_category_type = case when coalesce(interest_category_id, v_cat) is null
                                       then null else 'EXPENSE'::public.entry_type end
   where id = l.id;

  update public.account a
     set archived = true, archived_at = now()
   where a.user_id = v_uid and a.id = l.liability_account_id and not a.archived;

  return jsonb_build_object('settled_cents', greatest(coalesce(v_pend, 0), 0), 'fee_cents', v_fee);
end $$;

revoke all on function public.settle_loan(uuid, date, bigint) from public, anon;
grant execute on function public.settle_loan(uuid, date, bigint) to authenticated;


-- ---------------------------------------------------------------------------
-- loan_delete_preview / delete_loan — eliminar un préstamo con TODO lo suyo:
-- sus movimientos (en cualquier cuenta), los movimientos a mano que toquen su
-- cuenta-pasivo y la propia cuenta-pasivo. Mismo patrón que delete_account:
-- primero se enseña qué cambia, y se borra solo si el nombre escrito coincide.
-- ---------------------------------------------------------------------------
create or replace function public.loan_delete_preview(p_loan_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select private.current_user_id());
  l         public.loan%rowtype;
  v_inicial bigint;
  v_res     jsonb;
begin
  if v_uid is null then
    raise exception 'Sesión sin verificar' using errcode = '42501';
  end if;

  select * into l from public.loan where id = p_loan_id and user_id = v_uid;
  if not found then
    raise exception 'Préstamo no encontrado' using errcode = 'P0002';
  end if;

  select a.initial_balance_cents into v_inicial
  from public.account a where a.id = l.liability_account_id and a.user_id = v_uid;

  with afectados as (
    select t.*
    from public.transaction t
    where t.user_id = v_uid
      and (t.loan_id = l.id
           or t.account_id = l.liability_account_id
           or t.to_account_id = l.liability_account_id)
  ),
  efectos as (
    -- Lo que cada movimiento movía en cada cuenta que NO es la cuenta-pasivo:
    -- al borrarlo, ese saldo se deshace (con el signo cambiado).
    select m.account_id, -sum(m.delta_cents) as delta
    from public.v_account_movement m
    join afectados a on a.id = m.transaction_id
    where m.account_id <> l.liability_account_id
    group by m.account_id
  )
  select jsonb_build_object(
    'name', l.name,
    'status', l.status,
    'transactions', (select count(*) from afectados),
    'installments', (select count(distinct a.loan_period) from afectados a where a.loan_period is not null),
    'expense_cents', (select coalesce(sum(a.amount_cents), 0) from afectados a
                       where a.type = 'EXPENSE' and a.status <> 'DISCARDED'),
    'balance_effects', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account_id', e.account_id,
               'account_name', ac.name,
               'balance_delta_cents', e.delta::bigint) order by ac.name)
      from efectos e join public.account ac on ac.id = e.account_id
      where e.delta <> 0), '[]'::jsonb),
    -- El patrimonio pierde la cuenta-pasivo (su saldo, negativo, deja de
    -- restar) y los efectos en las demás cuentas. Equivale a devolver los
    -- intereses y comisiones pagados y a olvidar la deuda inicial apuntada.
    'net_worth_delta_cents', (
      coalesce((select sum(e.delta) from efectos e), 0)
      - coalesce((select b.balance_cents from public.v_account_balance b
                  where b.account_id = l.liability_account_id), 0)
    )::bigint,
    'liability_initial_cents', v_inicial
  ) into v_res;

  return v_res;
end $$;

revoke all on function public.loan_delete_preview(uuid) from public, anon;
grant execute on function public.loan_delete_preview(uuid) to authenticated;


create or replace function public.delete_loan(p_loan_id uuid, p_confirm_name text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid         uuid := (select private.current_user_id());
  l             public.loan%rowtype;
  v_movimientos bigint;
  v_borrados    bigint;
  v_cuenta      text;
  v_res         jsonb;
begin
  if v_uid is null then
    raise exception 'Sesión sin verificar' using errcode = '42501';
  end if;

  select * into l from public.loan where id = p_loan_id and user_id = v_uid for update;
  if not found then
    raise exception 'Préstamo no encontrado' using errcode = 'P0002';
  end if;

  if p_confirm_name is null or btrim(p_confirm_name) <> btrim(l.name) then
    raise exception 'El nombre no coincide con el del préstamo' using errcode = '22023';
  end if;

  -- 1. Los movimientos del préstamo, estén en la cuenta que estén.
  delete from public.transaction t where t.user_id = v_uid and t.loan_id = l.id;
  get diagnostics v_movimientos = row_count;

  -- 2. El préstamo: abre la política SOLO para esta fila y SOLO aquí.
  perform set_config('cartera.prestamo_a_borrar', l.id::text, true);
  delete from public.loan where id = l.id and user_id = v_uid;
  get diagnostics v_borrados = row_count;
  perform set_config('cartera.prestamo_a_borrar', '', true);

  if v_borrados <> 1 then
    raise exception 'No se pudo eliminar el préstamo' using errcode = '42501';
  end if;

  -- 3. La cuenta-pasivo, con delete_account: arrastra lo que quede en ella
  --    (movimientos a mano, tarjetas, metas) igual que al borrar una cuenta.
  select a.name into v_cuenta from public.account a where a.id = l.liability_account_id and a.user_id = v_uid;
  v_res := public.delete_account(l.liability_account_id, v_cuenta);

  return jsonb_build_object(
    'transactions', v_movimientos + coalesce((v_res ->> 'transactions')::bigint, 0)
  );
end $$;

revoke all on function public.delete_loan(uuid, text) from public, anon;
grant execute on function public.delete_loan(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- loan_schedule — el cuadro de un préstamo con el estado de cada cuota:
--   PREVIA     anterior al alta de un préstamo «ya apuntado» (pagada fuera)
--   COBRADA    generada por la app
--   PENDIENTE  aún no (préstamo activo)
--   ANULADA    ya no se cobrará (préstamo liquidado antes de tiempo o cancelado)
-- ---------------------------------------------------------------------------
create or replace function public.loan_schedule(p_loan_id uuid)
returns table (
  period              integer,
  due_on              date,
  payment_cents       bigint,
  interest_cents      bigint,
  principal_cents     bigint,
  balance_after_cents bigint,
  state               text,
  has_movement        boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.period,
         p.due_on,
         p.payment_cents,
         p.interest_cents,
         p.principal_cents,
         p.balance_after_cents,
         case
           when p.period < l.tracked_from_period then 'PREVIA'
           when p.period <= l.last_generated_period then 'COBRADA'
           when l.status = 'ACTIVO' then 'PENDIENTE'
           else 'ANULADA'
         end,
         exists (
           select 1 from public.transaction t
           where t.user_id = l.user_id and t.loan_id = l.id
             and t.loan_period = p.period and t.status <> 'DISCARDED'
         )
  from public.loan l
  cross join lateral public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
  where l.id = p_loan_id
  order by p.period;
$$;

revoke all on function public.loan_schedule(uuid) from public, anon;
grant execute on function public.loan_schedule(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- v_loan_status — el resumen de cada préstamo.
--
-- El capital PENDIENTE sale del saldo de la cuenta-pasivo (derivado de los
-- movimientos, como el patrimonio); `schedule_pending_cents` es el del cuadro,
-- para comprobar que cuadran (solo divergen si se mueve dinero a mano a la
-- cuenta-pasivo, p. ej. una amortización parcial, que el cuadro no recalcula).
-- Los intereses pagados son los de las cuotas previas al alta (según el
-- cuadro) más los movimientos de intereses reales.
-- ---------------------------------------------------------------------------
create view public.v_loan_status with (security_invoker = true) as
select l.id as loan_id,
       l.user_id,
       l.name,
       l.status,
       l.payment_account_id,
       l.liability_account_id,
       l.principal_cents,
       l.term_months::integer as term_months,
       l.tin_pct,
       l.tae_pct,
       tae.calc as tae_calc_pct,
       coalesce(l.tae_pct, tae.calc) as tae_effective_pct,
       l.opening_fee_cents,
       l.charge_day::integer as charge_day,
       l.start_on,
       l.first_charge_on,
       l.disbursed,
       l.tracked_from_period::integer as tracked_from_period,
       s.cuota as payment_cents,
       s.ultima as last_payment_cents,
       l.last_generated_period::integer as paid_count,
       case when l.status = 'ACTIVO' then l.term_months - l.last_generated_period else 0 end::integer
         as remaining_count,
       (-coalesce(b.balance_cents, 0))::bigint as principal_pending_cents,
       s.pendiente_cuadro as schedule_pending_cents,
       (l.principal_cents + coalesce(b.balance_cents, 0))::bigint as principal_paid_cents,
       s.intereses_totales as interest_total_cents,
       (s.intereses_previos + coalesce(tx.intereses, 0))::bigint as interest_paid_cents,
       case when l.status = 'ACTIVO' then s.intereses_pendientes else 0 end::bigint
         as interest_pending_cents,
       coalesce(tx.comisiones, 0)::bigint as fees_paid_cents,
       (s.intereses_previos + coalesce(tx.intereses, 0)
         + case when l.status = 'ACTIVO' then s.intereses_pendientes else 0 end
         + coalesce(tx.comisiones, 0))::bigint as total_cost_cents,
       case when l.status = 'ACTIVO' then s.siguiente end as next_period,
       case when l.status = 'ACTIVO' then s.siguiente_fecha end as next_due_on,
       case when l.status = 'ACTIVO' then s.siguiente_cuota end as next_payment_cents,
       s.fecha_fin as end_on,
       l.closed_on,
       l.interest_category_id
from public.loan l
cross join lateral (
  select max(p.payment_cents) filter (where p.period = 1) as cuota,
         max(p.payment_cents) filter (where p.period = l.term_months) as ultima,
         sum(p.interest_cents)::bigint as intereses_totales,
         coalesce(sum(p.interest_cents) filter (where p.period < l.tracked_from_period), 0)::bigint
           as intereses_previos,
         coalesce(sum(p.interest_cents) filter (where p.period > l.last_generated_period), 0)::bigint
           as intereses_pendientes,
         coalesce(max(p.balance_after_cents) filter (where p.period = l.last_generated_period),
                  l.principal_cents) as pendiente_cuadro,
         min(p.period) filter (where p.period > l.last_generated_period) as siguiente,
         (array_agg(p.due_on order by p.period) filter (where p.period > l.last_generated_period))[1]
           as siguiente_fecha,
         (array_agg(p.payment_cents order by p.period) filter (where p.period > l.last_generated_period))[1]
           as siguiente_cuota,
         max(p.due_on) as fecha_fin
  from public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
) s
cross join lateral (
  select public.loan_tae(l.principal_cents, l.term_months, l.tin_pct, l.opening_fee_cents) as calc
) tae
left join public.v_account_balance b
  on b.account_id = l.liability_account_id and b.user_id = l.user_id
left join lateral (
  select sum(t.amount_cents) filter (where t.loan_part = 'INTERESES') as intereses,
         sum(t.amount_cents) filter (where t.loan_part in ('COMISION', 'COMISION_CANCELACION')) as comisiones
  from public.transaction t
  where t.user_id = l.user_id and t.loan_id = l.id and t.status <> 'DISCARDED'
) tx on true;

comment on view public.v_loan_status is
  'Resumen por préstamo. principal_pending_cents = −saldo de la cuenta-pasivo (derivado). Cuotas pagadas = last_generated_period (incluye las previas al alta).';


-- ===========================================================================
-- Patrimonio: la deuda, aparte.
--
-- La cuenta-pasivo ya restaba en el total (es una cuenta más que no es de
-- inversión), pero dentro de «caja»: 1.000 € en el banco y 10.000 € de deuda
-- salían como −9.000 € de caja. Ahora la caja son solo las cuentas de dinero y
-- la deuda va en su propia columna, `debt_cents` (≤ 0). El total no cambia:
--   patrimonio = caja + invertido + sin desplegar + deuda.
-- Para quien no tiene préstamos, `debt_cents` = 0 y todo da lo mismo que antes.
-- ===========================================================================
create or replace view public.v_net_worth with (security_invoker = true) as
with caja as (
  select b.user_id, coalesce(sum(b.balance_cents), 0)::bigint as cents
  from public.v_account_balance b
  where b.type <> 'INVERSION' and b.type::text <> 'PRESTAMO'
  group by b.user_id
),
invertido as (
  select v.user_id, coalesce(sum(v.value_cents), 0)::bigint as cents
  from public.v_position_value v
  where not v.archived
  group by v.user_id
),
sin_desplegar as (
  select b.user_id,
         coalesce(sum(b.balance_cents), 0)::bigint - coalesce(sum(a.aportado), 0)::bigint as cents
  from public.v_account_balance b
  left join lateral (
    select coalesce(sum(c.contributed_cents), 0) as aportado
    from public.v_position_contributions c
    join public.investment_position p on p.id = c.position_id
    where p.account_id = b.account_id
  ) a on true
  where b.type = 'INVERSION'
  group by b.user_id
),
deuda as (
  select b.user_id, coalesce(sum(b.balance_cents), 0)::bigint as cents
  from public.v_account_balance b
  where b.type::text = 'PRESTAMO'
  group by b.user_id
)
select coalesce(caja.user_id, invertido.user_id, sin_desplegar.user_id, deuda.user_id) as user_id,
       coalesce(caja.cents, 0) + coalesce(invertido.cents, 0) + coalesce(sin_desplegar.cents, 0)
         + coalesce(deuda.cents, 0) as net_worth_cents,
       coalesce(caja.cents, 0) as cash_cents,
       coalesce(invertido.cents, 0) as invested_cents,
       coalesce(sin_desplegar.cents, 0) as idle_cents,
       coalesce(deuda.cents, 0) as debt_cents
from caja
full join invertido using (user_id)
full join sin_desplegar using (user_id)
full join deuda using (user_id);


-- Las curvas de patrimonio, con la misma separación. Cambia el tipo devuelto
-- (una columna más), así que hay que borrarlas y crearlas de nuevo.
-- net_worth_history lee de net_worth_monthly por nombre y no se toca.
drop function public.net_worth_monthly(integer);
drop function public.net_worth_daily(date, date);

create function public.net_worth_monthly(p_months integer default 12)
returns table (
  period_month    date,
  net_worth_cents bigint,
  cash_cents      bigint,
  invested_cents  bigint,
  idle_cents      bigint,
  debt_cents      bigint
)
language sql
stable
set search_path = ''
as $$
  with cierres as (
    select m::date as mes,
           (m + interval '1 month' - interval '1 day')::date as fin
    from generate_series(
           date_trunc('month', current_date) - make_interval(months => least(greatest(p_months, 1), 600) - 1),
           date_trunc('month', current_date),
           interval '1 month'
         ) m
  ),
  valores as (
    select w.fecha,
           sum(w.worth_cents) as total,
           sum(w.balance_cents) filter (where w.type <> 'INVERSION' and w.type::text <> 'PRESTAMO') as caja,
           sum(w.posiciones_cents) as invertido,
           sum(w.balance_cents - w.aportado_cents) filter (where w.type = 'INVERSION') as sin_desplegar,
           sum(w.balance_cents) filter (where w.type::text = 'PRESTAMO') as deuda
    from private.account_worth_on((select array_agg(c.fin) from cierres c)) w
    group by w.fecha
  )
  select c.mes,
         coalesce(v.total, 0)::bigint,
         coalesce(v.caja, 0)::bigint,
         coalesce(v.invertido, 0)::bigint,
         coalesce(v.sin_desplegar, 0)::bigint,
         coalesce(v.deuda, 0)::bigint
  from cierres c
  left join valores v on v.fecha = c.fin
  order by c.mes;
$$;

create function public.net_worth_daily(p_desde date, p_hasta date)
returns table (
  fecha           date,
  net_worth_cents bigint,
  cash_cents      bigint,
  invested_cents  bigint,
  idle_cents      bigint,
  debt_cents      bigint
)
language sql
stable
set search_path = ''
as $$
  with dias as (
    select (p_desde + g.n)::date as dia
    from generate_series(
           0,
           (least(p_hasta, current_date, p_desde + 1826) - p_desde)
         ) as g(n)
  ),
  valores as (
    select w.fecha,
           sum(w.worth_cents) as total,
           sum(w.balance_cents) filter (where w.type <> 'INVERSION' and w.type::text <> 'PRESTAMO') as caja,
           sum(w.posiciones_cents) as invertido,
           sum(w.balance_cents - w.aportado_cents) filter (where w.type = 'INVERSION') as sin_desplegar,
           sum(w.balance_cents) filter (where w.type::text = 'PRESTAMO') as deuda
    from private.account_worth_on((select array_agg(d.dia) from dias d)) w
    group by w.fecha
  )
  select d.dia,
         coalesce(v.total, 0)::bigint,
         coalesce(v.caja, 0)::bigint,
         coalesce(v.invertido, 0)::bigint,
         coalesce(v.sin_desplegar, 0)::bigint,
         coalesce(v.deuda, 0)::bigint
  from dias d
  left join valores v on v.fecha = d.dia
  order by d.dia;
$$;

revoke all on function public.net_worth_monthly(integer) from public, anon;
revoke all on function public.net_worth_daily(date, date) from public, anon;
grant execute on function public.net_worth_monthly(integer) to authenticated, service_role;
grant execute on function public.net_worth_daily(date, date) to authenticated, service_role;
