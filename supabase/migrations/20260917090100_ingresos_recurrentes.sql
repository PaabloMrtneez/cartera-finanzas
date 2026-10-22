-- ===========================================================================
-- Ingresos recurrentes: la nómina, un alquiler que cobras, una pensión. El
-- espejo de las suscripciones, pero de INGRESO: mismo compromiso periódico,
-- misma generación automática de movimientos, mismos helpers de periodicidad
-- (`private.next_charge`, `private.charges_per_year`).
--
-- Es una tabla NUEVA, no un campo en `subscription`: así no se toca nada de la
-- lógica de gasto ya probada (ni la generación, ni la previsión, ni las vistas),
-- y «nómina» no acaba disfrazada de «suscripción». Comparte solo lo que es
-- direccionalmente neutro: el enum de periodicidad y su aritmética.
--
-- La recompensa está en la previsión: con esto, `pending_recurring_income` deja
-- calcular el balance previsto de fin de mes (ingresos − gasto), no solo el
-- gasto. Ver su uso en la pantalla.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- La tabla. Calcada de `subscription` (schema.sql), con el CHECK de categoría
-- invertido a INGRESO y `next_income_date` en vez de `next_charge_date`.
-- ---------------------------------------------------------------------------
create table public.recurring_income (
  id                uuid not null default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  description       text not null,
  amount_cents      bigint not null,
  periodicity       public.periodicity not null,
  next_income_date  date not null,
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

  constraint rincome_desc_len         check (length(btrim(description)) between 1 and 60),
  constraint rincome_amount_positive  check (amount_cents > 0),
  constraint rincome_category_pair    check ((category_id is null) = (category_type is null)),
  -- Un ingreso recurrente solo cuelga de una categoría de INGRESO.
  constraint rincome_category_income  check (category_type is null or category_type = 'INCOME'),
  constraint rincome_next_after_start check (next_income_date >= started_at),

  foreign key (user_id, account_id)
    references public.account (user_id, id) on delete restrict,
  foreign key (user_id, category_id, category_type)
    references public.category (user_id, id, type) on delete set null (category_id, category_type)
);

create trigger recurring_income_touch before update on public.recurring_income
  for each row execute function private.tg_touch_updated_at();


-- ---------------------------------------------------------------------------
-- El enganche en `transaction`: espejo de `subscription_id`. El índice único
-- (user_id, recurring_income_id, occurred_on) hace la generación idempotente,
-- igual que el de suscripciones evita cobrar dos veces.
-- ---------------------------------------------------------------------------
alter table public.transaction add column recurring_income_id uuid;

alter table public.transaction
  add constraint transaction_recurring_income_fk
  foreign key (user_id, recurring_income_id)
  references public.recurring_income (user_id, id) on delete set null (recurring_income_id);

create index tx_recurring_income_idx
  on public.transaction (user_id, recurring_income_id) where recurring_income_id is not null;

create unique index tx_recurring_income_period_uq
  on public.transaction (user_id, recurring_income_id, occurred_on) where recurring_income_id is not null;


-- ---------------------------------------------------------------------------
-- Seguridad a nivel de fila: las cuatro políticas, como toda tabla del usuario.
-- ---------------------------------------------------------------------------
alter table public.recurring_income enable row level security;
alter table public.recurring_income force row level security;
revoke all on table public.recurring_income from anon;

create policy recurring_income_sel on public.recurring_income for select to authenticated
  using (user_id = (select private.current_user_id()));
create policy recurring_income_ins on public.recurring_income for insert to authenticated
  with check (user_id = (select private.current_user_id()));
create policy recurring_income_upd on public.recurring_income for update to authenticated
  using (user_id = (select private.current_user_id()))
  with check (user_id = (select private.current_user_id()));
create policy recurring_income_del on public.recurring_income for delete to authenticated
  using (user_id = (select private.current_user_id()));

revoke update (user_id) on public.recurring_income from authenticated;


-- ---------------------------------------------------------------------------
-- Resumen de lo que ingresas de forma periódica. Espejo de v_subscription_summary.
-- ---------------------------------------------------------------------------
create view public.v_recurring_income_summary with (security_invoker = true) as
select r.user_id,
       r.id,
       r.description,
       r.amount_cents,
       r.periodicity,
       r.next_income_date,
       r.category_id,
       r.account_id,
       r.active,
       r.started_at,
       r.amount_cents * private.charges_per_year(r.periodicity) as yearly_cents,
       round(r.amount_cents * private.charges_per_year(r.periodicity) / 12.0)::bigint as monthly_cents,
       (r.next_income_date <= current_date) as due
from public.recurring_income r;


-- ---------------------------------------------------------------------------
-- Genera los movimientos de INGRESO cuya fecha ya ha pasado. Idéntica a
-- generate_subscription_charges, con type='INCOME' y recurring_income_id. Si un
-- ingreso llevaba meses sin generarse, recupera todos los atrasados uno a uno.
-- ---------------------------------------------------------------------------
create or replace function public.generate_recurring_income()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
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
    where user_id = v_user and active and next_income_date <= current_date
  loop
    v_fecha := v_r.next_income_date;
    v_vueltas := 0;

    while v_fecha <= current_date and v_vueltas < 400 loop
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

      v_fecha := private.next_charge(v_fecha, v_r.periodicity);
      v_vueltas := v_vueltas + 1;
    end loop;

    update public.recurring_income
       set next_income_date = v_fecha,
           last_generated_on = current_date
     where id = v_r.id;
  end loop;

  return v_creados;
end $$;


-- ---------------------------------------------------------------------------
-- Próximos ingresos de los siguientes N días. Espejo de upcoming_charges.
-- ---------------------------------------------------------------------------
create or replace function public.upcoming_income(p_days integer default 60)
returns table (
  recurring_income_id uuid,
  description         text,
  amount_cents        bigint,
  income_date         date,
  category_id         uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive futuros as (
    select r.id, r.description, r.amount_cents, r.next_income_date as fecha,
           r.periodicity, r.category_id, 1 as vuelta
    from public.recurring_income r
    where r.active
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


-- ---------------------------------------------------------------------------
-- Los ingresos recurrentes que faltan por entrar ESTE mes. Es la pieza que
-- convierte la previsión de gasto en un balance: la pantalla suma
--   (ingresos reales + esto)  −  previsión de gasto.
-- Mismo gate del mes en curso que `month_forecast` para las suscripciones: fuera
-- del mes en curso no hay «pendiente», así que da 0.
-- ---------------------------------------------------------------------------
create or replace function public.pending_recurring_income(p_month date)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  with marco as (
    select date_trunc('month', p_month::timestamp)::date as mes,
           (date_trunc('month', p_month::timestamp) + interval '1 month' - interval '1 day')::date
             as fin_mes
  )
  select coalesce(sum(u.amount_cents), 0)::bigint
  from marco m
  left join lateral (
    select uc.amount_cents
    from public.upcoming_income(greatest(0, (m.fin_mes - current_date))::int) uc
    where m.mes = date_trunc('month', current_date)::date
      and uc.income_date <= m.fin_mes
  ) u on true;
$$;

comment on function public.pending_recurring_income is
  'Ingresos recurrentes que faltan por entrar este mes (0 fuera del mes en curso). Con los ingresos reales y la previsión de gasto, da el balance previsto de fin de mes.';
