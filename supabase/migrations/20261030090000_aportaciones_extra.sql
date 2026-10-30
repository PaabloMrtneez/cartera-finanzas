-- ===========================================================================
-- Aportaciones extra a un préstamo (amortización anticipada parcial).
--
-- Plan: docs/planes/aportaciones-extra-prestamos.md.
-- Prueba: scripts/test-aportaciones.mjs (y src/lib/prestamos-aportaciones.test.ts).
--
-- ── QUÉ ────────────────────────────────────────────────────────────────────
-- Pagar capital de más un mes, eligiendo:
--   · PLAZO: la misma cuota; el préstamo termina antes (el que más ahorra).
--   · CUOTA: el mismo fin; la cuota baja.
-- El cuadro se recalcula desde ahí, y todo lo que lo lee —la generación de
-- cuotas, la ficha, Fijos, la previsión del mes, los avisos de cuota— pasa a
-- leer el cuadro EFECTIVO (`public.loan_cuadro`).
--
-- ── EL CUADRO SIGUE SIN GUARDARSE ──────────────────────────────────────────
-- `loan_plan` (el del contrato) no cambia. `loan_plan_aportaciones` es el
-- mismo cálculo en enteros con las aportaciones dentro, espejo exacto de
-- `cuadroConAportaciones` (src/lib/prestamos.ts): la prueba los compara al
-- céntimo. Sin aportaciones, da `loan_plan` fila a fila. La deuda sigue
-- saliendo del saldo de la cuenta-pasivo (invariante 2): la aportación es un
-- traspaso a ella (`loan_part = 'AMORTIZACION'`).
--
-- Una aportación se aplica al cambio de mes, tras la última cuota cobrada a su
-- fecha, sin intereses por días (el banco puede cobrar algo por esos días: va
-- como comisión, `COMISION_AMORTIZACION`).
--
-- ── PROTECCIONES ───────────────────────────────────────────────────────────
--   · El movimiento de una aportación no se borra ni se cambia a mano: el
--     cuadro depende de él. Se deshace con `undo_loan_prepayment` (solo la
--     última, y antes de la siguiente cuota).
--   · `update_loan_terms` no cambia las condiciones si hay aportaciones.
--   · `register_loan_prepayment` no admite lo que se debe o más (eso es
--     liquidar), ni una fecha anterior a una cuota ya cobrada.
--
-- Con la «cuota entera» (20261026090000), la aportación cuenta como gasto en la
-- categoría del préstamo, igual que CAPITAL y LIQUIDACION.
--
-- Seguridad: RLS forzada y claves compuestas con user_id en la tabla nueva;
-- todo `security invoker` con search_path = ''; las vistas, security_invoker.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Dos partes nuevas de un préstamo en `transaction`.
-- ---------------------------------------------------------------------------
alter table public.transaction
  drop constraint tx_loan_part_valid,
  drop constraint tx_loan_part_type;

alter table public.transaction
  add constraint tx_loan_part_valid check (
    loan_part is null or loan_part in
      ('DESEMBOLSO', 'COMISION', 'INTERESES', 'CAPITAL', 'LIQUIDACION', 'COMISION_CANCELACION',
       'AMORTIZACION', 'COMISION_AMORTIZACION')),
  -- La aportación es un traspaso (sin signo) y su comisión, un gasto.
  add constraint tx_loan_part_type check (
    loan_part is null
    or (loan_part in ('DESEMBOLSO', 'CAPITAL', 'LIQUIDACION', 'AMORTIZACION') and type = 'TRANSFER')
    or (loan_part in ('COMISION', 'INTERESES', 'COMISION_CANCELACION', 'COMISION_AMORTIZACION')
        and type = 'EXPENSE'));

-- Un desembolso, una comisión de apertura o una liquidación solo ocurren una
-- vez por préstamo, y este índice lo garantiza. Las aportaciones pueden ser
-- muchas: quedan fuera (el doble envío lo frena register_loan_prepayment).
drop index public.tx_loan_evento_uq;
create unique index tx_loan_evento_uq
  on public.transaction (user_id, loan_id, loan_part)
  where loan_id is not null and loan_period is null
    and loan_part not in ('AMORTIZACION', 'COMISION_AMORTIZACION');


-- ---------------------------------------------------------------------------
-- 2. loan_prepayment — una aportación, enlazada a su movimiento.
-- ---------------------------------------------------------------------------
create table public.loan_prepayment (
  id                   uuid not null default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  loan_id              uuid not null,
  -- Se aplica TRAS esta cuota (0: antes de la primera).
  after_period         smallint not null,
  paid_on              date not null,
  amount_cents         bigint not null,
  mode                 text not null,
  fee_cents            bigint not null default 0,
  -- El traspaso de la aportación. Borrarlo (solo deshaciéndola) la borra.
  transaction_id       uuid not null,
  transaction_type     public.entry_type not null default 'TRANSFER',
  -- La comisión, si la hubo.
  fee_transaction_id   uuid,
  fee_transaction_type public.entry_type,
  -- El orden de dos aportaciones de la misma cuota, que cambia el resultado:
  -- la hora real, no la del inicio de la transacción (now()).
  created_at           timestamptz not null default clock_timestamp(),

  primary key (id),
  unique (user_id, id),
  unique (user_id, transaction_id),

  constraint loan_prepayment_mode       check (mode in ('PLAZO', 'CUOTA')),
  constraint loan_prepayment_amount     check (amount_cents between 100 and 100000000000),
  constraint loan_prepayment_fee        check (fee_cents between 0 and 100000000),
  constraint loan_prepayment_after      check (after_period >= 0),
  constraint loan_prepayment_tx_type    check (transaction_type = 'TRANSFER'),
  constraint loan_prepayment_fee_pair   check ((fee_transaction_id is null) = (fee_transaction_type is null)),
  constraint loan_prepayment_fee_type   check (fee_transaction_type is null or fee_transaction_type = 'EXPENSE'),

  -- Claves compuestas con user_id (invariante 5).
  constraint loan_prepayment_loan_fk
    foreign key (user_id, loan_id) references public.loan (user_id, id) on delete cascade,
  constraint loan_prepayment_tx_fk
    foreign key (user_id, transaction_id, transaction_type)
    references public.transaction (user_id, id, type) on delete cascade,
  constraint loan_prepayment_fee_fk
    foreign key (user_id, fee_transaction_id, fee_transaction_type)
    references public.transaction (user_id, id, type)
    on delete set null (fee_transaction_id, fee_transaction_type)
);

