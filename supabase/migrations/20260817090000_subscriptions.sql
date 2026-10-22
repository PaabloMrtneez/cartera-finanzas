-- ===========================================================================
-- Suscripciones: compromiso mensual y generación de cargos pendientes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Cuántos cargos al año genera cada periodicidad. Se usa para anualizar y para
-- normalizar todo a mensual, que es como se compara.
-- ---------------------------------------------------------------------------
create or replace function private.charges_per_year(p public.periodicity)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p
           when 'SEMANAL'    then 52
           when 'MENSUAL'    then 12
           when 'TRIMESTRAL' then 4
           when 'ANUAL'      then 1
         end;
$$;

grant execute on function private.charges_per_year(public.periodicity) to authenticated;


-- ---------------------------------------------------------------------------
-- Resumen de lo que estás comprometido a pagar.
--
-- Las pausadas no cuentan: en pausa una suscripción deja de generar movimientos
-- y sale del compromiso.
-- ---------------------------------------------------------------------------
create view public.v_subscription_summary with (security_invoker = true) as
select s.user_id,
       s.id,
       s.description,
       s.amount_cents,
       s.periodicity,
       s.next_charge_date,
       s.category_id,
       s.account_id,
       s.active,
       s.started_at,
       -- Anualizado: el importe por los cargos que toca al año.
       s.amount_cents * private.charges_per_year(s.periodicity) as yearly_cents,
       -- Normalizado a mes, para poder sumar peras con manzanas.
       round(s.amount_cents * private.charges_per_year(s.periodicity) / 12.0)::bigint
         as monthly_cents,
       (s.next_charge_date <= current_date) as due
from public.subscription s;


-- ---------------------------------------------------------------------------
-- Avanza una fecha de cargo según la periodicidad.
-- ---------------------------------------------------------------------------
create or replace function private.next_charge(p_date date, p_period public.periodicity)
returns date
language sql
immutable
set search_path = ''
as $$
  select case p_period
           when 'SEMANAL'    then p_date + interval '1 week'
           when 'MENSUAL'    then p_date + interval '1 month'
           when 'TRIMESTRAL' then p_date + interval '3 months'
           when 'ANUAL'      then p_date + interval '1 year'
         end::date;
$$;


-- ---------------------------------------------------------------------------
-- Genera los movimientos de las suscripciones cuya fecha ya ha pasado.
--
-- Cada movimiento nace con `source = RECURRING` y apunta a su suscripción, y el
-- índice único (user_id, subscription_id, occurred_on) hace imposible duplicarlo
-- por darle dos veces al botón.
--
-- Si una suscripción llevaba meses sin generarse, se recuperan todos los cargos
-- atrasados uno a uno, no solo el último: el histórico debe cuadrar.
-- ---------------------------------------------------------------------------
create or replace function public.generate_subscription_charges()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
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
    where user_id = v_user and active and next_charge_date <= current_date
  loop
    v_fecha := v_sub.next_charge_date;
    v_vueltas := 0;

    -- Tope de seguridad: si una fecha quedara mal, esto evita un bucle eterno.
    while v_fecha <= current_date and v_vueltas < 400 loop
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

      v_fecha := private.next_charge(v_fecha, v_sub.periodicity);
      v_vueltas := v_vueltas + 1;
    end loop;

    update public.subscription
       set next_charge_date = v_fecha,
           last_generated_on = current_date
     where id = v_sub.id;
  end loop;

  return v_creados;
end $$;


-- ---------------------------------------------------------------------------
-- Próximos cargos de los siguientes N días, para el calendario de escritorio.
-- ---------------------------------------------------------------------------
create or replace function public.upcoming_charges(p_days integer default 60)
returns table (
  subscription_id uuid,
  description     text,
  amount_cents    bigint,
  charge_date     date,
  category_id     uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive futuros as (
    select s.id, s.description, s.amount_cents, s.next_charge_date as fecha,
           s.periodicity, s.category_id, 1 as vuelta
    from public.subscription s
    where s.active
    union all
    select f.id, f.description, f.amount_cents,
           private.next_charge(f.fecha, f.periodicity),
           f.periodicity, f.category_id, f.vuelta + 1
    from futuros f
    where private.next_charge(f.fecha, f.periodicity) <= current_date + p_days
      and f.vuelta < 60
  )
  select id, description, amount_cents, fecha, category_id
  from futuros
  where fecha between current_date and current_date + p_days
  order by fecha, description;
$$;

grant execute on function private.next_charge(date, public.periodicity) to authenticated;
