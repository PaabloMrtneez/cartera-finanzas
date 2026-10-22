-- ===========================================================================
-- Endurecimiento: tope de meses en las funciones de historia y permisos mínimos.
--
-- Dos mejoras de la revisión de seguridad tras la auditoría final. Ninguna
-- cambia una cifra; las dos son de mínimo privilegio y de coste acotado.
--
-- 1. TOPE DE MESES. net_worth_monthly, account_balance_monthly,
--    commitment_by_subscription y savings_goal_projection generaban una fila por
--    mes sin límite: una sesión válida podía pedir p_months = 100000 y gastar CPU
--    hasta que statement_timeout la cortara. Se acota a [1, 600]. Seiscientos
--    meses (50 años) y no 120 porque el rango «Todo» de Patrimonio pide tantos
--    meses como historia haya, y con 120 se recortaría en silencio a los diez
--    años de uso. net_worth_history lee de net_worth_monthly y hereda el tope.
--    Los cuerpos son los de 20261005090000 y 20261005090200, cambiando solo el
--    número de meses.
--
-- 2. PERMISOS. Las funciones públicas antiguas nunca retiraron EXECUTE a
--    PUBLIC ni a anon (las nuevas ya lo hacen). No era explotable —son
--    security invoker, la RLS manda y sin aal2 private.current_user_id() es
--    NULL—, pero un visitante sin sesión no tiene nada que hacer con ellas.
--    authenticated y service_role conservan sus GRANT explícitos (comprobado en
--    pg_proc.proacl antes de escribir esto), así que la app no nota nada. Y se
--    cambian los privilegios por defecto para que las funciones FUTURAS nazcan
--    ya sin anon ni PUBLIC.
-- ===========================================================================

-- ── 1. Tope de meses ────────────────────────────────────────────────────────
create or replace function public.net_worth_monthly(p_months integer default 12)
returns table (
  period_month    date,
  net_worth_cents bigint,
  cash_cents      bigint,
  invested_cents  bigint,
  idle_cents      bigint
)
language sql
stable
security invoker
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
           sum(w.balance_cents) filter (where w.type <> 'INVERSION') as caja,
           sum(w.posiciones_cents) as invertido,
           sum(w.balance_cents - w.aportado_cents) filter (where w.type = 'INVERSION') as sin_desplegar
    from private.account_worth_on((select array_agg(c.fin) from cierres c)) w
    group by w.fecha
  )
  select c.mes,
         coalesce(v.total, 0)::bigint,
         coalesce(v.caja, 0)::bigint,
         coalesce(v.invertido, 0)::bigint,
         coalesce(v.sin_desplegar, 0)::bigint
  from cierres c
  left join valores v on v.fecha = c.fin
  order by c.mes;
$$;

create or replace function public.account_balance_monthly(p_months integer default 12)
returns table (
  account_id    uuid,
  name          text,
  color         text,
  type          public.account_type,
  archived      boolean,
  period_month  date,
  balance_cents bigint,
  worth_cents   bigint
)
language sql
stable
security invoker
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
$$;

create or replace function public.savings_goal_projection(p_months integer default 6)
returns table (
  goal_id                 uuid,
  account_id              uuid,
  name                    text,
  target_cents            bigint,
  deadline                date,
  saved_cents             bigint,
  remaining_cents         bigint,
  ritmo_cents             bigint,
  meses_para_meta         integer,
  fecha_estimada          date,
  necesario_mensual_cents bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with marco as (
    select least(greatest(1, p_months), 600) as n,
           (date_trunc('month', current_date) - interval '1 day')::date as fin_ultimo,
           (date_trunc('month', current_date)
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
             then (current_date + make_interval(months => p.meses))::date
         end,
         case
           when p.falta > 0 and p.deadline is not null and p.deadline > current_date
             then round(p.falta::numeric * 30.44 / (p.deadline - current_date))::bigint
         end
  from plazos p
  order by p.name, p.id;
$$;


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
           date_trunc('month', current_date) - make_interval(months => least(greatest(p_months, 1), 600) - 1),
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


-- ── 2. Permisos mínimos ─────────────────────────────────────────────────────
-- Todas las funciones propias del esquema public (no las de extensiones)
-- pierden EXECUTE para PUBLIC y anon. Las que ya no lo tenían no cambian. El
-- esquema private no se toca: sus funciones (current_user_id…) las evalúan las
-- políticas con el rol del usuario y necesitan su GRANT tal cual.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and not exists (
        select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
      )
  loop
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
end
$$;

-- Las funciones futuras del esquema public nacen sin anon. (El EXECUTE de
-- PUBLIC es un privilegio por defecto GLOBAL, que no se puede retirar solo para
-- un esquema; por eso cada migración nueva sigue haciendo su `revoke all ...
-- from public, anon` explícito, como hasta ahora.)
alter default privileges for role postgres in schema public
  revoke execute on functions from anon;
