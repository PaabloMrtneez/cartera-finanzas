-- ===========================================================================
-- Arreglos baratos del cierre de la v1 (docs/pruebas/informe-datos.md):
-- M3, B1, B3, B5 y B6. Prueba: scripts/test-arreglos-menores.mjs.
--
--  M3. v_net_worth leía v_account_balance TRES veces (caja, sin desplegar y
--      deuda), cada una con su LATERAL por cuenta sobre la unión de los
--      movimientos. Ahora una sola, materializada, y las tres partes salen de
--      una única agregación. Mismas columnas, mismos tipos, mismas cifras.
--  B1. account_delete_preview trae los préstamos que usan la cuenta (como
--      cuenta de pago o como su cuenta-pasivo), con su papel: así la pantalla
--      puede avisar de que no se puede borrar ANTES de pedir el nombre.
--  B3. Dos índices redundantes en transaction, que se tocan en cada alta:
--      transaction_user_id_id_key (único (user_id, id): la PK (id) ya es única,
--      0 usos, ninguna FK lo usa —las FK van a (user_id, id, type)—) y
--      tx_recurring_income_idx (prefijo exacto de tx_recurring_income_period_uq).
--  B5. Índices de apoyo para las FK compuestas que no tenían (tablas pequeñas:
--      hoy no se nota; al borrar una cuenta o una categoría se recorrían
--      enteras).
--  B6. net_worth_daily, net_worth_monthly y account_balance_monthly estaban
--      concedidas a service_role, pero usan private.account_worth_on /
--      position_value_on, que no: como servicio fallaban con 42501. Nadie las
--      llama como servicio (son por usuario, con su sesión): se retira el
--      permiso, que es lo coherente.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- M3. v_net_worth de una pasada.
-- ---------------------------------------------------------------------------
create or replace view public.v_net_worth with (security_invoker = true) as
with saldos as materialized (
  select b.user_id, b.account_id, b.type::text as tipo, b.balance_cents
  from public.v_account_balance b
),
aportado as (
  -- Lo aportado a las posiciones de cada cuenta de inversión: lo que no está
  -- «sin desplegar» porque ya está dentro de un fondo.
  select p.account_id, coalesce(sum(c.contributed_cents), 0::numeric) as cents
  from public.v_position_contributions c
  join public.investment_position p on p.id = c.position_id
  group by p.account_id
),
cuentas as (
  select s.user_id,
         coalesce(sum(s.balance_cents) filter (where s.tipo not in ('INVERSION', 'PRESTAMO')), 0::numeric)::bigint
           as caja,
         coalesce(sum(s.balance_cents) filter (where s.tipo = 'INVERSION'), 0::numeric)::bigint
           - coalesce(sum(a.cents) filter (where s.tipo = 'INVERSION'), 0::numeric)::bigint
           as sin_desplegar,
         coalesce(sum(s.balance_cents) filter (where s.tipo = 'PRESTAMO'), 0::numeric)::bigint
           as deuda
  from saldos s
  left join aportado a on a.account_id = s.account_id
  group by s.user_id
),
invertido as (
  select v.user_id, coalesce(sum(v.value_cents), 0::numeric)::bigint as cents
  from public.v_position_value v
  where not v.archived
  group by v.user_id
)
select coalesce(c.user_id, i.user_id) as user_id,
       coalesce(c.caja, 0::bigint) + coalesce(i.cents, 0::bigint)
         + coalesce(c.sin_desplegar, 0::bigint) + coalesce(c.deuda, 0::bigint) as net_worth_cents,
       coalesce(c.caja, 0::bigint)          as cash_cents,
       coalesce(i.cents, 0::bigint)         as invested_cents,
       coalesce(c.sin_desplegar, 0::bigint) as idle_cents,
       coalesce(c.deuda, 0::bigint)         as debt_cents
from cuentas c
full join invertido i on i.user_id = c.user_id;

