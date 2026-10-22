-- ===========================================================================
-- Gasto por cuenta y tarjeta, fuentes de ingreso y compromiso por suscripción.
--
-- Tres desgloses que los gráficos nuevos necesitan y que no existían:
--
--   · Cuentas · ranking de barras cuenta → sus tarjetas (public.card, de
--     20260924090000_varias_tarjetas_por_cuenta.sql): el gasto NETO del mes por
--     cuenta y, dentro, por tarjeta.
--   · Resumen · «fuentes de ingreso»: el ingreso real del mes por categoría,
--     contra el del mes anterior. category_breakdown solo mira el gasto.
--   · Suscripciones · «Compromiso, 12 meses» enseña escalones, pero al tocar
--     uno no hay forma de saber QUÉ suscripción entró o salió.
--
-- Las tres cuadran por construcción con la cifra que ya existe arriba:
-- v_month_summary.net_expense_cents, v_month_summary.income_cents y
-- commitment_history, respectivamente. Las dos primeras salen de
-- v_transaction_econ: sin traspasos, y un reembolso no es un ingreso sino un
-- gasto más barato.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Gasto neto del mes por cuenta y, anidado, por tarjeta.
--
-- Una fila por (cuenta, tarjeta) con algún movimiento en el mes; card_id NULL
-- es «sin tarjeta» de esa cuenta: apuntes a mano, cargos de suscripción, o un
-- último4 que no es de ninguna tarjeta de la cuenta. Los totales de la cuenta
-- vienen repetidos en cada una de sus filas (account_net_cents), para poder
-- ordenar y pintar la barra de la cuenta sin volver a sumar.
--
-- GASTO NETO, como el resto de la app: un reembolso resta. ¿De qué cuenta y de
-- qué tarjeta? De las del GASTO que reembolsa —donde se hizo el cargo—, no de
-- la cuenta donde se cobró la devolución, que suele ser otra. Es la misma regla
-- con la que v_transaction_econ imputa el reembolso a la categoría del gasto.
-- Y el mes es el del reembolso, como en v_month_summary. Así:
--
--   sum(net_cents) de todas las filas = v_month_summary.net_expense_cents
--
-- (account_spend_history, en cambio, mide el gasto CARGADO en bruto; aquí
-- gross_cents es esa cifra para la cuenta.)
--
-- Una tarjeta se reconoce por el card_last4 que mandó el Atajo, buscado entre
-- las tarjetas de la MISMA cuenta del cargo.
--
--   net_cents         gasto neto de la fila (puede ser negativo si solo cae un
--                     reembolso en el mes)
--   gross_cents       gastos cargados, en bruto
--   reimbursed_cents  reembolsado (positivo)
--   cargos            número de gastos (los reembolsos no cuentan)
--   account_net_cents gasto neto de toda la cuenta en el mes
-- ---------------------------------------------------------------------------
create or replace function public.account_card_spend(p_month date)
returns table (
  account_id        uuid,
  account_name      text,
  account_color     text,
  account_type      public.account_type,
  account_archived  boolean,
  card_id           uuid,
  last4             text,
  nickname          text,
  card_type         public.card_type,
  net_cents         bigint,
  gross_cents       bigint,
  reimbursed_cents  bigint,
  cargos            integer,
  account_net_cents bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select t.user_id,
           e.net_expense_cents as neto,
           case when e.type = 'EXPENSE' then e.amount_cents else 0 end as bruto,
           case when e.is_reimbursement then e.amount_cents else 0 end as reembolso,
           (e.type = 'EXPENSE') as es_cargo,
           -- Un gasto nunca reembolsa nada: r solo existe en los reembolsos, y
           -- ahí mandan la cuenta y la tarjeta del gasto enlazado.
           case when r.id is not null then r.account_id else t.account_id end as cuenta,
           case when r.id is not null then r.card_last4 else t.card_last4 end as ultimos4
    from public.v_transaction_econ e
    join public.transaction t
      on t.user_id = e.user_id and t.id = e.id
    left join public.transaction r
      on r.user_id = t.user_id and r.id = t.reimburses_id
    where e.period_month = date_trunc('month', p_month::timestamp)::date
      and (e.type = 'EXPENSE' or e.is_reimbursement)
  ),
  por_tarjeta as (
    select b.cuenta,
           c.id as tarjeta,
           sum(b.neto)      as neto,
           sum(b.bruto)     as bruto,
           sum(b.reembolso) as reembolso,
           count(*) filter (where b.es_cargo) as cargos
    from base b
    left join public.card c
      on c.user_id = b.user_id
     and c.account_id = b.cuenta
     and c.last4 = b.ultimos4
    group by b.cuenta, c.id
  )
  select a.id,
         a.name,
         a.color,
         a.type,
         a.archived,
         c.id,
         c.last4,
         c.nickname,
         c.type,
         pt.neto::bigint,
         pt.bruto::bigint,
         pt.reembolso::bigint,
         pt.cargos::integer,
         (sum(pt.neto) over (partition by pt.cuenta))::bigint
  from por_tarjeta pt
  join public.account a on a.id = pt.cuenta
  left join public.card c on c.id = pt.tarjeta
  order by sum(pt.neto) over (partition by pt.cuenta) desc,
           a.name, a.id,
           (c.id is null),   -- «sin tarjeta» al final de su cuenta
           pt.neto desc,
           c.last4;
