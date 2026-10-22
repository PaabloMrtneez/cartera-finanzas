-- ===========================================================================
-- claim_budget_alerts debe decir DE QUIÉN es cada aviso.
--
-- La versión anterior devolvía los avisos de todos los usuarios sin
-- identificarlos, y quien la llamaba no tenía forma de saber a quién mandar
-- cada notificación: acabaría enviándole a una persona los límites de otra.
-- ===========================================================================

drop function if exists public.claim_budget_alerts(date);

create or replace function public.claim_budget_alerts(p_month date)
returns table (
  user_id       uuid,
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
    select b.id, b.user_id as uid, b.warn_at_80, c.name,
           s.spent_cents, s.effective_cap_cents,
           case
             when s.spent_cents >= s.effective_cap_cents then 100
             when b.warn_at_80 and s.spent_cents >= s.effective_cap_cents * 0.8 then 80
           end as umbral
    from public.budget b
    join public.category c on c.id = b.category_id
    join lateral (
      select x.spent_cents, x.effective_cap_cents
      from public.budget_status(v_mes) x
      where x.budget_id = b.id
    ) s on true
  ),
  -- Se anotan todos los umbrales alcanzados, para que el 80 % quede registrado
  -- y no vuelva a avisar si el gasto baja y sube otra vez dentro del mismo mes.
  anotados as (
    insert into public.budget_alert (user_id, budget_id, period_month, threshold)
    select e.uid, e.id, v_mes, u.umbral
    from estado e
    cross join (values (80), (100)) as u(umbral)
    where e.umbral is not null
      and u.umbral <= e.umbral
      and (u.umbral <> 80 or e.warn_at_80)
    on conflict (budget_id, period_month, threshold) do nothing
    returning budget_id, threshold
  )
  select e.uid, e.name, a.threshold::smallint, e.spent_cents, e.effective_cap_cents
  from anotados a
  join estado e on e.id = a.budget_id
  -- De los umbrales recién anotados de un mismo límite, solo se avisa del mayor:
  -- si un cargo cruza el 80 y el 100 de golpe, una notificación, no dos.
  where a.threshold = (select max(x.threshold) from anotados x where x.budget_id = a.budget_id);
end $$;

revoke all on function public.claim_budget_alerts(date) from public, anon, authenticated;
grant execute on function public.claim_budget_alerts(date) to service_role;

-- budget_status es SECURITY INVOKER, así que dentro de una función DEFINER se
-- ejecuta con los privilegios del dueño y ve todos los límites. Es lo que aquí
-- se necesita, y por eso esta función solo la puede llamar el rol de servicio.
