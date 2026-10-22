-- ===========================================================================
-- Un solo reloj: «hoy» es el día de Madrid en TODA la capa de datos.
--
-- Cierre de la v1: hallazgo M4 de docs/pruebas/informe-datos.md (H-07 de
-- informe-robustez.md, lado SQL). Prueba: scripts/test-reloj-madrid.mjs.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- La base trabaja en UTC. `current_date` (UTC) estaba en 22 funciones, 5
-- vistas, 5 CHECK y 3 valores por defecto; los préstamos, los avisos y la
-- ingesta usaban `(now() at time zone 'Europe/Madrid')::date`. Entre las 00:00
-- y las 01:00/02:00 de Madrid los dos «hoy» discrepan:
--   · el día 1 a las 00:30, el mes en curso para la previsión, el ritmo, los
--     meses cerrados o la curva de patrimonio todavía es el ANTERIOR;
--   · una valoración o un alta de fondo con fecha de hoy se rechaza por «futura»
--     (valuation_not_future, unit_event_date: CHECK con current_date);
--   · una cuota de préstamo de hoy ya está generada (Madrid) pero los cargos de
--     las suscripciones de hoy todavía no (UTC).
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
--  1. private.hoy() = el día de hoy en Europe/Madrid. Estable (como
--     current_date: un valor por sentencia). Es la ÚNICA fuente de «hoy» de la
--     base. El lado TypeScript (todayIso() en src/lib/dates.ts) usa la misma
--     zona, 'Europe/Madrid'.
--  2. Todas las funciones y vistas que leían current_date (o la expresión de
--     Madrid escrita a mano) se redefinen IGUAL, cambiando solo eso por
--     private.hoy(). El texto de abajo se generó desde las definiciones
--     vigentes (pg_get_functiondef / pg_get_viewdef) con esa única sustitución;
--     la prueba comprueba que, tras aplicarla, ninguna función ni vista de
--     public/private menciona current_date.
--  3. Los CHECK de fecha y los valores por defecto de fecha, también con
--     private.hoy(). Madrid va siempre por delante de UTC, así que ninguna fila
--     que cumpliera el CHECK viejo deja de cumplir el nuevo.
--
-- `create or replace` conserva dueño, permisos, security invoker/definer y
-- search_path; las vistas conservan security_invoker = true (se repite).
-- Ninguna firma cambia.
-- ===========================================================================

create or replace function private.hoy()
returns date
language sql
stable
parallel safe
set search_path = ''
as $$
  select (pg_catalog.now() at time zone 'Europe/Madrid')::date;
$$;

comment on function private.hoy() is
  'El día de hoy en Europe/Madrid: la única fuente de «hoy» de la base (y la misma zona que todayIso() en la app).';

revoke all on function private.hoy() from public;
-- authenticated la necesita para las vistas, las funciones invoker y los CHECK
-- que se evalúan con sus permisos; service_role, para los avisos y los crons.
grant execute on function private.hoy() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- CHECK y valores por defecto.
-- ---------------------------------------------------------------------------
alter table public.transaction drop constraint tx_date_sane;
alter table public.transaction add constraint tx_date_sane
  check (occurred_on >= date '2000-01-01' and occurred_on <= private.hoy() + 400);

alter table public.valuation drop constraint valuation_not_future;
alter table public.valuation add constraint valuation_not_future
  check (date <= private.hoy());

alter table public.position_unit_event drop constraint unit_event_date;
alter table public.position_unit_event add constraint unit_event_date
  check (date between date '2000-01-01' and private.hoy());

alter table public.instrument_price drop constraint instrument_price_date;
alter table public.instrument_price add constraint instrument_price_date
  check (date >= date '1970-01-01' and date <= private.hoy() + 1);

alter table public.fx_rate drop constraint fx_rate_date;
alter table public.fx_rate add constraint fx_rate_date
  check (date >= date '1999-01-01' and date <= private.hoy() + 1);

alter table public.investment_position alter column since       set default private.hoy();
alter table public.subscription        alter column started_at  set default private.hoy();
alter table public.recurring_income    alter column started_at  set default private.hoy();

-- ---------------------------------------------------------------------------
-- Funciones y vistas: la definición vigente con current_date → private.hoy().
-- (Generado; no reformatear a mano.)
-- ---------------------------------------------------------------------------

-- ── Funciones (29) ──