$$;

comment on function public.account_card_spend is
  'Gasto neto de un mes por cuenta y tarjeta (card_id NULL = sin tarjeta). Los reembolsos restan en la cuenta y tarjeta del gasto enlazado. Suma total = v_month_summary.net_expense_cents.';

revoke all on function public.account_card_spend(date) from public, anon;
grant execute on function public.account_card_spend(date) to authenticated;


-- ---------------------------------------------------------------------------
-- Fuentes de ingreso: el ingreso REAL del mes por categoría, y el del mes
-- anterior para compararlo.
--
-- Ingreso real = real_income_cents de v_transaction_econ: un reembolso NO es
-- ingreso (invariante 4) y no aparece aquí; un traspaso tampoco. Así:
--
--   sum(income_cents) = v_month_summary.income_cents del mes
--
-- Sale toda categoría con ingreso en cualquiera de los dos meses, también
-- «Sin categoría» (category_id NULL), ordenadas por el ingreso del mes.
--
--   income_cents   ingreso del mes
--   previo_cents   ingreso del mes anterior
--   recurrente_cents  parte del ingreso del mes que generó un ingreso
--                  recurrente (la nómina programada), para distinguir lo fijo
--   cuantos        número de ingresos del mes
--   share          % del ingreso del mes (numeric, 1 decimal)
--
-- Se comparan meses con subconsultas correlacionadas y no con FULL JOIN sobre
-- una categoría que puede ser NULL: eso no es hash-joinable y revienta con
-- 0A000 (ver category_comparison).
-- ---------------------------------------------------------------------------
create or replace function public.income_breakdown(p_month date)
returns table (
  category_id      uuid,
  name             text,
  color            text,
  icon             text,
  income_cents     bigint,
  previo_cents     bigint,
  recurrente_cents bigint,
  cuantos          integer,
  share            numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select date_trunc('month', p_month::timestamp)::date as mes,
           (date_trunc('month', p_month::timestamp) - interval '1 month')::date as previo
  ),
  ingresos as (
    select e.period_month,
           e.econ_category_id as cid,
           e.real_income_cents as cents,
           (t.recurring_income_id is not null) as recurrente
    from public.v_transaction_econ e
    join public.transaction t
      on t.user_id = e.user_id and t.id = e.id
    cross join meses m
    where e.period_month in (m.mes, m.previo)
      and e.type = 'INCOME'
      and not e.is_reimbursement
  ),
  claves as (
    select distinct i.cid from ingresos i
  ),
  filas as (
    select k.cid,
           coalesce((select sum(i.cents) from ingresos i, meses m
                     where i.period_month = m.mes and i.cid is not distinct from k.cid), 0) as ahora,
           coalesce((select sum(i.cents) from ingresos i, meses m
                     where i.period_month = m.previo and i.cid is not distinct from k.cid), 0) as antes,
           coalesce((select sum(i.cents) from ingresos i, meses m
                     where i.period_month = m.mes and i.recurrente
                       and i.cid is not distinct from k.cid), 0) as fijo,
           (select count(*) from ingresos i, meses m
             where i.period_month = m.mes and i.cid is not distinct from k.cid) as n
    from claves k
  ),
  total as (
    select nullif(sum(f.ahora), 0) as t from filas f
  )
  select f.cid,
         coalesce(c.name, 'Sin categoría'),
         coalesce(c.color, '#9ca3af'),
         coalesce(c.icon, 'circle-help'),
         f.ahora::bigint,
         f.antes::bigint,
         f.fijo::bigint,
         f.n::integer,
         round(100.0 * f.ahora / (select t from total), 1)
  from filas f
  left join public.category c on c.id = f.cid
  order by f.ahora desc, f.antes desc, coalesce(c.name, 'Sin categoría');
