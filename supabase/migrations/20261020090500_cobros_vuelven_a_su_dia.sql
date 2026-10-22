-- ===========================================================================
-- Los cobros del 29, 30 y 31 vuelven a su día en los meses largos.
--
-- Cierre de la v1: hallazgo M5 de docs/pruebas/informe-datos.md (H-09 de
-- informe-robustez.md, lado SQL). Prueba: scripts/test-dia-ancla.mjs y
-- test-casos-limite.mjs.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- private.next_charge calcula el siguiente cobro desde el ANTERIOR, que ya
-- viene recortado: 31 ene + 1 mes = 28 feb, 28 feb + 1 mes = 28 mar… y el
-- cobro se queda en el 28 para siempre. Igual el anual del 29 de febrero (no
-- vuelve al 29 en 2028) y los ingresos fijos.
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
--  1. Una columna `anchor_day` (1-31) en subscription y recurring_income: el
--     día del mes en que se cobra cuando el mes lo tiene. La rellena un
--     disparador: al crear, el día de la fecha del próximo cobro —o el de
--     started_at si esa fecha es un fin de mes recortado (alta el 31 de enero
--     con el próximo el 28 de febrero)—; al cambiar la fecha a mano, el de la
--     fecha nueva. Cuando la avanza el generador, el ancla NO cambia.
--  2. private.next_charge(fecha, periodicidad, ancla): suma el periodo y pone
--     el día ancla, recortado al último día del mes si no lo tiene. Es lo que
--     hace Postgres al sumar meses, pero desde el ancla y no desde la fecha
--     recortada: 31 ene → 28 feb → 31 mar → 30 abr… Semanal: +7 días.
--     La versión de dos argumentos se conserva (otras funciones o código
--     antiguo la pueden llamar) y da lo mismo que antes.
--  3. Los generadores (cargos e ingresos fijos), los próximos cargos/ingresos
--     y el alta de gasto con suscripción usan el ancla.
--  4. Las filas existentes: ancla = el día de su próximo cobro, salvo que ya
--     haya derivado (próximo cobro en un día 28-30 menor que el de started_at:
--     entonces el de started_at, y el próximo cobro se recoloca en ese mismo
--     mes si el mes lo tiene). En producción no había ninguna suscripción ni
--     ingreso fijo.
--
-- El lado TypeScript (nextCharge en src/lib/dates.ts) debe hacer lo mismo con
-- el ancla.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. El cálculo.
-- ---------------------------------------------------------------------------
create or replace function private.next_charge(p_date date, p_period public.periodicity, p_anchor smallint)
returns date
language sql
immutable
parallel safe
set search_path = ''
as $$
  with paso as (
    select case p_period
             when 'MENSUAL'    then p_date + interval '1 month'
             when 'TRIMESTRAL' then p_date + interval '3 months'
             when 'ANUAL'      then p_date + interval '1 year'
           end::date as d
  )
  select case
           when p_period = 'SEMANAL' then p_date + 7
           when p_anchor is null then paso.d
           else pg_catalog.make_date(
                  extract(year from paso.d)::integer,
                  extract(month from paso.d)::integer,
                  least(p_anchor::integer,
                        extract(day from (date_trunc('month', paso.d) + interval '1 month - 1 day'))::integer))
         end
  from paso;
$$;

comment on function private.next_charge(date, public.periodicity, smallint) is
  'Siguiente cobro tras p_date: suma el periodo y pone el día ancla (recortado al último día del mes si no lo tiene).';

-- El ancla de una fila nueva (o sin ancla): el día del próximo cobro, salvo que
-- este sea un fin de mes recortado de un día mayor de started_at.
create or replace function private.ancla_inicial(p_next date, p_started date, p_period public.periodicity)
returns smallint
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
           when p_period <> 'SEMANAL'
                and p_started is not null
                and extract(day from p_started) > extract(day from p_next)
                and p_next = (date_trunc('month', p_next) + interval '1 month - 1 day')::date
             then extract(day from p_started)
           else extract(day from p_next)
         end::smallint;
