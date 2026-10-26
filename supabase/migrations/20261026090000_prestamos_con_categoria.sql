-- ===========================================================================
-- Préstamos con categoría, y la cuota entera como gasto si se pide.
--
-- Prueba: scripts/test-prestamos-categoria.mjs.
--
-- ── LO QUE HABÍA ───────────────────────────────────────────────────────────
-- Cada cuota se apunta en dos partes (20261013090100_prestamos.sql): los
-- INTERESES, como gasto en la categoría «Intereses» (creada sola), y el
-- CAPITAL, como traspaso a la cuenta-pasivo. El traspaso no es gasto
-- (invariante 3), así que de una cuota de 350 € solo contaban los 40 € de
-- intereses, y siempre en «Intereses».
--
-- Es lo correcto cuando la COMPRA ya está apuntada (el préstamo pagó un coche
-- que ya cuenta como gasto en «Coche»): contar también el capital la contaría
-- dos veces. Pero si la compra no está apuntada —un préstamo que ya existía,
-- o uno cuyo dinero no se apuntó como gasto—, la cuota es lo único que dice
-- cuánto cuesta, y no aparecía en el gasto, ni en el reparto, ni en los límites.
--
-- ── LO QUE CAMBIA ──────────────────────────────────────────────────────────
-- 1. La categoría la elige quien da de alta el préstamo, y se cambia siempre.
--    Es `interest_category_id`, que ya existía; si no se elige, sigue siendo
--    «Intereses» como hasta ahora. Al cambiarla, los intereses y comisiones ya
--    apuntados pasan a la nueva (salvo los que se recategorizaron a mano).
-- 2. `counts_full_installment`: cada préstamo elige si cuenta como gasto SOLO
--    LOS INTERESES (por defecto; lo de siempre) o LA CUOTA ENTERA. Con la cuota
--    entera, el capital de cada cuota —y el pago de lo pendiente al liquidar—
--    cuenta como gasto en la categoría del préstamo.
--
-- ── CÓMO, SIN ROMPER LOS SALDOS ────────────────────────────────────────────
-- El capital SIGUE SIENDO UN TRASPASO en `transaction`: es lo que baja la deuda
-- en la cuenta-pasivo, y los saldos y el patrimonio (v_account_movement) no
-- cambian en nada. Lo único que cambia es su lectura ECONÓMICA: en
-- `v_transaction_econ`, el capital y la liquidación de un préstamo con la
-- cuota entera salen como GASTO de la categoría del préstamo. Es una excepción
-- acotada a la invariante 3, decidida por préstamo y escrita en un solo sitio:
-- todo lo que lee de esa vista (resumen del mes, reparto, límites, comparativas,
-- comercios, tarjetas, mapa de calor, cierres) la hereda sin tocarlo.
--
-- La categoría de esas filas es la DEL PRÉSTAMO (no la del movimiento): así no
-- se pierde si se edita la nota de una cuota, ni hace falta reescribir el
-- historial al cambiarla. Lo que no lee de la vista se ajusta aquí a mano:
--   · month_forecast y category_forecast: el capital ya cobrado es recurrente
--     (no se extrapola como gasto suelto) y el que falta este mes se suma a lo
--     fijo que viene, como ya se hacía con los intereses;
--   · account_spend_history (gasto por cuenta): ahora lee de la vista;
--   · search_transactions: el filtro de tipo, el de categoría y el total de la
--     búsqueda tratan esas filas como gasto de su categoría, igual que el resumen.
--
-- Por defecto es `false`: ningún préstamo existente cambia, y las cifras de
-- todos los usuarios quedan idénticas (lo comprueba la prueba).
--
-- Seguridad: la vista sigue security_invoker = true (el join a `loan` pasa por
-- la RLS de quien consulta); las funciones son security invoker con
-- search_path = ''; la categoría se valida contra el usuario, y además la FK
-- compuesta (user_id, interest_category_id, interest_category_type) lo impone.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. La opción, por préstamo.
-- ---------------------------------------------------------------------------
alter table public.loan
  add column counts_full_installment boolean not null default false;

comment on column public.loan.interest_category_id is
  'La categoría del préstamo: la de sus intereses y comisiones y, con counts_full_installment, la de la cuota entera. Vacía: «Intereses», que se crea sola.';
comment on column public.loan.counts_full_installment is
  'true: el capital de cada cuota (y la liquidación) cuenta como GASTO en la categoría del préstamo (v_transaction_econ). Sigue siendo un traspaso para los saldos.';


