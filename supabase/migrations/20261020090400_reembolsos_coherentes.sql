-- ===========================================================================
-- Reembolsos coherentes (invariante 4: un reembolso abarata un gasto, nunca es
-- un ingreso).
--
-- Cierre de la v1: hallazgos M1 y M2 de docs/pruebas/informe-datos.md.
-- Prueba: scripts/test-reembolsos.mjs y test-casos-limite.mjs.
--
-- ── LOS TRES AGUJEROS ──────────────────────────────────────────────────────
--  M1. Borrar un gasto reembolsado convertía en silencio su reembolso en un
--      INGRESO: la FK es `on delete set null (reimburses_id, …)`.
--  M2a. El reembolso de un gasto DESCARTADO seguía restando: v_transaction_econ
--      no miraba el estado del gasto enlazado (gasto del mes en negativo).
--  M2b. Nada impedía que los reembolsos de un gasto sumaran más que el gasto
--      (la categoría quedaba en negativo).
--
-- ── LAS DECISIONES ─────────────────────────────────────────────────────────
--  M1 → BLOQUEAR el borrado de un gasto que tiene reembolsos vivos, con un
--      mensaje que dice qué hacer. Por qué bloquear y no las otras dos:
--        · borrar también el reembolso cambiaría el saldo de su cuenta (ese
--          dinero entró de verdad) sin que el usuario lo haya pedido;
--        · desenlazarlo lo convertiría en ingreso, que es justo el error.
--      Quien quiere borrar el gasto decide primero qué hacer con el reembolso
--      (borrarlo, o editarlo y quitarle el enlace, y entonces SÍ es un ingreso
--      porque lo ha dicho él). Excepciones, que ya son explícitas:
--        · delete_account: su vista previa avisa con cifra de los reembolsos
--          de otras cuentas que «dejarán de ser reembolsos y contarán como
--          ingresos» y pide escribir el nombre; se mantiene ese contrato;
--        · el borrado en cascada (darse de baja: se va todo el usuario);
--        · las cuotas de un préstamo (loan_id), que solo borra delete_loan.
--      Un reembolso DESCARTADO no bloquea: no cuenta en ninguna cifra (y la FK
--      lo desenlaza como hasta ahora).
--  M2a → En v_transaction_econ, el reembolso de un gasto descartado no existe
--      económicamente: ni resta del gasto ni suma como ingreso (sale de la
--      vista, igual que el gasto). Así gasto bruto − reembolsado = gasto neto
--      sigue cuadrando en v_month_summary, en el reparto, los comercios, el
--      mapa de calor y las tarjetas, que leen de ella. La previsión y el total
--      de la búsqueda, que restan reembolsos por su cuenta, igual.
--  M2b → Un disparador rechaza (23514, mensaje en español) un reembolso que
--      haga que los reembolsos vivos de un gasto superen su importe, y bajar
--      el importe de un gasto por debajo de lo ya reembolsado. Bloquea la fila
--      del gasto (FOR UPDATE) para que dos reembolsos a la vez no se cuelen.
--      En producción no hay hoy ningún caso que lo incumpla (comprobado: 0).
--
-- Seguridad: los disparadores son security invoker con search_path = '' (leen
-- solo filas del propio usuario, por la misma RLS); la vista sigue
-- security_invoker = true.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. v_transaction_econ: el reembolso de un gasto descartado no cuenta.
--    Mismas columnas y mismo orden; solo cambia el WHERE.
-- ---------------------------------------------------------------------------
create or replace view public.v_transaction_econ with (security_invoker = true) as
select t.user_id,
       t.id,
       t.period_month,
       t.occurred_on,
       t.type,
       t.amount_cents,
       t.status,

       case when t.reimburses_id is not null then r.category_id else t.category_id end
         as econ_category_id,

       case
         when t.type = 'EXPENSE'                                then  t.amount_cents
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
where t.status <> 'DISCARDED'
  and t.type <> 'TRANSFER'
  -- Un reembolso de un gasto descartado no abarata nada (ni es un ingreso).
  and (t.reimburses_id is null or r.status <> 'DISCARDED');

-- ---------------------------------------------------------------------------
-- 2. Los reembolsos vivos de un gasto no superan su importe.
-- ---------------------------------------------------------------------------
create or replace function private.euros(p_cents bigint)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- 1234567 → «12345,67 €». Solo para mensajes de error.
  select pg_catalog.replace(pg_catalog.to_char(p_cents / 100.0, 'FM999999999990.00'), '.', ',') || ' €';
$$;

revoke all on function private.euros(bigint) from public;
grant execute on function private.euros(bigint) to authenticated, service_role;

create or replace function private.tg_reembolso_no_supera_gasto()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_gasto      bigint;
  v_estado     public.tx_status;
  v_otros      bigint;