$$;

revoke all on function private.next_charge(date, public.periodicity, smallint) from public;
revoke all on function private.ancla_inicial(date, date, public.periodicity) from public;
grant execute on function private.next_charge(date, public.periodicity, smallint) to authenticated, service_role;
grant execute on function private.ancla_inicial(date, date, public.periodicity) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. La columna, rellena para las filas que ya hay.
-- ---------------------------------------------------------------------------
alter table public.subscription     add column anchor_day smallint;
alter table public.recurring_income add column anchor_day smallint;

-- Una fila que ya derivó (el 31 que se quedó en el 28 desde febrero) tiene el
-- próximo cobro en un día 28-30 menor que el de started_at: vuelve al de
-- started_at. Las demás, el día de su próximo cobro.
update public.subscription
   set anchor_day = case
         when periodicity <> 'SEMANAL'
              and extract(day from next_charge_date) >= 28
              and extract(day from started_at) > extract(day from next_charge_date)
           then extract(day from started_at)
         else extract(day from next_charge_date)
       end::smallint;
update public.recurring_income
   set anchor_day = case
         when periodicity <> 'SEMANAL'
              and extract(day from next_income_date) >= 28
              and extract(day from started_at) > extract(day from next_income_date)
           then extract(day from started_at)
         else extract(day from next_income_date)
       end::smallint;

-- Un próximo cobro recortado se recoloca en su día ancla si su mes lo tiene
-- (no cambia nada en los meses cortos: ahí el recorte es el día correcto).
update public.subscription
   set next_charge_date = pg_catalog.make_date(
         extract(year from next_charge_date)::integer, extract(month from next_charge_date)::integer,
         least(anchor_day::integer, extract(day from (date_trunc('month', next_charge_date) + interval '1 month - 1 day'))::integer))
 where anchor_day > extract(day from next_charge_date);
update public.recurring_income
   set next_income_date = pg_catalog.make_date(
         extract(year from next_income_date)::integer, extract(month from next_income_date)::integer,
         least(anchor_day::integer, extract(day from (date_trunc('month', next_income_date) + interval '1 month - 1 day'))::integer))
 where anchor_day > extract(day from next_income_date);

alter table public.subscription
  alter column anchor_day set not null,
  add constraint sub_anchor_day check (anchor_day between 1 and 31);
alter table public.recurring_income
  alter column anchor_day set not null,
  add constraint rincome_anchor_day check (anchor_day between 1 and 31);

comment on column public.subscription.anchor_day is
  'Día del mes en que se cobra cuando el mes lo tiene (31 → 28/29 feb, 30 abr, 31 may…). Lo mantiene un disparador.';
comment on column public.recurring_income.anchor_day is
  'Día del mes en que se cobra cuando el mes lo tiene (31 → 28/29 feb, 30 abr, 31 may…). Lo mantiene un disparador.';

-- ---------------------------------------------------------------------------
-- 3. Quién pone el ancla: el alta y el cambio de fecha a mano; el generador no.
-- ---------------------------------------------------------------------------
create or replace function private.tg_ancla_suscripcion()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.anchor_day := coalesce(new.anchor_day,
                               private.ancla_inicial(new.next_charge_date, new.started_at, new.periodicity));
  elsif new.next_charge_date is distinct from old.next_charge_date
        and new.anchor_day is not distinct from old.anchor_day
        and coalesce(pg_catalog.current_setting('cartera.generando_cargos', true), '') <> 'on' then
    -- La fecha la ha cambiado alguien a mano: manda el día nuevo.
    new.anchor_day := extract(day from new.next_charge_date)::smallint;
  end if;
  return new;
end $$;

create or replace function private.tg_ancla_ingreso()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.anchor_day := coalesce(new.anchor_day,
                               private.ancla_inicial(new.next_income_date, new.started_at, new.periodicity));
  elsif new.next_income_date is distinct from old.next_income_date
        and new.anchor_day is not distinct from old.anchor_day
        and coalesce(pg_catalog.current_setting('cartera.generando_cargos', true), '') <> 'on' then
    new.anchor_day := extract(day from new.next_income_date)::smallint;
  end if;
  return new;
