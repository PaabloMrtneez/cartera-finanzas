-- ===========================================================================
-- Suscripciones de notificaciones push.
--
-- Un dispositivo por fila. El punto de entrega («endpoint») que da el navegador
-- es la clave: si el usuario reinstala la app o revoca el permiso, llega otro
-- distinto y el anterior deja de existir.
-- ===========================================================================

create table public.push_subscription (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_sent_at timestamptz,
  -- Cuando el navegador contesta que el punto de entrega ya no vale, se marca
  -- en lugar de borrarlo de golpe: así se ve si alguien dejó de recibir avisos.
  failed_at   timestamptz,

  constraint push_endpoint_len check (length(endpoint) between 10 and 1000)
);

create index push_subscription_user_idx
  on public.push_subscription (user_id) where failed_at is null;

alter table public.push_subscription enable row level security;
alter table public.push_subscription force row level security;
revoke all on table public.push_subscription from anon;

create policy push_subscription_sel on public.push_subscription for select to authenticated
  using (user_id = (select private.current_user_id()));
create policy push_subscription_ins on public.push_subscription for insert to authenticated
  with check (user_id = (select private.current_user_id()));
create policy push_subscription_del on public.push_subscription for delete to authenticated
  using (user_id = (select private.current_user_id()));

revoke update (user_id) on public.push_subscription from authenticated;


-- ---------------------------------------------------------------------------
-- Qué avisos de límite toca mandar, sin repetir.
--
-- La clave primaria de budget_alert (límite, mes, umbral) ES el mecanismo
-- anti-repetición: el INSERT ... ON CONFLICT DO NOTHING solo devuelve fila la
-- primera vez. El 80 % y el 100 % son avisos independientes.
--
-- Si un cargo cruza los dos umbrales de golpe, se anota el bajo pero solo se
-- devuelve el alto: nadie quiere dos notificaciones seguidas por el mismo pago.
-- ---------------------------------------------------------------------------
create or replace function public.claim_budget_alerts(p_month date)
returns table (
  category_name text,
  threshold     smallint,
  spent_cents   bigint,
  cap_cents     bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mes date := date_trunc('month', p_month::timestamp)::date;
begin
  return query
  with estado as (
    select b.id, b.user_id, b.warn_at_80, c.name,
           s.spent_cents, s.effective_cap_cents,
           case
             when s.spent_cents >= s.effective_cap_cents then 100
             when b.warn_at_80 and s.spent_cents >= s.effective_cap_cents * 0.8 then 80
           end as umbral
    from public.budget b
    join public.category c on c.id = b.category_id
    join lateral (
      select spent_cents, effective_cap_cents
      from public.budget_status(v_mes) x
      where x.budget_id = b.id
    ) s on true
  ),
  -- Se anotan TODOS los umbrales alcanzados, no solo el más alto: así el 80 %
  -- queda registrado y no volverá a avisar cuando el gasto baje y vuelva a subir.
  anotados as (
    insert into public.budget_alert (user_id, budget_id, period_month, threshold)
    select e.user_id, e.id, v_mes, u.umbral
    from estado e
    cross join (values (80), (100)) as u(umbral)
    where e.umbral is not null
      and u.umbral <= e.umbral
      and (u.umbral <> 80 or e.warn_at_80)
    on conflict (budget_id, period_month, threshold) do nothing
    returning budget_id, threshold
  )
  select e.name, a.threshold::smallint, e.spent_cents, e.effective_cap_cents
  from anotados a
  join estado e on e.id = a.budget_id
  -- De los umbrales recién anotados de un mismo límite, solo se avisa del mayor.
  where a.threshold = (select max(x.threshold) from anotados x where x.budget_id = a.budget_id);
end $$;

revoke all on function public.claim_budget_alerts(date) from public, anon, authenticated;
grant execute on function public.claim_budget_alerts(date) to service_role;