create index loan_prepayment_loan_idx on public.loan_prepayment (user_id, loan_id, after_period);

alter table public.loan_prepayment enable row level security;
alter table public.loan_prepayment force row level security;
revoke all on table public.loan_prepayment from anon;
-- Se escribe con register/undo_loan_prepayment (security invoker): necesitan
-- insertar y borrar con la sesión del usuario. Nunca se edita.
revoke update on table public.loan_prepayment from authenticated;

create policy loan_prepayment_sel on public.loan_prepayment for select to authenticated
  using (user_id = (select private.current_user_id()));
create policy loan_prepayment_ins on public.loan_prepayment for insert to authenticated
  with check (user_id = (select private.current_user_id()));
create policy loan_prepayment_del on public.loan_prepayment for delete to authenticated
  using (user_id = (select private.current_user_id()));

comment on table public.loan_prepayment is
  'Aportación extra a un préstamo (amortización anticipada parcial). El cuadro efectivo (loan_cuadro) la tiene en cuenta; el dinero es su traspaso AMORTIZACION.';


-- ---------------------------------------------------------------------------
-- 3. El cálculo: la cuota francesa, el fin vigente y el cuadro con aportaciones.
-- ---------------------------------------------------------------------------

-- La cuota francesa de p_pend a p_meses meses, en céntimos exactos. La misma
-- cuenta que loan_plan (y que cuotaFrancesa en prestamos.ts).
create or replace function private.loan_cuota(p_pend numeric, p_meses integer, p_t numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_d  constant numeric := 12000000;
  v_q  numeric := 1;
  v_dn numeric := 1;
  k    integer;
begin
  if p_t = 0 then
    return div(2 * p_pend + p_meses, 2 * p_meses);
  end if;
  for k in 1 .. p_meses loop
    v_q  := v_q * (c_d + p_t);
    v_dn := v_dn * c_d;
  end loop;
  return div(2 * p_pend * p_t * v_q + c_d * (v_q - v_dn), 2 * c_d * (v_q - v_dn));
end $$;

-- El último periodo al que se llega pagando p_cuota desde lo que se debe tras
-- la cuota p_k, con las reglas de un tramo de PLAZO (finPrevisto en TS). Es
-- el fin vigente que mantiene una aportación en CUOTA hecha tras otra en PLAZO.
create or replace function private.loan_fin_previsto(
  p_pend numeric, p_cuota numeric, p_fin integer, p_k integer, p_t numeric)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_d   constant numeric := 12000000;
  v_p   numeric := p_pend;
  v_int numeric;
  j     integer := p_k + 1;
begin
  loop
    v_int := div(2 * v_p * p_t + c_d, 2 * c_d);
    if j >= p_fin or p_cuota - v_int >= v_p then
      return j;
    end if;
    v_p := v_p - (p_cuota - v_int);
    j := j + 1;
  end loop;
end $$;

-- El cuadro con aportaciones (cuadroConAportaciones en TS). p_aportaciones es
-- un array JSON [{"despues_de": k, "importe": céntimos, "modo": "PLAZO"|"CUOTA"}]
-- en el orden en que se hicieron; se aplican por cuota, respetando ese orden.
create or replace function public.loan_plan_aportaciones(
  p_principal_cents bigint,
  p_term_months     integer,
  p_tin_pct         numeric,
  p_first_charge_on date,
  p_aportaciones    jsonb
)
returns table (
  period              integer,
  due_on              date,
  payment_cents       bigint,
  interest_cents      bigint,
  principal_cents     bigint,
  balance_after_cents bigint,
  prepaid_cents       bigint
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_d     constant numeric := 12000000;
  v_desp  integer[];
  v_imp   numeric[];
  v_modo  text[];
  v_n     integer;
  v_i     integer := 1;
  v_t     numeric := p_tin_pct * 10000;
  v_pend  numeric := p_principal_cents;
  v_cuota numeric;
  v_fin   integer := p_term_months;
  v_plazo boolean := false;
  v_ult   boolean := false;
  v_int   numeric;
  v_cap   numeric;
  v_aport numeric;
  k       integer := 0;
begin
  -- Sin aportaciones, el cuadro del contrato tal cual (y sus validaciones).
  if p_aportaciones is null or jsonb_typeof(p_aportaciones) <> 'array'
     or jsonb_array_length(p_aportaciones) = 0 then
    return query
      select p.period, p.due_on, p.payment_cents, p.interest_cents, p.principal_cents,
             p.balance_after_cents, 0::bigint
      from public.loan_plan(p_principal_cents, p_term_months, p_tin_pct, p_first_charge_on) p;
    return;
  end if;

  -- Las mismas validaciones que el cuadro original.
  perform count(*) from public.loan_plan(p_principal_cents, p_term_months, p_tin_pct, p_first_charge_on);

  -- Por cuota y, dentro de la misma, en el orden de llegada (el sort estable de TS).
  select array_agg((a.x ->> 'despues_de')::integer order by (a.x ->> 'despues_de')::integer, a.o),
         array_agg((a.x ->> 'importe')::numeric   order by (a.x ->> 'despues_de')::integer, a.o),
         array_agg(a.x ->> 'modo'                 order by (a.x ->> 'despues_de')::integer, a.o)
    into v_desp, v_imp, v_modo
  from jsonb_array_elements(p_aportaciones) with ordinality as a(x, o);
  v_n := array_length(v_desp, 1);

  if exists (select 1 from unnest(v_desp) d where d is null or d < 0) then
    raise exception 'Aportación fuera del cuadro' using errcode = '22023';
  end if;

  v_cuota := private.loan_cuota(v_pend, p_term_months, v_t);

  loop
    -- La cuota k (no la hay en k = 0: antes de la primera).
    if k > 0 then
      v_int := div(2 * v_pend * v_t + c_d, 2 * c_d);
      v_ult := k >= v_fin or (v_plazo and v_cuota - v_int >= v_pend);
      v_cap := case when v_ult then v_pend else v_cuota - v_int end;
      if v_cap <= 0 then
        raise exception 'Con ese TIN y ese plazo la cuota no amortiza bien el préstamo. Prueba con un plazo más corto.'
          using errcode = '22023';
      end if;
      v_pend := v_pend - v_cap;
    end if;

    -- Lo aportado tras la cuota k (nunca tras la última).
    v_aport := 0;
    if not v_ult then
      while v_i <= v_n and v_desp[v_i] = k loop
        if v_imp[v_i] is null or v_imp[v_i] < 100 or v_imp[v_i] <> trunc(v_imp[v_i]) then
          raise exception 'Una aportación tiene que ser de 1 € o más' using errcode = '22023';
        end if;
        if v_imp[v_i] >= v_pend then
          raise exception 'Esa aportación paga todo lo que queda: para eso, liquida el préstamo'
            using errcode = '22023';
        end if;
        if v_modo[v_i] = 'CUOTA' and v_plazo then
          -- Tras reducir plazo, el fin vigente es antes que el del contrato:
          -- reducir cuota mantiene ESE fin, no vuelve a alargarlo.
          v_fin := private.loan_fin_previsto(v_pend, v_cuota, v_fin, k, v_t);
        end if;
        v_pend := v_pend - v_imp[v_i];
        v_aport := v_aport + v_imp[v_i];
        if v_modo[v_i] = 'CUOTA' then
          v_cuota := private.loan_cuota(v_pend, v_fin - k, v_t);
          v_plazo := false;
        elsif v_modo[v_i] = 'PLAZO' then
          v_plazo := true;
        else
          raise exception 'Modo de aportación no válido' using errcode = '22023';
        end if;
        v_i := v_i + 1;
      end loop;
    end if;

    if k > 0 then
      period              := k;
      due_on              := (p_first_charge_on + make_interval(months => k - 1))::date;
      payment_cents       := (v_int + v_cap)::bigint;
      interest_cents      := v_int::bigint;
      principal_cents     := v_cap::bigint;
      balance_after_cents := v_pend::bigint;
      prepaid_cents       := v_aport::bigint;
      return next;
      exit when v_ult;
    end if;
    k := k + 1;
  end loop;

  if v_i <= v_n then
    raise exception 'Esa aportación llega cuando el préstamo ya está pagado' using errcode = '22023';
  end if;
end $$;

-- El cuadro efectivo de un préstamo: el del contrato con sus aportaciones.
create or replace function public.loan_cuadro(p_loan_id uuid)
returns table (
  period              integer,
  due_on              date,
  payment_cents       bigint,
  interest_cents      bigint,
  principal_cents     bigint,
  balance_after_cents bigint,
  prepaid_cents       bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.*
  from public.loan l
  cross join lateral public.loan_plan_aportaciones(
    l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on,
    (select jsonb_agg(jsonb_build_object(
              'despues_de', a.after_period, 'importe', a.amount_cents, 'modo', a.mode)
            order by a.after_period, a.created_at, a.id)
     from public.loan_prepayment a
     where a.user_id = l.user_id and a.loan_id = l.id)
  ) p
  where l.id = p_loan_id;
$$;

revoke all on function private.loan_cuota(numeric, integer, numeric) from public, anon;
revoke all on function private.loan_fin_previsto(numeric, numeric, integer, integer, numeric) from public, anon;
revoke all on function public.loan_plan_aportaciones(bigint, integer, numeric, date, jsonb) from public, anon;
revoke all on function public.loan_cuadro(uuid) from public, anon;
grant execute on function private.loan_cuota(numeric, integer, numeric) to authenticated, service_role;
grant execute on function private.loan_fin_previsto(numeric, numeric, integer, integer, numeric) to authenticated, service_role;
grant execute on function public.loan_plan_aportaciones(bigint, integer, numeric, date, jsonb) to authenticated, service_role;
grant execute on function public.loan_cuadro(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. loan_schedule — el cuadro efectivo con su estado (y lo aportado). Cambia
--    su tabla de salida (+ prepaid_cents al final): hay que recrearla.
-- ---------------------------------------------------------------------------
drop function public.loan_schedule(uuid);

create function public.loan_schedule(p_loan_id uuid)
returns table (
  period              integer,
  due_on              date,
  payment_cents       bigint,
  interest_cents      bigint,
  principal_cents     bigint,
  balance_after_cents bigint,
  state               text,
  has_movement        boolean,
  prepaid_cents       bigint
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
         ),
         p.prepaid_cents
  from public.loan l
  cross join lateral public.loan_cuadro(l.id) p
  where l.id = p_loan_id
  order by p.period;
$$;

revoke all on function public.loan_schedule(uuid) from public, anon;
grant execute on function public.loan_schedule(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 5. loan_generate — las cuotas del cuadro EFECTIVO; el préstamo se cierra en
--    su fin efectivo y la descripción cuenta las cuotas efectivas.
-- ---------------------------------------------------------------------------
create or replace function private.loan_generate(p_user uuid, p_loan uuid, p_hoy date, p_marcar boolean)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_hoy     date := least(coalesce(p_hoy, private.hoy()),
                          private.hoy());
  l         record;
  c         record;
  v_cat     uuid;
  v_ultimo  integer;
  v_total   integer;
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
    -- El último periodo del cuadro efectivo: con aportaciones en PLAZO, antes
    -- que el del contrato.
    select max(p.period) into v_total from public.loan_cuadro(l.id) p;

    for c in
      select p.*
      from public.loan_cuadro(l.id) p
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
          format('Intereses · %s (cuota %s/%s)', l.name, c.period, v_total),
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
          format('Capital · %s (cuota %s/%s)', l.name, c.period, v_total),
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
             status = case when v_ultimo = v_total then 'LIQUIDADO' else lo.status end,
             closed_on = case when v_ultimo = v_total then v_fin else lo.closed_on end
       where lo.id = l.id;

      if v_ultimo = v_total then
        update public.account a
           set archived = true, archived_at = now()
         where a.user_id = l.user_id and a.id = l.liability_account_id and not a.archived;
      end if;
    end if;
  end loop;

  return v_creadas;
end $$;


-- ---------------------------------------------------------------------------
-- 6. Con la «cuota entera», la aportación cuenta como gasto igual que el
--    capital y la liquidación. Las vistas y funciones de 20261026090000, con
--    AMORTIZACION en la lista de partes (y nada más cambiado).
-- ---------------------------------------------------------------------------
create or replace view public.v_transaction_econ with (security_invoker = true) as
select t.user_id,
       t.id,
       t.period_month,
       t.occurred_on,
       -- El capital que cuenta como gasto se lee como gasto (lo que filtran por
       -- `type = 'EXPENSE'` —límites, comercios, tarjetas— lo ven igual).
       case when l.id is not null then 'EXPENSE'::public.entry_type else t.type end as type,
       t.amount_cents,
       t.status,

       case
         when t.reimburses_id is not null then r.category_id
         when l.id is not null            then l.interest_category_id
         else t.category_id
       end as econ_category_id,

       case
         when t.type = 'EXPENSE' or l.id is not null           then  t.amount_cents
         when t.type = 'INCOME' and t.reimburses_id is not null then -t.amount_cents
         else 0
       end as net_expense_cents,

       case
         when t.type = 'INCOME' and t.reimburses_id is null then t.amount_cents
         else 0
       end as real_income_cents,

       (t.reimburses_id is not null) as is_reimbursement
from public.transaction t
left join public.transaction r
  on r.id = t.reimburses_id and r.user_id = t.user_id
-- Solo casa con el capital y la liquidación de un préstamo con la cuota entera.
left join public.loan l
  on l.user_id = t.user_id
 and l.id = t.loan_id
 and t.loan_part in ('CAPITAL', 'LIQUIDACION', 'AMORTIZACION')
 and l.counts_full_installment
where t.status <> 'DISCARDED'
  -- Un traspaso no es gasto ni ingreso (invariante 3)… salvo esa excepción.
  and (t.type <> 'TRANSFER' or l.id is not null)
  -- Un reembolso de un gasto descartado no abarata nada (ni es un ingreso).
  and (t.reimburses_id is null or r.status <> 'DISCARDED');



-- ---------------------------------------------------------------------------
-- 7. La previsión del mes: lo que falta por cobrar sale del cuadro EFECTIVO
--    (loan_cuadro), y la aportación ya hecha cuenta como recurrente (no se
--    extrapola). Lo demás, como en 20261026090000.
-- ---------------------------------------------------------------------------
create or replace function public.month_forecast(p_month date)
returns table (
  dias_transcurridos  integer,
  dias_totales        integer,
  dias_restantes      integer,
  gasto_real_cents    bigint,
  suscripciones_cents bigint,
  extrapolado_cents   bigint,
  prevision_cents     bigint,
  ingresos_real_cents bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
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
  -- Lo recurrente ya cargado hasta el corte —suscripciones, intereses y
  -- comisiones de préstamos y, con la cuota entera, su capital y su
  -- liquidación—, en NETO, para descontarlo de lo discrecional.
  susc_pasado as (
    select coalesce(sum(s.net), 0)::bigint as cents
    from (
      select t.amount_cents as net
      from public.transaction t
      join dd on t.period_month = dd.mes and t.occurred_on <= dd.corte
      left join public.loan l
        on l.user_id = t.user_id and l.id = t.loan_id
       and t.loan_part in ('CAPITAL', 'LIQUIDACION', 'AMORTIZACION') and l.counts_full_installment
      where t.status <> 'DISCARDED'
        and (
          (t.type = 'EXPENSE' and (t.subscription_id is not null or t.loan_id is not null))
          or l.id is not null
        )
      union all
      select -rb.amount_cents
      from public.transaction rb
      join public.transaction ex
        on ex.id = rb.reimburses_id and ex.user_id = rb.user_id
      join dd on rb.period_month = dd.mes and rb.occurred_on <= dd.corte
      where rb.type = 'INCOME'
        and rb.reimburses_id is not null
        and rb.status <> 'DISCARDED'
        -- El reembolso de un gasto descartado no resta (20261020090400).
        and ex.status <> 'DISCARDED'
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
  -- (2b) Lo que falta por cobrar este mes de las cuotas de préstamo aún no
  -- generadas (después de la marca de agua): los intereses y, con la cuota
  -- entera, también el capital. Por construcción no solapan con (1).
  prest_futuro as (
    select coalesce(sum(
             p.interest_cents + case when l.counts_full_installment then p.principal_cents else 0 end
           ), 0)::bigint as cents
    from dd
    join public.loan l
      on dd.mes = date_trunc('month', private.hoy())::date
     and l.status = 'ACTIVO'
    cross join lateral public.loan_cuadro(l.id) p
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
$$;


create or replace function public.category_forecast(p_month date)
returns table (
  category_id     uuid,
  name            text,
  color           text,
  icon            text,
  cap_cents       bigint,
  gastado_cents   bigint,
  prevision_cents bigint,
  rebasa          boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
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
  -- El capital de la cuota entera va a la categoría del préstamo, como en
  -- v_transaction_econ.
  susc_pasado as (
    select s.cat as category_id, coalesce(sum(s.net), 0)::bigint as cents
    from (
      select case when l.id is not null then l.interest_category_id else t.category_id end as cat,
             t.amount_cents as net
      from public.transaction t
      join ddx on t.period_month = ddx.mes and t.occurred_on <= ddx.corte
      left join public.loan l
        on l.user_id = t.user_id and l.id = t.loan_id
       and t.loan_part in ('CAPITAL', 'LIQUIDACION', 'AMORTIZACION') and l.counts_full_installment
      where t.status <> 'DISCARDED'
        and (
          (t.type = 'EXPENSE' and (t.subscription_id is not null or t.loan_id is not null))
          or l.id is not null
        )
      union all
      select ex.category_id as cat, -rb.amount_cents
      from public.transaction rb
      join public.transaction ex
        on ex.id = rb.reimburses_id and ex.user_id = rb.user_id
      join ddx on rb.period_month = ddx.mes and rb.occurred_on <= ddx.corte
      where rb.type = 'INCOME'
        and rb.reimburses_id is not null
        and rb.status <> 'DISCARDED'
        -- El reembolso de un gasto descartado no resta (20261020090400).
        and ex.status <> 'DISCARDED'
        and (ex.subscription_id is not null or ex.loan_id is not null)
        and ex.category_id is not null
    ) s
    where s.cat is not null
    group by s.cat
  ),
  -- Lo fijo que falta este mes, por categoría: suscripciones y, de las cuotas
  -- de préstamo aún no generadas, los intereses (y con la cuota entera, el
  -- capital) en la categoría del préstamo. El id de categoría es único, así que
  -- también cuadra cuando la llama el motor de avisos para todos los usuarios.
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
      select l.interest_category_id,
             p.interest_cents + case when l.counts_full_installment then p.principal_cents else 0 end
      from ddx
      join public.loan l
        on ddx.mes = date_trunc('month', private.hoy())::date
       and l.status = 'ACTIVO'
       and l.interest_category_id is not null
      cross join lateral public.loan_cuadro(l.id) p
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
$$;



-- ---------------------------------------------------------------------------
-- 7b. La búsqueda de movimientos: AMORTIZACION en la lista de partes.
-- ---------------------------------------------------------------------------
create or replace function public.search_transactions(
  p_from          date        default null,
  p_to            date        default null,
  p_type          public.entry_type default null,
  p_account       uuid        default null,
  p_category      uuid        default null,
  p_uncategorized boolean     default false,
  p_only_shortcut boolean     default false,
  p_only_pending  boolean     default false,
  p_q             text        default null,
  p_limit         integer     default 100
)
returns table (
  id                     uuid,
  user_id                uuid,
  type                   public.entry_type,
  amount_cents           bigint,
  description            text,
  occurred_on            date,
  occurred_time          time without time zone,
  occurred_at            timestamp with time zone,
  account_id             uuid,
  to_account_id          uuid,
  category_id            uuid,
  category_type          public.entry_type,
  note                   text,
  reimburses_id          uuid,
  reimburses_target_type public.entry_type,
  source                 public.tx_source,
  status                 public.tx_status,
  merchant_raw           text,
  card_last4             text,
  external_id            text,
  device_id              uuid,
  subscription_id        uuid,
  position_id            uuid,
  period_month           date,
  total_count            bigint,
  total_net_cents        bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    -- El tipo y la categoría con los que CUENTA cada movimiento: los suyos,
    -- salvo el capital de un préstamo con la cuota entera (gasto, en la
    -- categoría del préstamo), igual que en v_transaction_econ.
    select t.*,
           case when l.id is not null then 'EXPENSE'::public.entry_type else t.type end as tipo_econ,
           case when l.id is not null then l.interest_category_id else t.category_id end as cat_econ
    from public.transaction t
    left join public.loan l
      on l.user_id = t.user_id and l.id = t.loan_id
     and t.loan_part in ('CAPITAL', 'LIQUIDACION', 'AMORTIZACION') and l.counts_full_installment
    where t.status <> 'DISCARDED'
  ),
  filtrados as (
    select b.*
    from base b
    where (p_from is null or b.occurred_on >= p_from)
      and (p_to   is null or b.occurred_on <= p_to)
      and (p_type is null or b.tipo_econ = p_type)
      and (p_account is null or b.account_id = p_account)
      -- «Sin categoría» no es una fila: es la ausencia de una.
      and (not p_uncategorized or b.cat_econ is null)
      and (p_category is null or b.cat_econ = p_category)
      and (not p_only_shortcut or b.source = 'SHORTCUT')
      and (not p_only_pending  or b.status = 'PENDING')
      -- Los cuatro campos que busca el prototipo, los cuatro en la base. Las
      -- categorías y cuentas que casan se buscan una vez, no por movimiento.
      and (
        p_q is null or p_q = '' or
        b.description  ilike '%' || p_q || '%' or
        b.merchant_raw ilike '%' || p_q || '%' or
        -- Sin correlación con b (si no, el subplan no se puede «hashear» y
        -- vuelve a ser por fila). No hace falta: un id es único y la FK
        -- compuesta ya ata la categoría y la cuenta al mismo usuario.
        b.cat_econ in (
          select c.id from public.category c where c.name ilike '%' || p_q || '%'
        ) or
        b.account_id in (
          select a.id from public.account a where a.name ilike '%' || p_q || '%'
        )
      )
  ),
  -- Los totales, sobre TODO lo que casa y no sobre la página.
  con_totales as (
    select f.*,
           count(*) over ()::bigint as total_count,
           sum(
             case
               when f.tipo_econ = 'EXPENSE'                         then  f.amount_cents
               -- El reembolso de un gasto descartado no resta (20261020090400).
               when f.type = 'INCOME' and f.reimburses_id is not null
                    and not exists (select 1 from public.transaction g
                                    where g.user_id = f.user_id and g.id = f.reimburses_id
                                      and g.status = 'DISCARDED') then -f.amount_cents
               else 0
             end
           ) over ()::bigint as total_net_cents
    from filtrados f
  )
  select id, user_id, type, amount_cents, description, occurred_on, occurred_time,
         occurred_at, account_id, to_account_id, category_id, category_type, note,
         reimburses_id, reimburses_target_type, source, status, merchant_raw,
         card_last4, external_id, device_id, subscription_id, position_id,
         period_month, total_count, total_net_cents
  from con_totales
  -- `id` al final: un orden TOTAL. Sin él, dos movimientos importados juntos
  -- (misma fecha, hora y created_at) podían salir en cualquier orden, y al
  -- pedir la lista por páginas (.range) una fila se repetía y otra faltaba.
  order by occurred_on desc, occurred_time desc, created_at desc, id desc
  limit greatest(p_limit, 1);
$$;


-- ---------------------------------------------------------------------------
-- 8. v_loan_status — con el cuadro efectivo. Mismas columnas y mismo orden;
--    al final, tres nuevas: el fin efectivo, lo aportado y el ahorro.
--    · payment_cents es la cuota VIGENTE: la de la siguiente cuota (o la
--      primera, si ya no queda ninguna). Sin aportaciones, la de siempre.
--    · schedule_pending_cents ya descuenta lo aportado: sin descuadre.
--    · las comisiones incluyen la de amortización.
-- ---------------------------------------------------------------------------
create or replace view public.v_loan_status with (security_invoker = true) as
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
       case when l.status = 'ACTIVO' then s.fin - l.last_generated_period else 0 end::integer
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
       l.interest_category_id,
       l.counts_full_installment,
       s.fin::integer as effective_term_months,
       coalesce(ap.total, 0)::bigint as prepaid_total_cents,
       (o.intereses - s.intereses_totales)::bigint as interest_saved_cents
from public.loan l
cross join lateral (
  select coalesce(
           (array_agg(p.payment_cents order by p.period) filter (where p.period > l.last_generated_period))[1],
           max(p.payment_cents) filter (where p.period = 1)) as cuota,
         (array_agg(p.payment_cents order by p.period desc))[1] as ultima,
         sum(p.interest_cents)::bigint as intereses_totales,
         coalesce(sum(p.interest_cents) filter (where p.period < l.tracked_from_period), 0)::bigint
           as intereses_previos,
         coalesce(sum(p.interest_cents) filter (where p.period > l.last_generated_period), 0)::bigint
           as intereses_pendientes,
         -- Lo que se debe según el cuadro tras la última cuota cobrada (y lo
         -- aportado tras ella). Antes de la primera: el principal menos lo
         -- aportado antes de la primera.
         coalesce(max(p.balance_after_cents) filter (where p.period = l.last_generated_period),
                  l.principal_cents - coalesce((
                    select sum(a.amount_cents) from public.loan_prepayment a
                    where a.user_id = l.user_id and a.loan_id = l.id and a.after_period = 0), 0))::bigint
           as pendiente_cuadro,
         min(p.period) filter (where p.period > l.last_generated_period) as siguiente,
         (array_agg(p.due_on order by p.period) filter (where p.period > l.last_generated_period))[1]
           as siguiente_fecha,
         (array_agg(p.payment_cents order by p.period) filter (where p.period > l.last_generated_period))[1]
           as siguiente_cuota,
         max(p.due_on) as fecha_fin,
         max(p.period) as fin
  from public.loan_cuadro(l.id) p
) s
-- Los intereses del cuadro del contrato: lo que se ahorra es la diferencia.
cross join lateral (
  select sum(p.interest_cents)::bigint as intereses
  from public.loan_plan(l.principal_cents, l.term_months, l.tin_pct, l.first_charge_on) p
) o
cross join lateral (
  select public.loan_tae(l.principal_cents, l.term_months, l.tin_pct, l.opening_fee_cents) as calc
) tae
left join public.v_account_balance b
  on b.account_id = l.liability_account_id and b.user_id = l.user_id
left join lateral (
  select sum(t.amount_cents) filter (where t.loan_part = 'INTERESES') as intereses,
         sum(t.amount_cents) filter (
           where t.loan_part in ('COMISION', 'COMISION_CANCELACION', 'COMISION_AMORTIZACION')) as comisiones
  from public.transaction t
  where t.user_id = l.user_id and t.loan_id = l.id and t.status <> 'DISCARDED'
) tx on true
left join lateral (
  select sum(a.amount_cents) as total
  from public.loan_prepayment a
  where a.user_id = l.user_id and a.loan_id = l.id
) ap on true;


-- ---------------------------------------------------------------------------
-- 9. claim_loan_installment_notices — el importe de las cuotas del cuadro
--    efectivo, y «cuota k de N» con N el fin efectivo.
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
    select max(p.period), coalesce(sum(p.payment_cents) filter (
             where p.period between greatest(l.notified_period + 1, l.tracked_from_period)
                                and l.last_generated_period), 0)::bigint
      into term_months, amount_cents
    from public.loan_cuadro(l.id) p;
    return next;
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- 10. register_loan_prepayment — registrar una aportación.
-- ---------------------------------------------------------------------------
create or replace function public.register_loan_prepayment(
  p_loan_id      uuid,
  p_on           date,
  p_amount_cents bigint,
  p_mode         text,
  p_fee_cents    bigint default 0
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select private.current_user_id());
  v_hoy     date := private.hoy();
  v_on      date := coalesce(p_on, private.hoy());
  v_fee     bigint := coalesce(p_fee_cents, 0);
  l         public.loan%rowtype;
  v_ultima  date;
  v_real    bigint;
  v_cuadro  bigint;
  v_tx      uuid;
  v_tx_fee  uuid;
  v_cat     uuid;
  v_id      uuid;
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('PLAZO', 'CUOTA') then
    raise exception 'Elige si la aportación reduce el plazo o la cuota' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents < 100 or p_amount_cents > 100000000000 then
    raise exception 'La aportación tiene que ser de 1 € o más' using errcode = '22023';
  end if;
  if v_fee < 0 or v_fee > 100000000 then
    raise exception 'La comisión no es válida' using errcode = '22023';
  end if;

  select * into l from public.loan where id = p_loan_id and user_id = v_uid for update;
  if not found then
    raise exception 'Préstamo no encontrado' using errcode = 'P0002';
  end if;
  if l.status <> 'ACTIVO' then
    raise exception 'Este préstamo ya no está activo' using errcode = '22023';
  end if;
  if v_on > v_hoy or v_on < l.start_on then
    raise exception 'La fecha de la aportación tiene que estar entre el inicio del préstamo y hoy' using errcode = '22023';
  end if;

  -- Lo vencido hasta esa fecha se cobra antes, con el cuadro de antes.
  perform private.loan_generate(v_uid, l.id, v_on, true);
  select * into l from public.loan where id = p_loan_id;
  if l.status <> 'ACTIVO' then
    raise exception 'Con las cuotas de hasta esa fecha el préstamo ya está pagado' using errcode = '22023';
  end if;

  -- No antes de una cuota ya cobrada: se aplica tras la última.
  if l.last_generated_period >= 1 then
    select p.due_on into v_ultima from public.loan_cuadro(l.id) p where p.period = l.last_generated_period;
    if v_on < v_ultima then
      raise exception 'Ya hay una cuota cobrada después de esa fecha' using errcode = '22023';
    end if;
  end if;

  -- Menos de lo que se debe: lo real (la cuenta) y lo del cuadro. Igual o más
  -- es liquidar.
  select (-b.balance_cents)::bigint into v_real
  from public.v_account_balance b where b.account_id = l.liability_account_id;
  select s.schedule_pending_cents into v_cuadro
  from public.v_loan_status s where s.loan_id = l.id;
  if p_amount_cents >= least(coalesce(v_real, 0), coalesce(v_cuadro, 0)) then
    raise exception 'Eso es todo lo que queda o más: para pagarlo entero, usa «Pagar todo lo que queda»'
      using errcode = '22023';
  end if;

  -- Doble envío (doble toque, respuesta perdida y reintento): la misma aportación
  -- hace menos de dos minutos es la misma, no otra. El préstamo está bloqueado
  -- (for update), así que dos envíos a la vez no se cruzan.
  if exists (
    select 1 from public.loan_prepayment a
    where a.user_id = v_uid and a.loan_id = l.id
      and a.amount_cents = p_amount_cents and a.mode = p_mode and a.paid_on = v_on
      and a.created_at > now() - interval '2 minutes'
  ) then
    raise exception 'Esa misma aportación ya está registrada: si es otra, espera un par de minutos'
      using errcode = '23514';
  end if;

  insert into public.transaction (
    user_id, type, amount_cents, description, occurred_on,
    account_id, to_account_id, source, status, loan_id, loan_part
  )
  values (
    v_uid, 'TRANSFER', p_amount_cents,
    format('Aportación extra · %s (%s)', l.name,
           case p_mode when 'PLAZO' then 'reduce plazo' else 'reduce cuota' end),
    v_on, l.payment_account_id, l.liability_account_id, 'MANUAL', 'CONFIRMED', l.id, 'AMORTIZACION'
  )
  returning id into v_tx;

  if v_fee > 0 then
    v_cat := coalesce(l.interest_category_id, private.loan_interest_category(v_uid));
    if l.interest_category_id is null then
      update public.loan set interest_category_id = v_cat, interest_category_type = 'EXPENSE'
       where id = l.id;
    end if;
    insert into public.transaction (
      user_id, type, amount_cents, description, occurred_on,
      account_id, category_id, category_type, source, status, loan_id, loan_part
    )
    values (
      v_uid, 'EXPENSE', v_fee, format('Comisión de amortización · %s', l.name), v_on,
      l.payment_account_id, v_cat, 'EXPENSE', 'MANUAL', 'CONFIRMED', l.id, 'COMISION_AMORTIZACION'
    )
    returning id into v_tx_fee;
  end if;

  insert into public.loan_prepayment (
    user_id, loan_id, after_period, paid_on, amount_cents, mode, fee_cents,
    transaction_id, transaction_type, fee_transaction_id, fee_transaction_type
  )
  values (
    v_uid, l.id, l.last_generated_period, v_on, p_amount_cents, p_mode, v_fee,
    v_tx, 'TRANSFER', v_tx_fee, case when v_tx_fee is null then null else 'EXPENSE'::public.entry_type end
  )
  returning id into v_id;

  -- El cuadro nuevo tiene que poder calcularse (si no, lanza y no queda nada).
  perform count(*) from public.loan_cuadro(l.id);

  -- Y lo que ya toque hasta hoy, con el cuadro nuevo.
  perform private.loan_generate(v_uid, l.id, v_hoy, true);

  return jsonb_build_object('prepayment_id', v_id, 'after_period', l.last_generated_period);
end $$;

revoke all on function public.register_loan_prepayment(uuid, date, bigint, text, bigint) from public, anon;
grant execute on function public.register_loan_prepayment(uuid, date, bigint, text, bigint) to authenticated;


-- ---------------------------------------------------------------------------
-- 11. undo_loan_prepayment — deshacer la ÚLTIMA aportación, mientras no se
--     haya cobrado ninguna cuota con el cuadro que dejó.
-- ---------------------------------------------------------------------------
create or replace function public.undo_loan_prepayment(p_prepayment_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select private.current_user_id());
  a     public.loan_prepayment%rowtype;
  l     public.loan%rowtype;
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  select * into a from public.loan_prepayment where id = p_prepayment_id and user_id = v_uid;
  if not found then
    raise exception 'Aportación no encontrada' using errcode = 'P0002';
  end if;
  select * into l from public.loan where id = a.loan_id and user_id = v_uid for update;

  if exists (
    select 1 from public.loan_prepayment o
    where o.user_id = v_uid and o.loan_id = a.loan_id and o.id <> a.id
      and (o.after_period, o.created_at, o.id) > (a.after_period, a.created_at, a.id)
  ) then
    raise exception 'Solo se puede deshacer la última aportación' using errcode = '23514';
  end if;
  if l.last_generated_period > a.after_period or l.status <> 'ACTIVO' then
    raise exception 'Ya se ha cobrado alguna cuota con esta aportación: deshacerla dejaría esas cuotas mal'
      using errcode = '23514';
  end if;

  -- Borrar su traspaso la borra a ella (cascada). La marca abre el paso al
  -- disparador que protege las aportaciones, solo para este movimiento.
  perform set_config('cartera.aportacion_a_deshacer', a.transaction_id::text, true);
  if a.fee_transaction_id is not null then
    delete from public.transaction t where t.user_id = v_uid and t.id = a.fee_transaction_id;
  end if;
  delete from public.transaction t where t.user_id = v_uid and t.id = a.transaction_id;
  perform set_config('cartera.aportacion_a_deshacer', '', true);
end $$;

revoke all on function public.undo_loan_prepayment(uuid) from public, anon;
grant execute on function public.undo_loan_prepayment(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 12. El movimiento de una aportación no se borra ni se cambia a mano: el
--     cuadro depende de él. Pasa en la baja del usuario (cascada), en
--     delete_loan y en undo_loan_prepayment. Editar la nota o la descripción
--     sí se puede.
-- ---------------------------------------------------------------------------
create or replace function private.tg_aportacion_protegida()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_catalog.pg_trigger_depth() > 1
     or coalesce(pg_catalog.current_setting('cartera.prestamo_a_borrar', true), '') = old.loan_id::text
     or coalesce(pg_catalog.current_setting('cartera.aportacion_a_deshacer', true), '') = old.id::text then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'UPDATE'
     and (new.amount_cents, new.account_id, new.to_account_id, new.type, new.status,
          new.occurred_on, new.loan_id, new.loan_part)
         is not distinct from
         (old.amount_cents, old.account_id, old.to_account_id, old.type, old.status,
          old.occurred_on, old.loan_id, old.loan_part) then
    return new;
  end if;

  raise exception 'Esta aportación forma parte del cuadro del préstamo: si quieres quitarla, deshazla desde el préstamo.'
    using errcode = '55000';
end $$;

revoke all on function private.tg_aportacion_protegida() from public, anon;

create trigger tx_aportacion_protegida
  before delete or update on public.transaction
  for each row when (old.loan_part = 'AMORTIZACION')
  execute function private.tg_aportacion_protegida();


-- ---------------------------------------------------------------------------
-- 13. delete_loan — la marca va ANTES de borrar los movimientos, para que el
--     disparador deje pasar las aportaciones. Lo demás, igual.
-- ---------------------------------------------------------------------------
create or replace function public.delete_loan(p_loan_id uuid, p_confirm_name text)
returns jsonb
language plpgsql
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

  -- 1. Los movimientos del préstamo, estén en la cuenta que estén (las
  --    aportaciones caen en cascada con su traspaso).
  perform set_config('cartera.prestamo_a_borrar', l.id::text, true);
  delete from public.transaction t where t.user_id = v_uid and t.loan_id = l.id;
  get diagnostics v_movimientos = row_count;

  -- 2. El préstamo: abre la política SOLO para esta fila y SOLO aquí.
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


-- ---------------------------------------------------------------------------
-- 14. update_loan_terms — no con aportaciones: se calcularon con las
--     condiciones de ahora. Lo demás, igual.
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
set search_path = ''
as $$
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
  if exists (select 1 from public.loan_prepayment a where a.user_id = v_uid and a.loan_id = l.id) then
    raise exception 'Este préstamo tiene aportaciones extra: deshazlas antes de cambiar las condiciones'
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