-- ---------------------------------------------------------------------------
-- B1. La vista previa de borrar una cuenta, con sus préstamos.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_delete_preview(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_uid    uuid := (select private.current_user_id());
  v_cuenta public.account%rowtype;
begin
  if v_uid is null then
    raise exception 'Sesión sin verificar' using errcode = '42501';
  end if;

  select * into v_cuenta
  from public.account a
  where a.id = p_account_id and a.user_id = v_uid;

  if not found then
    raise exception 'Cuenta no encontrada' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'account_id', v_cuenta.id,
    'name',       v_cuenta.name,
    'type',       v_cuenta.type,
    'archived',   v_cuenta.archived,

    'balance_cents', (
      select b.balance_cents::bigint
      from public.v_account_balance b
      where b.user_id = v_uid and b.account_id = p_account_id),
    'worth_cents', (
      select w.worth_cents::bigint
      from public.v_account_worth w
      where w.user_id = v_uid and w.account_id = p_account_id),

    'transactions', (
      select jsonb_build_object(
               'total',     count(*),
               'expenses',  count(*) filter (where t.type = 'EXPENSE'),
               'incomes',   count(*) filter (where t.type = 'INCOME'),
               'transfers', count(*) filter (where t.type = 'TRANSFER'))
      from public.transaction t
      where t.user_id = v_uid
        and (t.account_id = p_account_id or t.to_account_id = p_account_id)),

    'external_transfers', (
      select coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'account_id',          x.otra,
                   'name',                a.name,
                   'archived',            a.archived,
                   'transfers',           x.n,
                   'balance_delta_cents', x.delta)
                 order by abs(x.delta) desc, a.name),
               '[]'::jsonb)
      from (
        select case when t.account_id = p_account_id then t.to_account_id else t.account_id end as otra,
               count(*) as n,
               coalesce(sum(
                 case
                   when t.status = 'DISCARDED'        then 0
                   -- Salió de esta y entró en la otra: al borrarlo, la otra baja.
                   when t.account_id = p_account_id   then -t.amount_cents
                   -- Salió de la otra hacia esta: al borrarlo, la otra sube.
                   else t.amount_cents
                 end), 0)::bigint as delta
        from public.transaction t
        where t.user_id = v_uid
          and t.type = 'TRANSFER'
          and (t.account_id = p_account_id or t.to_account_id = p_account_id)
        group by 1
      ) x
      join public.account a on a.user_id = v_uid and a.id = x.otra),

    'cards', (
      select count(*) from public.card c
      where c.user_id = v_uid and c.account_id = p_account_id),
    'positions', (
      select count(*) from public.investment_position p
      where p.user_id = v_uid and p.account_id = p_account_id),
    'valuations', (
      select count(*)
      from public.valuation v
      join public.investment_position p on p.user_id = v.user_id and p.id = v.position_id
      where v.user_id = v_uid and p.account_id = p_account_id),
    'subscriptions', (
      select count(*) from public.subscription s
      where s.user_id = v_uid and s.account_id = p_account_id),
    'recurring_incomes', (
      select count(*) from public.recurring_income r
      where r.user_id = v_uid and r.account_id = p_account_id),
    'goals', (
      select count(*) from public.savings_goal g
      where g.user_id = v_uid and g.account_id = p_account_id),

    'cross_reimbursements', jsonb_build_object(
      'incomes_elsewhere', (
        select jsonb_build_object('count', count(*), 'cents', coalesce(sum(i.amount_cents), 0)::bigint)
        from public.transaction i
        join public.transaction g on g.user_id = i.user_id and g.id = i.reimburses_id
        where i.user_id = v_uid
          and g.account_id = p_account_id
          and i.account_id <> p_account_id
          and i.status <> 'DISCARDED'),
      'expenses_elsewhere', (
        select jsonb_build_object('count', count(*), 'cents', coalesce(sum(i.amount_cents), 0)::bigint)
        from public.transaction i
        join public.transaction g on g.user_id = i.user_id and g.id = i.reimburses_id
        where i.user_id = v_uid
          and i.account_id = p_account_id
          and g.account_id <> p_account_id
          and i.status <> 'DISCARDED')),

    -- B1: los préstamos que la usan. delete_account no puede borrar una cuenta
    -- de la que cuelga un préstamo (las FK lo impiden); dicho aquí, el aviso
    -- llega ANTES de pedir el nombre y no como error del borrado.
    'loans', (
      select coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'loan_id', l.id,
                   'name',    l.name,
                   'status',  l.status,
                   'role',    case when l.payment_account_id = p_account_id then 'PAGO' else 'PASIVO' end)
                 order by l.name),
               '[]'::jsonb)
      from public.loan l
      where l.user_id = v_uid
        and (l.payment_account_id = p_account_id or l.liability_account_id = p_account_id)),

    'shortcut_default', coalesce((
      select pr.default_ingest_account_id = p_account_id
      from public.profile pr
      where pr.user_id = v_uid), false),
    'active_devices', (
      select count(*)
      from public.ingest_device d
      join public.profile pr on pr.user_id = d.user_id
      where d.user_id = v_uid
        and d.revoked_at is null
        and pr.default_ingest_account_id = p_account_id)
  );
end $function$;

-- ---------------------------------------------------------------------------
-- B3. Índices redundantes.
-- ---------------------------------------------------------------------------
alter table public.transaction drop constraint transaction_user_id_id_key;
drop index public.tx_recurring_income_idx;

-- ---------------------------------------------------------------------------
-- B5. Índices de apoyo para las FK compuestas.
-- ---------------------------------------------------------------------------
create index if not exists budget_category_fk_idx
  on public.budget (user_id, category_id);
create index if not exists budget_alert_budget_fk_idx
  on public.budget_alert (user_id, budget_id);
create index if not exists ingest_dead_letter_device_fk_idx
  on public.ingest_dead_letter (device_id) where device_id is not null;
create index if not exists investment_position_account_fk_idx
  on public.investment_position (user_id, account_id);
create index if not exists loan_interest_category_fk_idx
  on public.loan (user_id, interest_category_id) where interest_category_id is not null;
create index if not exists merchant_rule_category_fk_idx
  on public.merchant_rule (user_id, category_id);
create index if not exists recurring_income_account_fk_idx
  on public.recurring_income (user_id, account_id);
create index if not exists recurring_income_category_fk_idx
  on public.recurring_income (user_id, category_id) where category_id is not null;
create index if not exists subscription_account_fk_idx
  on public.subscription (user_id, account_id);
create index if not exists subscription_category_fk_idx
  on public.subscription (user_id, category_id) where category_id is not null;

-- ---------------------------------------------------------------------------
-- B6. Permisos coherentes.
-- ---------------------------------------------------------------------------
revoke execute on function public.net_worth_daily(date, date)          from service_role;
revoke execute on function public.net_worth_monthly(integer)           from service_role;
revoke execute on function public.account_balance_monthly(integer)     from service_role;