end $$;

create trigger subscription_anchor_day
  before insert or update of next_charge_date on public.subscription
  for each row execute function private.tg_ancla_suscripcion();
create trigger recurring_income_anchor_day
  before insert or update of next_income_date on public.recurring_income
  for each row execute function private.tg_ancla_ingreso();

-- ---------------------------------------------------------------------------
-- 4. Los que calculan cobros: la definición vigente, con el ancla.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_expense_with_subscription(p_amount_cents bigint, p_description text, p_occurred_on date, p_account_id uuid, p_category_id uuid, p_periodicity public.periodicity, p_note text DEFAULT NULL::text, p_occurred_time time without time zone DEFAULT '00:00:00'::time without time zone)
 RETURNS TABLE(transaction_id uuid, subscription_id uuid, next_charge_date date)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user     uuid := (select private.current_user_id());
  v_cat_type public.entry_type;
  v_sub      uuid;
  v_tx       uuid;
  v_siguiente date;
begin
  if v_user is null then
    raise exception 'Sesión no válida';
  end if;

  -- El tipo de la categoría se lee de la propia categoría, no se recibe: es lo
  -- que impide colgar un gasto de una categoría de ingresos, porque la clave
  -- foránea compuesta comprueba el par (id, tipo).
  if p_category_id is not null then
    select c.type into v_cat_type
    from public.category c
    where c.id = p_category_id and c.user_id = v_user;

    if v_cat_type is null then
      raise exception 'La categoría no existe';
    end if;
    if v_cat_type <> 'EXPENSE' then
      raise exception 'Una suscripción solo puede colgar de una categoría de gasto';
    end if;
  end if;

  v_siguiente := private.next_charge(p_occurred_on, p_periodicity, extract(day from p_occurred_on)::smallint);

  insert into public.subscription (
    user_id, description, amount_cents, periodicity,
    next_charge_date, started_at, account_id, category_id, category_type, active
  )
  values (
    v_user, p_description, p_amount_cents, p_periodicity,
    v_siguiente, p_occurred_on, p_account_id, p_category_id, v_cat_type, true
  )
  returning id into v_sub;

  insert into public.transaction (
    user_id, type, amount_cents, description, occurred_on, occurred_time,
    account_id, category_id, category_type, note,
    source, status, subscription_id
  )
  values (
    v_user, 'EXPENSE', p_amount_cents, p_description, p_occurred_on, p_occurred_time,
    p_account_id, p_category_id, v_cat_type, p_note,
    'MANUAL', 'CONFIRMED', v_sub
  )
  returning id into v_tx;

  return query select v_tx, v_sub, v_siguiente;
end;
$function$;