-- private.loan_generate
CREATE OR REPLACE FUNCTION private.loan_generate(p_user uuid, p_loan uuid, p_hoy date, p_marcar boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_hoy     date := least(coalesce(p_hoy, private.hoy()),
                          private.hoy());
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
end $function$;

-- public.account_balance_history
CREATE OR REPLACE FUNCTION public.account_balance_history(p_months integer DEFAULT 6)
 RETURNS TABLE(period_month date, cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with cierres as (
    select m::date as mes,
           (m + interval '1 month' - interval '1 day')::date as fin
    from generate_series(
           date_trunc('month', private.hoy()) - make_interval(months => p_months - 1),
           date_trunc('month', private.hoy()),
           interval '1 month'
         ) m
  )
  select c.mes,
         (
           coalesce((select sum(a.initial_balance_cents) from public.account a), 0)
           + coalesce((
               select sum(v.delta_cents)
               from public.v_account_movement v
               where v.occurred_on <= c.fin
             ), 0)
         )::bigint
  from cierres c
  order by c.mes;
$function$;

-- public.account_balance_monthly
CREATE OR REPLACE FUNCTION public.account_balance_monthly(p_months integer DEFAULT 12)
 RETURNS TABLE(account_id uuid, name text, color text, type public.account_type, archived boolean, period_month date, balance_cents bigint, worth_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with cierres as (
    select m::date as mes,
           (m + interval '1 month' - interval '1 day')::date as fin
    from generate_series(
           date_trunc('month', private.hoy()) - make_interval(months => least(greatest(p_months, 1), 600) - 1),
           date_trunc('month', private.hoy()),
           interval '1 month'
         ) m
  )
  select a.id,
         a.name,
         a.color,
         a.type,
         a.archived,
         c.mes,
         w.balance_cents,
         w.worth_cents
  from private.account_worth_on((select array_agg(c2.fin) from cierres c2)) w
  join cierres c on c.fin = w.fecha
  join public.account a on a.id = w.account_id
  order by a.archived, a.name, a.id, c.mes;
$function$;

-- public.account_spend_history
CREATE OR REPLACE FUNCTION public.account_spend_history(p_months integer DEFAULT 6)
 RETURNS TABLE(account_id uuid, period_month date, gasto_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with meses as (
    select generate_series(
             (date_trunc('month', private.hoy()) - make_interval(months => p_months - 1))::date,
             date_trunc('month', private.hoy())::date,
             interval '1 month'
           )::date as mes
  ),
  -- Solo las cuentas con algún gasto en la ventana: una cuenta de ahorro sin
  -- cargos no aporta una tendencia de gasto que mirar.
  cuentas as (
    select t.account_id
    from public.transaction t, meses m
    where t.period_month = m.mes
      and t.type = 'EXPENSE'
      and t.status <> 'DISCARDED'
    group by t.account_id
    having sum(t.amount_cents) > 0
  )
  select c.account_id,
         m.mes,
         coalesce((
           select sum(t.amount_cents)
           from public.transaction t
           where t.account_id = c.account_id
             and t.period_month = m.mes
             and t.type = 'EXPENSE'
             and t.status <> 'DISCARDED'
         ), 0)::bigint
  from cuentas c
  cross join meses m
  order by c.account_id, m.mes;
$function$;

-- public.cancel_loan
CREATE OR REPLACE FUNCTION public.cancel_loan(p_loan_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select private.current_user_id());
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  update public.loan
     set status = 'CANCELADO', closed_on = private.hoy()
   where id = p_loan_id and user_id = v_uid and status = 'ACTIVO';

  if not found then
    raise exception 'Préstamo no encontrado o ya cerrado' using errcode = 'P0002';
  end if;
end $function$;

-- public.category_forecast
CREATE OR REPLACE FUNCTION public.category_forecast(p_month date)
 RETURNS TABLE(category_id uuid, name text, color text, icon text, cap_cents bigint, gastado_cents bigint, prevision_cents bigint, rebasa boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with marco as (
    select date_trunc('month', p_month::timestamp)::date as mes,
           (date_trunc('month', p_month::timestamp) + interval '1 month' - interval '1 day')::date
             as fin_mes
  ),
  dd as (
    select m.mes,
           m.fin_mes,
           extract(day from m.fin_mes)::int as dias_totales,
           case
             when m.mes = date_trunc('month', private.hoy())::date then private.hoy()
             when m.mes <  date_trunc('month', private.hoy())::date then m.fin_mes
             else (m.mes - interval '1 day')::date
           end as corte
    from marco m
  ),
  ddx as (
    select dd.*,
           greatest(0, (dd.corte - dd.mes + 1))::int as dias_transcurridos
    from dd
  ),
  estado as (
    select b.category_id, b.name, b.color, b.icon,
           b.effective_cap_cents, b.spent_cents
    from public.budget_status(p_month) b
  ),
  -- Recurrente ya cargado por categoría (suscripciones y préstamos), en neto.
  susc_pasado as (
    select s.cat as category_id, coalesce(sum(s.net), 0)::bigint as cents
    from (
      select t.category_id as cat, t.amount_cents as net
      from public.transaction t
      join ddx on t.period_month = ddx.mes and t.occurred_on <= ddx.corte
      where t.type = 'EXPENSE'
        and t.status <> 'DISCARDED'
        and (t.subscription_id is not null or t.loan_id is not null)
        and t.category_id is not null
      union all
      select ex.category_id as cat, -rb.amount_cents
      from public.transaction rb
      join public.transaction ex
        on ex.id = rb.reimburses_id and ex.user_id = rb.user_id
      join ddx on rb.period_month = ddx.mes and rb.occurred_on <= ddx.corte
      where rb.type = 'INCOME'
        and rb.reimburses_id is not null
        and rb.status <> 'DISCARDED'
        and (ex.subscription_id is not null or ex.loan_id is not null)
        and ex.category_id is not null
    ) s
    group by s.cat
  ),
  -- Lo fijo que falta este mes, por categoría: suscripciones y los intereses de
  -- las cuotas de préstamo aún no generadas (en la categoría de intereses del
  -- préstamo; el id de categoría es único, así que también cuadra cuando la
  -- llama el motor de avisos para todos los usuarios).
  susc_futuro as (
    select f.category_id, coalesce(sum(f.cents), 0)::bigint as cents
    from (
      select uc.category_id, uc.amount_cents as cents
      from ddx
      join lateral (
        select u.category_id, u.amount_cents
        from public.upcoming_charges(greatest(0, (ddx.fin_mes - private.hoy()))::int) u
        where ddx.mes = date_trunc('month', private.hoy())::date
          and u.charge_date <= ddx.fin_mes
          and u.category_id is not null
      ) uc on true
      union all
      select l.interest_category_id, p.interest_cents
      from ddx
      join public.loan l
        on ddx.mes = date_trunc('month', private.hoy())::date
       and l.status = 'ACTIVO'
       and l.interest_category_id is not null
      cross join lateral public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
      where p.period > l.last_generated_period
        and p.due_on between ddx.mes and ddx.fin_mes
    ) f
    group by f.category_id
  ),
  proj as (
    select e.category_id, e.name, e.color, e.icon,
           e.effective_cap_cents as cap_cents,
           e.spent_cents as gastado_cents,
           (e.spent_cents
             + coalesce(sf.cents, 0)
             + case
                 when dx.dias_transcurridos > 0
                   then round(
                          greatest(0, e.spent_cents - coalesce(sp.cents, 0))::numeric
                          * (dx.dias_totales - dx.dias_transcurridos) / dx.dias_transcurridos
                        )::bigint
                 else 0::bigint
               end
           )::bigint as prevision_cents
    from estado e
    cross join ddx dx
    left join susc_pasado sp on sp.category_id = e.category_id
    left join susc_futuro sf on sf.category_id = e.category_id
  )
  select p.category_id, p.name, p.color, p.icon,
         p.cap_cents, p.gastado_cents, p.prevision_cents,
         (p.prevision_cents > p.cap_cents) as rebasa
  from proj p
  order by (p.prevision_cents > p.cap_cents) desc, p.prevision_cents desc;
$function$;

-- public.claim_ingest_health_alerts
CREATE OR REPLACE FUNCTION public.claim_ingest_health_alerts(p_from_hour integer DEFAULT 9, p_cooldown_days integer DEFAULT 3)
 RETURNS TABLE(user_id uuid, rejections_24h bigint, many_rejections boolean, mute_devices bigint, max_mute_days integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoy  date    := private.hoy();
  v_hora integer := extract(hour from (now() at time zone 'Europe/Madrid'))::integer;
begin
  -- Antes de la hora acordada, calla. Después avisa aunque el cron llegue
  -- tarde: lo que impide repetir es la marca, no el reloj.
  if v_hora < p_from_hour then
    return;
  end if;

  return query
  with malos as (
    select h.user_id, h.rejections_24h, h.many_rejections,
           h.mute_devices, h.max_mute_days
    from public.v_ingest_health h
    where h.unhealthy
  ),
  -- Se marca a quien toca avisar (nunca avisado, o fuera de la ventana de
  -- reposo). El <= hace que un problema persistente re-avise exactamente cada
  -- p_cooldown_days días.
  marcados as (
    update public.profile p
       set ingest_health_notified_on = v_hoy
      from malos x
     where p.user_id = x.user_id
       and (p.ingest_health_notified_on is null
            or p.ingest_health_notified_on <= v_hoy - p_cooldown_days)
    returning p.user_id
  )
  select m.user_id, x.rejections_24h, x.many_rejections,
         x.mute_devices, x.max_mute_days
  from marcados m
  join malos x on x.user_id = m.user_id;
end $function$;

-- public.claim_pending_reminder
CREATE OR REPLACE FUNCTION public.claim_pending_reminder(p_from_hour integer DEFAULT 9)
 RETURNS TABLE(user_id uuid, cuantos integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoy  date    := private.hoy();
  v_hora integer := extract(hour from (now() at time zone 'Europe/Madrid'))::integer;
begin
  -- Antes de la hora acordada no se avisa. Después sí, aunque el cron llegue
  -- tarde: lo que impide repetir es la marca, no el reloj.
  if v_hora < p_from_hour then
    return;
  end if;

  return query
  with pendientes as (
    select t.user_id, count(*)::integer as cuantos
    from public.transaction t
    where t.status = 'PENDING'
    group by t.user_id
  ),
  -- Se marca ANTES de devolver, igual que los avisos de límite: si el envío
  -- falla, se pierde un recordatorio, que es mucho mejor que mandar el mismo
  -- cinco veces porque el marcado nunca llegó a ocurrir.
  marcados as (
    update public.profile p
       set pending_notified_on = v_hoy
      from pendientes x
     where p.user_id = x.user_id
       and (p.pending_notified_on is null or p.pending_notified_on < v_hoy)
    returning p.user_id
  )
  select m.user_id, x.cuantos
  from marcados m
  join pendientes x on x.user_id = m.user_id;
end $function$;

-- public.commitment_by_subscription
CREATE OR REPLACE FUNCTION public.commitment_by_subscription(p_months integer DEFAULT 12)
 RETURNS TABLE(period_month date, subscription_id uuid, description text, periodicity public.periodicity, amount_cents bigint, monthly_cents bigint, cuenta boolean, alta boolean, pausada boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with meses as (
    select m::date as mes
    from generate_series(
           date_trunc('month', private.hoy()) - make_interval(months => least(greatest(p_months, 1), 600) - 1),
           date_trunc('month', private.hoy()),
           interval '1 month'
         ) m
  )
  select s.mes,
         sub.id,
         sub.description,
         sub.periodicity,
         sub.amount_cents,
         round(sub.amount_cents * private.charges_per_year(sub.periodicity) / 12.0)::bigint,
         (sub.active or s.mes < date_trunc('month', private.hoy())::date),
         (date_trunc('month', sub.started_at::timestamp)::date = s.mes),
         (not sub.active)
  from meses s
  join public.subscription sub
    on sub.started_at <= (s.mes + interval '1 month' - interval '1 day')::date
  order by s.mes, sub.description, sub.id;
$function$;

-- public.commitment_history
CREATE OR REPLACE FUNCTION public.commitment_history(p_months integer DEFAULT 12)
 RETURNS TABLE(period_month date, monthly_cents bigint, cuantas integer)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with meses as (
    select m::date as mes
    from generate_series(
           date_trunc('month', private.hoy()) - make_interval(months => p_months - 1),
           date_trunc('month', private.hoy()),
           interval '1 month'
         ) m
  )
  select s.mes,
         coalesce(sum(
           round(sub.amount_cents * private.charges_per_year(sub.periodicity) / 12.0)
         ), 0)::bigint,
         coalesce(count(sub.id), 0)::integer
  from meses s
  left join public.subscription sub
    on sub.started_at <= (s.mes + interval '1 month' - interval '1 day')::date
   -- En el mes en curso, una pausada ya no compromete. En los pasados, sí
   -- contaba: se pagó.
   and (sub.active or s.mes < date_trunc('month', private.hoy())::date)
  group by s.mes
  order by s.mes;
$function$;

-- public.create_loan
CREATE OR REPLACE FUNCTION public.create_loan(p_name text, p_payment_account_id uuid, p_principal_cents bigint, p_term_months integer, p_tin_pct numeric, p_tae_pct numeric, p_opening_fee_cents bigint, p_charge_day integer, p_start_on date, p_first_charge_on date, p_disbursed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_uid     uuid := (select private.current_user_id());
  v_hoy     date := private.hoy();
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
end $function$;

-- public.generate_recurring_income
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

      v_fecha := private.next_charge(v_fecha, v_r.periodicity);
      v_vueltas := v_vueltas + 1;
    end loop;

    update public.recurring_income
       set next_income_date = v_fecha,
           last_generated_on = private.hoy()
     where id = v_r.id;
  end loop;

  return v_creados;
end $function$;

-- public.generate_subscription_charges
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

      v_fecha := private.next_charge(v_fecha, v_sub.periodicity);
      v_vueltas := v_vueltas + 1;
    end loop;

    update public.subscription
       set next_charge_date = v_fecha,
           last_generated_on = private.hoy()
     where id = v_sub.id;
  end loop;

  return v_creados;
end $function$;

-- public.instruments_to_refresh
CREATE OR REPLACE FUNCTION public.instruments_to_refresh()
 RETURNS TABLE(instrument_id uuid, yahoo_symbol text, currency text, last_price_date date, desde date)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with vigentes as (
    select per.instrument_id, per.date
    from public.investment_position p
    cross join lateral (
      select e.kind, e.instrument_id, e.date
      from public.position_unit_event e
      where e.user_id = p.user_id
        and e.position_id = p.id
        and e.kind in ('ALTA', 'BAJA')
        and e.date <= private.hoy()
      order by e.date desc, e.seq desc
      limit 1
    ) per
    where not p.archived
      and per.kind = 'ALTA'
  )
  select i.id,
         i.yahoo_symbol,
         i.currency,
         (select max(ip.date) from public.instrument_price ip where ip.instrument_id = i.id),
         min(v.date)
  from vigentes v
  join public.instrument i on i.id = v.instrument_id
  group by i.id, i.yahoo_symbol, i.currency
  order by i.yahoo_symbol;
$function$;

-- public.month_findings
CREATE OR REPLACE FUNCTION public.month_findings(p_month date)
 RETURNS TABLE(kind text, title text, detail text, cents bigint, count integer, href text, tono text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with mes as (select date_trunc('month', p_month::timestamp)::date as m),

  -- Meses seguidos ahorrando, contando hacia atrás desde el último cerrado.
  -- El mes en curso no cuenta: todavía puede torcerse.
  ahorro as (
    select e.period_month,
           (sum(e.real_income_cents) - sum(e.net_expense_cents)) as saldo
    from public.v_transaction_econ e
    where e.period_month < date_trunc('month', private.hoy())::date
    group by e.period_month
  ),
  ordenados as (
    select period_month, saldo,
           row_number() over (order by period_month desc) as pos
    from ahorro
  ),
  -- El primer mes en rojo corta la racha.
  corte as (
    select coalesce(min(pos), 999) as donde from ordenados where saldo <= 0
  ),
  racha as (
    select count(*)::int as meses, coalesce(sum(o.saldo), 0)::bigint as total
    from ordenados o, corte c
    where o.pos < c.donde
  )

  select 'pendientes',
         'Pagos pendientes de confirmar',
         'Llegaron del Atajo y ninguna regla los reconoció.',
         coalesce(sum(t.amount_cents), 0)::bigint,
         count(*)::int,
         '/movimientos?pendientes=1',
         'aviso'
  from public.transaction t
  where t.status = 'PENDING'
  having count(*) > 0

  union all

  select 'sin-clasificar',
         'Gasto sin clasificar',
         'Sin categoría no consume límite ni entra en el reparto.',
         coalesce(sum(e.net_expense_cents), 0)::bigint,
         count(*)::int,
         '/movimientos?categoria=sin',
         'aviso'
  from public.v_transaction_econ e, mes
  where e.period_month = mes.m and e.econ_category_id is null and e.net_expense_cents > 0
  having count(*) > 0

  union all

  select 'limite-pasado',
         'Límites pasados',
         'Te has pasado del tope que te pusiste.',
         coalesce(sum(b.spent_cents - b.cap_cents), 0)::bigint,
         count(*)::int,
         '/analisis',
         'aviso'
  from public.budget_status(p_month) b
  where b.spent_cents > b.cap_cents
  having count(*) > 0

  union all

  select 'suscripciones',
         'Cargos de suscripción sin generar',
         'Su fecha de cobro ya pasó pero no están en tus movimientos.',
         coalesce(sum(s.amount_cents), 0)::bigint,
         count(*)::int,
         '/suscripciones',
         'aviso'
  from public.v_subscription_summary s
  where s.active and s.due
  having count(*) > 0

  union all

  -- El positivo. Desde tres meses seguidos, que es cuando deja de ser
  -- casualidad y empieza a ser una costumbre.
  select 'racha-ahorro',
         case when r.meses = 1 then 'Cerraste el mes ahorrando'
              else 'Llevas ' || r.meses || ' meses ahorrando' end,
         'Ingresas más de lo que gastas, mes tras mes.',
         r.total,
         r.meses,
         '/patrimonio',
         'bien'
  from racha r
  where r.meses >= 3;
$function$;

-- public.month_forecast
CREATE OR REPLACE FUNCTION public.month_forecast(p_month date)
 RETURNS TABLE(dias_transcurridos integer, dias_totales integer, dias_restantes integer, gasto_real_cents bigint, suscripciones_cents bigint, extrapolado_cents bigint, prevision_cents bigint, ingresos_real_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with marco as (
    select date_trunc('month', p_month::timestamp)::date as mes,
           (date_trunc('month', p_month::timestamp) + interval '1 month' - interval '1 day')::date
             as fin_mes
  ),
  -- El corte: hasta hoy si el mes está en curso, todo el mes si ya pasó, y antes
  -- de empezar si es futuro (así no cuenta días ni extrapola).
  dias as (
    select m.mes,
           m.fin_mes,
           extract(day from m.fin_mes)::int as dias_totales,
           case
             when m.mes = date_trunc('month', private.hoy())::date then private.hoy()
             when m.mes <  date_trunc('month', private.hoy())::date then m.fin_mes
             else (m.mes - interval '1 day')::date
           end as corte
    from marco m
  ),
  dd as (
    select d.*,
           greatest(0, (d.corte - d.mes + 1))::int as dias_transcurridos
    from dias d
  ),
  -- (1) Lo gastado y lo ingresado hasta el corte, ya netos.
  realizado as (
    select coalesce(sum(e.net_expense_cents), 0)::bigint as gasto_real,
           coalesce(sum(e.real_income_cents), 0)::bigint as ingresos_real
    from public.v_transaction_econ e
    join dd on e.period_month = dd.mes and e.occurred_on <= dd.corte
  ),
  -- Lo recurrente ya cargado hasta el corte —suscripciones y, ahora, intereses
  -- y comisiones de préstamos—, en NETO, para descontarlo de lo discrecional.
  susc_pasado as (
    select coalesce(sum(s.net), 0)::bigint as cents
    from (
      select t.amount_cents as net
      from public.transaction t
      join dd on t.period_month = dd.mes and t.occurred_on <= dd.corte
      where t.type = 'EXPENSE'
        and t.status <> 'DISCARDED'
        and (t.subscription_id is not null or t.loan_id is not null)
      union all
      select -rb.amount_cents
      from public.transaction rb
      join public.transaction ex
        on ex.id = rb.reimburses_id and ex.user_id = rb.user_id
      join dd on rb.period_month = dd.mes and rb.occurred_on <= dd.corte
      where rb.type = 'INCOME'
        and rb.reimburses_id is not null
        and rb.status <> 'DISCARDED'
        and (ex.subscription_id is not null or ex.loan_id is not null)
    ) s
  ),
  -- (2) Suscripciones que faltan por cargar este mes (solo el mes en curso).
  susc_futuro as (
    select coalesce(sum(u.amount_cents), 0)::bigint as cents
    from dd
    left join lateral (
      select uc.amount_cents
      from public.upcoming_charges(greatest(0, (dd.fin_mes - private.hoy()))::int) uc
      where dd.mes = date_trunc('month', private.hoy())::date
        and uc.charge_date <= dd.fin_mes
    ) u on true
  ),
  -- (2b) Intereses de las cuotas de préstamo que faltan por cobrar este mes: las
  -- aún no generadas (después de la marca de agua) con fecha dentro del mes. Por
  -- construcción no solapan con (1), que solo ve las ya generadas.
  prest_futuro as (
    select coalesce(sum(p.interest_cents), 0)::bigint as cents
    from dd
    join public.loan l
      on dd.mes = date_trunc('month', private.hoy())::date
     and l.status = 'ACTIVO'
    cross join lateral public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
    where p.period > l.last_generated_period
      and p.due_on between dd.mes and dd.fin_mes
  ),
  calc as (
    select dd.dias_transcurridos,
           dd.dias_totales,
           (dd.dias_totales - dd.dias_transcurridos) as dias_restantes,
           realizado.gasto_real,
           realizado.ingresos_real,
           (susc_futuro.cents + prest_futuro.cents) as susc_fut,
           greatest(0, realizado.gasto_real - susc_pasado.cents) as discrecional
    from dd, realizado, susc_pasado, susc_futuro, prest_futuro
  ),
  fin as (
    select c.*,
           case
             when c.dias_transcurridos > 0
               then round(c.discrecional::numeric * c.dias_restantes / c.dias_transcurridos)::bigint
             else 0::bigint
           end as extrapolado
    from calc c
  )
  select f.dias_transcurridos,
         f.dias_totales,
         f.dias_restantes,
         f.gasto_real,
         f.susc_fut,
         f.extrapolado,
         (f.gasto_real + f.susc_fut + f.extrapolado)::bigint as prevision,
         f.ingresos_real
  from fin f;
$function$;

-- public.month_pace
CREATE OR REPLACE FUNCTION public.month_pace(p_month date)
 RETURNS TABLE(dia integer, actual_cents bigint, anterior_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with limites as (
    select date_trunc('month', p_month::timestamp)::date                       as mes,
           (date_trunc('month', p_month::timestamp) - interval '1 month')::date as previo
  ),
  dias as (
    select l.*,
           extract(day from (l.mes + interval '1 month' - interval '1 day'))::int    as dias_mes,
           extract(day from (l.previo + interval '1 month' - interval '1 day'))::int as dias_previo,
           -- Hasta qué día se sabe algo: hoy si el mes está en curso, todo si ya pasó.
           case
             when l.mes = date_trunc('month', private.hoy())::date
               then extract(day from private.hoy())::int
             else extract(day from (l.mes + interval '1 month' - interval '1 day'))::int
           end as hasta
    from limites l
  ),
  -- Gasto neto por día de cada uno de los dos meses.
  por_dia as (
    select e.period_month,
           extract(day from e.occurred_on)::int as d,
           sum(e.net_expense_cents)::bigint     as cents
    from public.v_transaction_econ e, limites l
    where e.period_month in (l.mes, l.previo)
    group by 1, 2
  ),
  eje as (
    select d.*, g.n as dia
    from dias d, generate_series(1, d.dias_mes) g(n)
  )
  select e.dia,
         case
           when e.dia > e.hasta then null
           else coalesce((
             select sum(p.cents)
             from por_dia p
             where p.period_month = e.mes and p.d <= e.dia
           ), 0)::bigint
         end,
         coalesce((
           select sum(p.cents)
           from por_dia p
           -- El recorte: pasado el último día del mes previo, su acumulado ya
           -- no crece, así que se compara contra su total.
           where p.period_month = e.previo and p.d <= least(e.dia, e.dias_previo)
         ), 0)::bigint
  from eje e
  order by e.dia;
$function$;

-- public.monthly_savings
CREATE OR REPLACE FUNCTION public.monthly_savings(p_months integer DEFAULT 12)
 RETURNS TABLE(period_month date, income_cents bigint, net_expense_cents bigint, saved_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with meses as (
    select m::date as mes
    from generate_series(
           date_trunc('month', private.hoy()) - make_interval(months => p_months - 1),
           date_trunc('month', private.hoy()),
           interval '1 month'
         ) m
  ),
  datos as (
    select e.period_month,
           sum(e.real_income_cents)::bigint  as ingresos,
           sum(e.net_expense_cents)::bigint  as gasto
    from public.v_transaction_econ e
    group by 1
  )
  select s.mes,
         coalesce(d.ingresos, 0)::bigint,
         coalesce(d.gasto, 0)::bigint,
         (coalesce(d.ingresos, 0) - coalesce(d.gasto, 0))::bigint
  from meses s
  left join datos d on d.period_month = s.mes
  order by s.mes;
$function$;

-- public.net_worth_daily
CREATE OR REPLACE FUNCTION public.net_worth_daily(p_desde date, p_hasta date)
 RETURNS TABLE(fecha date, net_worth_cents bigint, cash_cents bigint, invested_cents bigint, idle_cents bigint, debt_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with dias as (
    select (p_desde + g.n)::date as dia
    from generate_series(
           0,
           (least(p_hasta, private.hoy(), p_desde + 1826) - p_desde)
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
$function$;

-- public.net_worth_monthly
CREATE OR REPLACE FUNCTION public.net_worth_monthly(p_months integer DEFAULT 12)
 RETURNS TABLE(period_month date, net_worth_cents bigint, cash_cents bigint, invested_cents bigint, idle_cents bigint, debt_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with cierres as (
    select m::date as mes,
           (m + interval '1 month' - interval '1 day')::date as fin
    from generate_series(
           date_trunc('month', private.hoy()) - make_interval(months => least(greatest(p_months, 1), 600) - 1),
           date_trunc('month', private.hoy()),
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
$function$;

-- public.pending_recurring_income
CREATE OR REPLACE FUNCTION public.pending_recurring_income(p_month date)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with marco as (
    select date_trunc('month', p_month::timestamp)::date as mes,
           (date_trunc('month', p_month::timestamp) + interval '1 month' - interval '1 day')::date
             as fin_mes
  )
  select coalesce(sum(u.amount_cents), 0)::bigint
  from marco m
  left join lateral (
    select uc.amount_cents
    from public.upcoming_income(greatest(0, (m.fin_mes - private.hoy()))::int) uc
    where m.mes = date_trunc('month', private.hoy())::date
      and uc.income_date <= m.fin_mes
  ) u on true;
$function$;

-- public.savings_goal_projection
CREATE OR REPLACE FUNCTION public.savings_goal_projection(p_months integer DEFAULT 6)
 RETURNS TABLE(goal_id uuid, account_id uuid, name text, target_cents bigint, deadline date, saved_cents bigint, remaining_cents bigint, ritmo_cents bigint, meses_para_meta integer, fecha_estimada date, necesario_mensual_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with marco as (
    select least(greatest(1, p_months), 600) as n,
           (date_trunc('month', private.hoy()) - interval '1 day')::date as fin_ultimo,
           (date_trunc('month', private.hoy())
              - make_interval(months => least(greatest(1, p_months), 600))
              - interval '1 day')::date as fin_base
  ),
  historia as (
    select w.account_id, w.fecha, w.worth_cents
    from marco m
    cross join lateral private.account_worth_on(array[m.fin_ultimo, m.fin_base]) w
  ),
  metas as (
    select g.id,
           g.account_id,
           g.name,
           g.target_cents,
           g.deadline,
           coalesce(w.worth_cents, 0)::bigint as guardado,
           greatest(0, g.target_cents - coalesce(w.worth_cents, 0))::bigint as falta,
           round(
             (coalesce(h1.worth_cents, 0) - coalesce(h0.worth_cents, 0))::numeric / m.n
           )::bigint as ritmo
    from public.savings_goal g
    cross join marco m
    left join public.v_account_worth w
      on w.user_id = g.user_id and w.account_id = g.account_id
    left join historia h1 on h1.account_id = g.account_id and h1.fecha = m.fin_ultimo
    left join historia h0 on h0.account_id = g.account_id and h0.fecha = m.fin_base
  ),
  plazos as (
    select mt.*,
           case
             when mt.falta = 0 then 0
             when mt.ritmo > 0 and ceil(mt.falta::numeric / mt.ritmo) <= 1200
               then ceil(mt.falta::numeric / mt.ritmo)::integer
           end as meses
    from metas mt
  )
  select p.id,
         p.account_id,
         p.name,
         p.target_cents,
         p.deadline,
         p.guardado,
         p.falta,
         p.ritmo,
         p.meses,
         case
           when p.meses is not null
             then (private.hoy() + make_interval(months => p.meses))::date
         end,
         case
           when p.falta > 0 and p.deadline is not null and p.deadline > private.hoy()
             then round(p.falta::numeric * 30.44 / (p.deadline - private.hoy()))::bigint
         end
  from plazos p
  order by p.name, p.id;
$function$;

-- public.settle_loan
CREATE OR REPLACE FUNCTION public.settle_loan(p_loan_id uuid, p_on date, p_fee_cents bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_uid    uuid := (select private.current_user_id());
  v_hoy    date := private.hoy();
  v_on     date := coalesce(p_on, private.hoy());
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
end $function$;

-- public.unclassified_by_month
CREATE OR REPLACE FUNCTION public.unclassified_by_month(p_months integer DEFAULT 6)
 RETURNS TABLE(period_month date, cuantos integer, cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with meses as (
    select m::date as mes
    from generate_series(
           date_trunc('month', private.hoy()) - make_interval(months => p_months - 1),
           date_trunc('month', private.hoy()),
           interval '1 month'
         ) m
  )
  select s.mes,
         coalesce(count(t.id), 0)::integer,
         coalesce(sum(t.amount_cents), 0)::bigint
  from meses s
  left join public.transaction t
    on t.period_month = s.mes
   and t.category_id is null
   and t.type = 'EXPENSE'
   and t.status <> 'DISCARDED'
  group by s.mes
  order by s.mes;
$function$;

-- public.unfollow_instrument
CREATE OR REPLACE FUNCTION public.unfollow_instrument(p_position_id uuid, p_date date)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user  uuid := (select private.current_user_id());
  v_valor bigint;
  v_fuente text;
  v_val_id   uuid;
  v_val_date date;
begin
  if v_user is null then
    raise exception 'Sesión no válida' using errcode = '42501';
  end if;
  if p_date is null or p_date > private.hoy() then
    raise exception 'La fecha no puede ser futura' using errcode = '22023';
  end if;

  select pv.value_cents, pv.fuente into v_valor, v_fuente
  from private.position_value_on(array[p_date]) pv
  where pv.position_id = p_position_id;

  if not found then
    raise exception 'Posición no encontrada' using errcode = 'P0002';
  end if;

  -- El disparador del libro rechaza la BAJA si ese día no se seguía nada.
  insert into public.position_unit_event (user_id, position_id, kind, date)
  values (v_user, p_position_id, 'BAJA', p_date);

  if v_fuente = 'MERCADO' then
    select v.id, v.date into v_val_id, v_val_date
    from public.valuation v
    where v.position_id = p_position_id
      and v.period_month = date_trunc('month', p_date)::date;

    if v_val_id is null then
      insert into public.valuation (user_id, position_id, date, value_cents)
      values (v_user, p_position_id, p_date, v_valor);
    elsif v_val_date <= p_date then
      update public.valuation
         set date = p_date, value_cents = v_valor
       where id = v_val_id;
    end if;
  end if;

  return (
    select pv.value_cents
    from private.position_value_on(array[p_date]) pv
    where pv.position_id = p_position_id
  );
end $function$;

-- public.upcoming_charges
CREATE OR REPLACE FUNCTION public.upcoming_charges(p_days integer DEFAULT 60)
 RETURNS TABLE(subscription_id uuid, description text, amount_cents bigint, charge_date date, category_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
    where private.next_charge(f.fecha, f.periodicity) <= private.hoy() + p_days
      and f.vuelta < 60
  )
  select id, description, amount_cents, fecha, category_id
  from futuros
  where fecha between private.hoy() and private.hoy() + p_days
  order by fecha, description;
$function$;

-- public.upcoming_income
CREATE OR REPLACE FUNCTION public.upcoming_income(p_days integer DEFAULT 60)
 RETURNS TABLE(recurring_income_id uuid, description text, amount_cents bigint, income_date date, category_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
    where private.next_charge(f.fecha, f.periodicity) <= private.hoy() + p_days
      and f.vuelta < 60
  )
  select id, description, amount_cents, fecha, category_id
  from futuros
  where fecha between private.hoy() and private.hoy() + p_days
  order by fecha, description;
$function$;

-- public.update_loan_terms
CREATE OR REPLACE FUNCTION public.update_loan_terms(p_loan_id uuid, p_payment_account_id uuid, p_principal_cents bigint, p_term_months integer, p_tin_pct numeric, p_opening_fee_cents bigint, p_charge_day integer, p_start_on date, p_first_charge_on date, p_disbursed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_uid     uuid := (select private.current_user_id());
  v_hoy     date := private.hoy();
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
end $function$;

-- public.yearly_close
CREATE OR REPLACE FUNCTION public.yearly_close()
 RETURNS TABLE(anio integer, income_cents bigint, net_expense_cents bigint, saved_cents bigint, en_curso boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select extract(year from e.period_month)::integer                    as anio,
         sum(e.real_income_cents)::bigint                              as ingresos,
         sum(e.net_expense_cents)::bigint                              as gasto,
         (sum(e.real_income_cents) - sum(e.net_expense_cents))::bigint as ahorrado,
         extract(year from e.period_month) = extract(year from private.hoy()) as en_curso
  from public.v_transaction_econ e
  group by 1, 5
  order by 1 desc;
$function$;

-- ── Vistas (5) ──

-- public.v_closed_months
create or replace view public.v_closed_months
  with (security_invoker = true) as
 SELECT user_id,
    period_month,
    income_cents,
    net_expense_cents,
    month_balance_cents,
    gross_expense_cents,
    reimbursed_cents
   FROM public.v_month_summary
  WHERE (period_month < (date_trunc('month'::text, (private.hoy())::timestamp with time zone))::date);

-- public.v_pending_valuation
create or replace view public.v_pending_valuation
  with (security_invoker = true) as
 SELECT user_id,
    id AS position_id,
    name,
    ( SELECT max(v.date) AS max
           FROM public.valuation v
          WHERE (v.position_id = p.id)) AS last_valued_on
   FROM public.investment_position p
  WHERE ((NOT archived) AND (NOT (EXISTS ( SELECT 1
           FROM public.valuation v
          WHERE ((v.position_id = p.id) AND (v.period_month = (date_trunc('month'::text, (private.hoy())::timestamp with time zone))::date))))) AND (COALESCE(( SELECT (e.kind = 'ALTA'::public.position_event_kind)
           FROM public.position_unit_event e
          WHERE ((e.user_id = p.user_id) AND (e.position_id = p.id) AND (e.kind = ANY (ARRAY['ALTA'::public.position_event_kind, 'BAJA'::public.position_event_kind])) AND (e.date <= private.hoy()))
          ORDER BY e.date DESC, e.seq DESC
         LIMIT 1), false) = false));

-- public.v_position_market
create or replace view public.v_position_market
  with (security_invoker = true) as
 SELECT p.user_id,
    p.id AS position_id,
    p.name,
    p.archived,
    (pv.instrument_id IS NOT NULL) AS seguida,
    pv.instrument_id,
    i.yahoo_symbol,
    i.isin,
    i.name AS instrument_name,
    i.kind AS instrument_kind,
    i.currency,
    i.exchange,
    pv.alta_date,
    pv.anchor_date,
    pv.units,
    pv.units_estimadas,
    pv.price,
    pv.price_date,
    pv.fx_rate,
    pv.fx_date,
    pv.value_cents,
    pv.fuente,
    pv.valued_on,
    ((pv.instrument_id IS NOT NULL) AND ((pv.price IS NULL) OR (pv.fx_rate IS NULL))) AS sin_precio,
    coste.cents AS contributed_cents,
    (pv.value_cents - coste.cents) AS gain_cents,
    round(((100.0 * ((pv.value_cents - coste.cents))::numeric) / (NULLIF(coste.cents, 0))::numeric), 2) AS return_pct,
    habiles.dias AS dias_sin_precio,
    COALESCE((habiles.dias > 3), false) AS desactualizado
   FROM ((((((public.investment_position p
     JOIN private.position_value_on(ARRAY['infinity'::date]) pv(position_id, user_id, account_id, fecha, value_cents, fuente, valued_on, sin_valorar, instrument_id, alta_date, alta_contributed_cents, anchor_date, units, units_estimadas, price, price_date, fx_rate, fx_date) ON ((pv.position_id = p.id)))
     LEFT JOIN public.instrument i ON ((i.id = pv.instrument_id)))
     LEFT JOIN public.v_position_contributions c ON ((c.position_id = p.id)))
     LEFT JOIN ( SELECT ext.position_id,
            sum(ext.cents) AS cents
           FROM private.position_external_contributions() ext(user_id, position_id, fecha, cents)
          GROUP BY ext.position_id) externo ON ((externo.position_id = p.id)))
     CROSS JOIN LATERAL ( SELECT (((COALESCE(c.contributed_cents, (0)::bigint))::numeric + COALESCE(externo.cents, (0)::numeric)))::bigint AS cents) coste)
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS dias
           FROM generate_series(((pv.price_date + 1))::timestamp with time zone, (private.hoy())::timestamp with time zone, '1 day'::interval) g(d)
          WHERE (EXTRACT(isodow FROM g.d) < (6)::numeric)) habiles ON ((pv.price_date IS NOT NULL)));

-- public.v_recurring_income_summary
create or replace view public.v_recurring_income_summary
  with (security_invoker = true) as
 SELECT user_id,
    id,
    description,
    amount_cents,
    periodicity,
    next_income_date,
    category_id,
    account_id,
    active,
    started_at,
    (amount_cents * private.charges_per_year(periodicity)) AS yearly_cents,
    (round((((amount_cents * private.charges_per_year(periodicity)))::numeric / 12.0)))::bigint AS monthly_cents,
    (next_income_date <= private.hoy()) AS due
   FROM public.recurring_income r;

-- public.v_subscription_summary
create or replace view public.v_subscription_summary
  with (security_invoker = true) as
 SELECT user_id,
    id,
    description,
    amount_cents,
    periodicity,
    next_charge_date,
    category_id,
    account_id,
    active,
    started_at,
    (amount_cents * private.charges_per_year(periodicity)) AS yearly_cents,
    (round((((amount_cents * private.charges_per_year(periodicity)))::numeric / 12.0)))::bigint AS monthly_cents,
    (next_charge_date <= private.hoy()) AS due
   FROM public.subscription s;