-- ---------------------------------------------------------------------------
-- 2. v_transaction_econ: el capital de un préstamo con la cuota entera es gasto.
--    Mismas columnas y mismo orden; cambian el FROM, el WHERE y tres CASE.
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
 and t.loan_part in ('CAPITAL', 'LIQUIDACION')
 and l.counts_full_installment
where t.status <> 'DISCARDED'
  -- Un traspaso no es gasto ni ingreso (invariante 3)… salvo esa excepción.
  and (t.type <> 'TRANSFER' or l.id is not null)
  -- Un reembolso de un gasto descartado no abarata nada (ni es un ingreso).
  and (t.reimburses_id is null or r.status <> 'DISCARDED');


-- ---------------------------------------------------------------------------
-- 3. La previsión del mes: el capital de la cuota entera es recurrente.
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
       and t.loan_part in ('CAPITAL', 'LIQUIDACION') and l.counts_full_installment
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
       and t.loan_part in ('CAPITAL', 'LIQUIDACION') and l.counts_full_installment
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
$$;


-- ---------------------------------------------------------------------------
-- 4. Gasto por cuenta: desde la vista, para que el capital de la cuota entera
--    cuente en la cuenta desde la que se paga. Sigue siendo el gasto BRUTO
--    cargado (los reembolsos no restan: ver 20260918090000).
-- ---------------------------------------------------------------------------
create or replace function public.account_spend_history(p_months integer default 6)
returns table (
  account_id   uuid,
  period_month date,
  gasto_cents  bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select generate_series(
             (date_trunc('month', private.hoy()) - make_interval(months => p_months - 1))::date,
             date_trunc('month', private.hoy())::date,
             interval '1 month'
           )::date as mes
  ),
  gastos as (
    select t.account_id, e.period_month, sum(e.amount_cents) as cents
    from public.v_transaction_econ e
    join public.transaction t
      on t.user_id = e.user_id and t.id = e.id
    where e.type = 'EXPENSE'
      and e.period_month in (select m.mes from meses m)
    group by t.account_id, e.period_month
  ),
  -- Solo las cuentas con algún gasto en la ventana: una cuenta de ahorro sin
  -- cargos no aporta una tendencia de gasto que mirar.
  cuentas as (
    select g.account_id
    from gastos g
    group by g.account_id
    having sum(g.cents) > 0
  )
  select c.account_id,
         m.mes,
         coalesce(g.cents, 0)::bigint
  from cuentas c
  cross join meses m
  left join gastos g
    on g.account_id = c.account_id and g.period_month = m.mes
  order by c.account_id, m.mes;
$$;


-- ---------------------------------------------------------------------------
-- 5. La búsqueda de movimientos: el capital de la cuota entera se filtra y se
--    suma como gasto de la categoría del préstamo. Devuelve las mismas
--    columnas, con el tipo y la categoría REALES del movimiento.
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
     and t.loan_part in ('CAPITAL', 'LIQUIDACION') and l.counts_full_installment
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
-- 6. La categoría de un préstamo: de gasto y del propio usuario. La FK
--    compuesta ya lo impone; esto es para dar un mensaje en español.
-- ---------------------------------------------------------------------------
create or replace function private.loan_check_category(p_user uuid, p_category_id uuid)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_category_id is not null and not exists (
    select 1 from public.category c
    where c.id = p_category_id and c.user_id = p_user and c.type = 'EXPENSE'
  ) then
    raise exception 'Esa categoría no existe o no es de gasto' using errcode = '22023';
  end if;
end $$;