$$;

comment on function public.income_breakdown is
  'Ingreso real (sin reembolsos ni traspasos) por categoría del mes y del anterior, con la parte recurrente. Suma de income_cents = v_month_summary.income_cents.';

revoke all on function public.income_breakdown(date) from public, anon;
grant execute on function public.income_breakdown(date) to authenticated;


-- ---------------------------------------------------------------------------
-- Compromiso por suscripción y mes.
--
-- La misma regla que commitment_history: una suscripción cuenta en un mes si ya
-- había empezado al cierre de ese mes; las pausadas dejan de contar en el mes
-- en curso pero sí contaban en los pasados (entonces se pagaban). Por eso:
--
--   sum(monthly_cents) where cuenta  = commitment_history.monthly_cents
--   count(*)           where cuenta  = commitment_history.cuantas
--
--   monthly_cents  importe normalizado a mes (como v_subscription_summary)
--   cuenta         si suma en el compromiso de ese mes
--   alta           si empezó ESE mes: es lo que explica un escalón hacia arriba
--   pausada        si hoy está en pausa. En el mes en curso sale con
--                  cuenta = false: es lo que explica un escalón hacia abajo.
--
-- No hay fecha de pausa en el modelo (subscription no guarda cuándo se pausó),
-- así que una pausada solo se puede ver «salir» en el mes en curso; en los
-- pasados sigue contando, igual que en commitment_history.
-- ---------------------------------------------------------------------------
create or replace function public.commitment_by_subscription(p_months integer default 12)
returns table (
  period_month    date,
  subscription_id uuid,
  description     text,
  periodicity     public.periodicity,
  amount_cents    bigint,
  monthly_cents   bigint,
  cuenta          boolean,
  alta            boolean,
  pausada         boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with meses as (
    select m::date as mes
    from generate_series(
           date_trunc('month', current_date) - make_interval(months => p_months - 1),
           date_trunc('month', current_date),
           interval '1 month'
         ) m
  )
  select s.mes,
         sub.id,
         sub.description,
         sub.periodicity,
         sub.amount_cents,
         round(sub.amount_cents * private.charges_per_year(sub.periodicity) / 12.0)::bigint,
         (sub.active or s.mes < date_trunc('month', current_date)::date),
         (date_trunc('month', sub.started_at::timestamp)::date = s.mes),
         (not sub.active)
  from meses s
  join public.subscription sub
    on sub.started_at <= (s.mes + interval '1 month' - interval '1 day')::date
  order by s.mes, sub.description, sub.id;
$$;

comment on function public.commitment_by_subscription is
  'Suscripciones de cada uno de los últimos p_months meses con su importe mensual, si cuentan en el compromiso (misma regla que commitment_history), si se dieron de alta ese mes y si están en pausa.';

revoke all on function public.commitment_by_subscription(integer) from public, anon;
grant execute on function public.commitment_by_subscription(integer) to authenticated;