CREATE OR REPLACE FUNCTION public.upcoming_charges(p_days integer DEFAULT 60)
 RETURNS TABLE(subscription_id uuid, description text, amount_cents bigint, charge_date date, category_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with recursive futuros as (
    select s.id, s.description, s.amount_cents, s.next_charge_date as fecha,
           s.periodicity, s.anchor_day, s.category_id, 1 as vuelta
    from public.subscription s
    where s.active
    union all
    select f.id, f.description, f.amount_cents,
           private.next_charge(f.fecha, f.periodicity, f.anchor_day),
           f.periodicity, f.anchor_day, f.category_id, f.vuelta + 1
    from futuros f
    where private.next_charge(f.fecha, f.periodicity, f.anchor_day) <= private.hoy() + p_days
      and f.vuelta < 60
  )
  select id, description, amount_cents, fecha, category_id
  from futuros
  where fecha between private.hoy() and private.hoy() + p_days
  order by fecha, description;
$function$;

CREATE OR REPLACE FUNCTION public.upcoming_income(p_days integer DEFAULT 60)
 RETURNS TABLE(recurring_income_id uuid, description text, amount_cents bigint, income_date date, category_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with recursive futuros as (
    select r.id, r.description, r.amount_cents, r.next_income_date as fecha,
           r.periodicity, r.anchor_day, r.category_id, 1 as vuelta
    from public.recurring_income r
    where r.active
    union all
    select f.id, f.description, f.amount_cents,
           private.next_charge(f.fecha, f.periodicity, f.anchor_day),
           f.periodicity, f.anchor_day, f.category_id, f.vuelta + 1
    from futuros f
    where private.next_charge(f.fecha, f.periodicity, f.anchor_day) <= private.hoy() + p_days
      and f.vuelta < 60
  )
  select id, description, amount_cents, fecha, category_id
  from futuros
  where fecha between private.hoy() and private.hoy() + p_days
  order by fecha, description;
$function$;

CREATE OR REPLACE FUNCTION public.generate_subscription_charges()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user   uuid := (select private.current_user_id());
  v_sub    record;
  v_fecha  date;
  v_creados integer := 0;
  v_vueltas integer;
begin
  if v_user is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  for v_sub in
    select * from public.subscription
    where user_id = v_user and active and next_charge_date <= private.hoy()
  loop
    v_fecha := v_sub.next_charge_date;
    v_vueltas := 0;

    -- Tope de seguridad: si una fecha quedara mal, esto evita un bucle eterno.
    while v_fecha <= private.hoy() and v_vueltas < 400 loop
      begin
        insert into public.transaction (
          user_id, type, amount_cents, description, occurred_on,
          account_id, category_id, category_type,
          source, status, subscription_id
        )
        values (
          v_user, 'EXPENSE', v_sub.amount_cents, v_sub.description, v_fecha,
          v_sub.account_id, v_sub.category_id, v_sub.category_type,
          'RECURRING', 'CONFIRMED', v_sub.id
        );
        v_creados := v_creados + 1;
      exception when unique_violation then
        -- Ya existía ese cargo: se pasa al siguiente sin ruido.
        null;
      end;

      v_fecha := private.next_charge(v_fecha, v_sub.periodicity, v_sub.anchor_day);
      v_vueltas := v_vueltas + 1;
    end loop;

    -- El generador avanza la fecha sin tocar el ancla (ver tg_ancla_suscripcion).
    perform set_config('cartera.generando_cargos', 'on', true);
    update public.subscription
       set next_charge_date = v_fecha,
           last_generated_on = private.hoy()
     where id = v_sub.id;
    perform set_config('cartera.generando_cargos', '', true);
  end loop;

  return v_creados;
end $function$;

CREATE OR REPLACE FUNCTION public.generate_recurring_income()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user    uuid := (select private.current_user_id());
  v_r       record;
  v_fecha   date;
  v_creados integer := 0;
  v_vueltas integer;
begin
  if v_user is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  for v_r in
    select * from public.recurring_income
    where user_id = v_user and active and next_income_date <= private.hoy()
  loop
    v_fecha := v_r.next_income_date;
    v_vueltas := 0;

    while v_fecha <= private.hoy() and v_vueltas < 400 loop
      begin
        insert into public.transaction (
          user_id, type, amount_cents, description, occurred_on,
          account_id, category_id, category_type,
          source, status, recurring_income_id
        )
        values (
          v_user, 'INCOME', v_r.amount_cents, v_r.description, v_fecha,
          v_r.account_id, v_r.category_id, v_r.category_type,
          'RECURRING', 'CONFIRMED', v_r.id
        );
        v_creados := v_creados + 1;
      exception when unique_violation then
        null;
      end;

      v_fecha := private.next_charge(v_fecha, v_r.periodicity, v_r.anchor_day);
      v_vueltas := v_vueltas + 1;
    end loop;

    perform set_config('cartera.generando_cargos', 'on', true);
    update public.recurring_income
       set next_income_date = v_fecha,
           last_generated_on = private.hoy()
     where id = v_r.id;
    perform set_config('cartera.generando_cargos', '', true);
  end loop;

  return v_creados;
end $function$;