revoke all on function private.loan_check_category(uuid, uuid) from public, anon;
grant execute on function private.loan_check_category(uuid, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 7. create_loan: con la categoría y la opción. Firma nueva (se borra la
--    anterior para no dejar dos sobrecargas); los dos parámetros nuevos tienen
--    valor por defecto, así que una llamada con los once de antes sigue valiendo
--    y hace lo de siempre (categoría «Intereses», solo los intereses).
-- ---------------------------------------------------------------------------
drop function public.create_loan(text, uuid, bigint, integer, numeric, numeric, bigint, integer, date, date, boolean);

create function public.create_loan(
  p_name                    text,
  p_payment_account_id      uuid,
  p_principal_cents         bigint,
  p_term_months             integer,
  p_tin_pct                 numeric,
  p_tae_pct                 numeric,
  p_opening_fee_cents       bigint,
  p_charge_day              integer,
  p_start_on                date,
  p_first_charge_on         date,
  p_disbursed               boolean,
  p_category_id             uuid    default null,
  p_counts_full_installment boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select private.current_user_id());
  v_hoy     date := private.hoy();
  v_nombre  text := btrim(coalesce(p_name, ''));
  v_entera  boolean := coalesce(p_counts_full_installment, false);
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
  perform private.loan_check_category(v_uid, p_category_id);
  -- La cuota entera en «Intereses» no tendría sentido: si cuenta entera, que
  -- sea en la categoría de lo que paga.
  if v_entera and p_category_id is null then
    raise exception 'Elige en qué categoría cuenta la cuota' using errcode = '22023';
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
    tracked_from_period, last_generated_period, notified_period,
    interest_category_id, interest_category_type, counts_full_installment
  )
  values (
    v_uid, v_nombre, p_payment_account_id, v_cuenta, 'PRESTAMO',
    p_principal_cents, p_term_months, p_tin_pct, p_tae_pct, coalesce(p_opening_fee_cents, 0),
    coalesce(p_charge_day, 1), p_start_on, v_terms.first_charge_on, p_disbursed,
    v_terms.tracked_from, v_terms.tracked_from - 1, v_terms.tracked_from - 1,
    p_category_id, case when p_category_id is null then null else 'EXPENSE'::public.entry_type end,
    v_entera
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

revoke all on function public.create_loan(text, uuid, bigint, integer, numeric, numeric, bigint, integer, date, date, boolean, uuid, boolean)
  from public, anon;
grant execute on function public.create_loan(text, uuid, bigint, integer, numeric, numeric, bigint, integer, date, date, boolean, uuid, boolean)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 8. update_loan: también la categoría y la opción, que se cambian siempre
--    (no tocan el cuadro ni los saldos, solo cómo se lee el gasto). NULL en
--    cualquiera de las dos es «no cambiar»: así la versión anterior de la app,
--    que llama con tres parámetros, no borra nada mientras se despliega.
-- ---------------------------------------------------------------------------
drop function public.update_loan(uuid, text, numeric);

create function public.update_loan(
  p_loan_id                 uuid,
  p_name                    text,
  p_tae_pct                 numeric,
  p_category_id             uuid    default null,
  p_counts_full_installment boolean default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid    uuid := (select private.current_user_id());
  v_nombre text := btrim(coalesce(p_name, ''));
  l        public.loan%rowtype;
  v_cat    uuid;
  v_entera boolean;
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

  select * into l from public.loan lo where lo.id = p_loan_id and lo.user_id = v_uid for update;
  if not found then
    raise exception 'Préstamo no encontrado' using errcode = 'P0002';
  end if;

  perform private.loan_check_category(v_uid, p_category_id);
  v_cat := coalesce(p_category_id, l.interest_category_id);
  v_entera := coalesce(p_counts_full_installment, l.counts_full_installment);
  if v_entera and v_cat is null then
    raise exception 'Elige en qué categoría cuenta la cuota' using errcode = '22023';
  end if;

  update public.loan lo
     set name = v_nombre,
         tae_pct = p_tae_pct,
         interest_category_id = v_cat,
         interest_category_type = case when v_cat is null then null else 'EXPENSE'::public.entry_type end,
         counts_full_installment = v_entera
   where lo.id = l.id;

  -- Los intereses y comisiones ya apuntados se van con la categoría: el gasto
  -- del préstamo queda junto. Los que se recategorizaron a mano se respetan
  -- (solo se mueven los que seguían en la categoría anterior). El capital no
  -- hace falta: su categoría es siempre la del préstamo (v_transaction_econ).
  if v_cat is distinct from l.interest_category_id then
    update public.transaction t
       set category_id = v_cat, category_type = 'EXPENSE'
     where t.user_id = v_uid
       and t.loan_id = l.id
       and t.type = 'EXPENSE'
       and t.category_id is not distinct from l.interest_category_id;
  end if;

  update public.account a
     set name = 'Préstamo · ' || v_nombre
   where a.user_id = v_uid and a.id = l.liability_account_id;
end $$;

revoke all on function public.update_loan(uuid, text, numeric, uuid, boolean) from public, anon;
grant execute on function public.update_loan(uuid, text, numeric, uuid, boolean) to authenticated;


-- ---------------------------------------------------------------------------
-- 9. v_loan_status: la opción, al final (mismas columnas antes).
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
       l.interest_category_id,
       l.counts_full_installment
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


-- ---------------------------------------------------------------------------
-- 10. loan_delete_preview: el «gasto que desaparece» cuenta también el capital
--     de la cuota entera (lo lee de v_transaction_econ). Lo demás, igual.
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
    'expense_cents', (select coalesce(sum(e.amount_cents), 0)
                      from public.v_transaction_econ e
                      join afectados a on a.id = e.id
                      where e.type = 'EXPENSE'),
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