begin
  -- a) Una fila que reembolsa algo (alta, o cambio de importe, enlace o estado).
  if new.reimburses_id is not null and new.status <> 'DISCARDED' then
    select g.amount_cents, g.status into v_gasto, v_estado
    from public.transaction g
    where g.user_id = new.user_id and g.id = new.reimburses_id
    for update;

    -- Si no existe, ya protestará la FK compuesta.
    if found then
      select coalesce(sum(r.amount_cents), 0) into v_otros
      from public.transaction r
      where r.user_id = new.user_id
        and r.reimburses_id = new.reimburses_id
        and r.status <> 'DISCARDED'
        and r.id <> new.id;

      if v_otros + new.amount_cents > v_gasto then
        raise exception '%', case
            when v_otros = 0 then format(
              'Un reembolso no puede ser mayor que el gasto que reembolsa (%s).',
              private.euros(v_gasto))
            else format(
              'Ese gasto ya tiene %s reembolsados de %s: este reembolso puede ser, como mucho, de %s.',
              private.euros(v_otros), private.euros(v_gasto), private.euros(greatest(v_gasto - v_otros, 0)))
          end
          using errcode = '23514';
      end if;
    end if;
  end if;

  -- b) Un gasto al que se le baja el importe por debajo de lo ya reembolsado.
  if tg_op = 'UPDATE' and new.type = 'EXPENSE' and new.amount_cents < old.amount_cents then
    select coalesce(sum(r.amount_cents), 0) into v_otros
    from public.transaction r
    where r.user_id = new.user_id
      and r.reimburses_id = new.id
      and r.status <> 'DISCARDED';

    if v_otros > new.amount_cents then
      raise exception '%', format(
          'Este gasto tiene %s en reembolsos: su importe no puede bajar de ahí.',
          private.euros(v_otros))
        using errcode = '23514';
    end if;
  end if;

  return new;
end $$;

create trigger tx_reembolso_no_supera_gasto
  before insert or update of amount_cents, reimburses_id, status, type
  on public.transaction
  for each row execute function private.tg_reembolso_no_supera_gasto();

-- ---------------------------------------------------------------------------
-- 3. No se borra un gasto con reembolsos vivos (salvo los casos explícitos).
-- ---------------------------------------------------------------------------
create or replace function private.tg_gasto_con_reembolsos()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_n     bigint;
  v_cents bigint;
begin
  if old.type <> 'EXPENSE'
     -- Borrado en cascada (baja del usuario): se va todo a la vez.
     or pg_catalog.pg_trigger_depth() > 1
     -- delete_account: lo ha avisado su vista previa y se ha confirmado.
     or coalesce(pg_catalog.current_setting('cartera.cuenta_a_borrar', true), '') = old.account_id::text
     -- Las cuotas de un préstamo las borra delete_loan con el préstamo.
     or old.loan_id is not null then
    return old;
  end if;

  select count(*), coalesce(sum(r.amount_cents), 0) into v_n, v_cents
  from public.transaction r
  where r.user_id = old.user_id
    and r.reimburses_id = old.id
    and r.status <> 'DISCARDED';

  if v_n > 0 then
    raise exception '%', format(
        'Este gasto tiene %s (%s). Bórralos o quítales el enlace antes de borrar el gasto: si no, ese dinero pasaría a contar como ingreso.',
        case when v_n = 1 then 'un reembolso' else v_n || ' reembolsos' end,
        private.euros(v_cents))
      using errcode = '55000';
  end if;

  return old;
end $$;

create trigger tx_gasto_con_reembolsos
  before delete on public.transaction
  for each row execute function private.tg_gasto_con_reembolsos();

-- ---------------------------------------------------------------------------
-- 4. Los demás sitios que restan reembolsos por su cuenta: la previsión del
--    mes y por categoría (reembolsos de cargos fijos ya cobrados) y el total
--    de la búsqueda. La definición vigente con ese único cambio.
-- ---------------------------------------------------------------------------

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
        -- El reembolso de un gasto descartado no resta (20261020090400).
        and ex.status <> 'DISCARDED'
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

CREATE OR REPLACE FUNCTION public.search_transactions(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_type public.entry_type DEFAULT NULL::public.entry_type, p_account uuid DEFAULT NULL::uuid, p_category uuid DEFAULT NULL::uuid, p_uncategorized boolean DEFAULT false, p_only_shortcut boolean DEFAULT false, p_only_pending boolean DEFAULT false, p_q text DEFAULT NULL::text, p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, user_id uuid, type public.entry_type, amount_cents bigint, description text, occurred_on date, occurred_time time without time zone, occurred_at timestamp with time zone, account_id uuid, to_account_id uuid, category_id uuid, category_type public.entry_type, note text, reimburses_id uuid, reimburses_target_type public.entry_type, source public.tx_source, status public.tx_status, merchant_raw text, card_last4 text, external_id text, device_id uuid, subscription_id uuid, position_id uuid, period_month date, total_count bigint, total_net_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with filtrados as (
    select t.*
    from public.transaction t
    where t.status <> 'DISCARDED'
      and (p_from is null or t.occurred_on >= p_from)
      and (p_to   is null or t.occurred_on <= p_to)
      and (p_type is null or t.type = p_type)
      and (p_account is null or t.account_id = p_account)
      -- «Sin categoría» no es una fila: es la ausencia de una.
      and (not p_uncategorized or t.category_id is null)
      and (p_category is null or t.category_id = p_category)
      and (not p_only_shortcut or t.source = 'SHORTCUT')
      and (not p_only_pending  or t.status = 'PENDING')
      -- Los cuatro campos que busca el prototipo, los cuatro en la base. Las
      -- categorías y cuentas que casan se buscan una vez, no por movimiento.
      and (
        p_q is null or p_q = '' or
        t.description  ilike '%' || p_q || '%' or
        t.merchant_raw ilike '%' || p_q || '%' or
        -- Sin correlación con t (si no, el subplan no se puede «hashear» y
        -- vuelve a ser por fila). No hace falta: un id es único y la FK
        -- compuesta ya ata t.category_id / t.account_id al mismo usuario.
        t.category_id in (
          select c.id from public.category c where c.name ilike '%' || p_q || '%'
        ) or
        t.account_id in (
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
               when f.type = 'EXPENSE'                              then  f.amount_cents
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
  order by occurred_on desc, occurred_time desc, created_at desc
  limit greatest(p_limit, 1);
$function$;

