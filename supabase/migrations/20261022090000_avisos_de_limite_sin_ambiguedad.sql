-- ===========================================================================
-- Los avisos de límite (80 % y 100 %) por fin salen.
--
-- Prueba: scripts/test-aviso-limite.mjs.
--
-- ── EL PROBLEMA ────────────────────────────────────────────────────────────
-- public.claim_budget_alerts devuelve una tabla con columnas user_id y
-- threshold, y dentro inserta y lee las columnas user_id y threshold de
-- public.budget_alert. En PL/pgSQL las columnas de salida son variables, así
-- que «threshold» era ambiguo (42702) y la función abortaba ENTERA en cada
-- pasada de /api/notificar («error_avisos: [claim_budget_alerts]»). Ningún
-- aviso de límite ha llegado a salir nunca.
--
-- ── EL ARREGLO ─────────────────────────────────────────────────────────────
-- `#variable_conflict use_column`: ante un nombre que coincide, manda la
-- columna de la tabla. Es lo que la consulta quería decir en todos los casos
-- (las columnas de salida no se leen dentro: solo se rellenan con RETURN
-- QUERY). El resto es la definición vigente (20260817090500), sin cambios:
-- security definer, search_path = '' y solo para service_role.
-- ===========================================================================

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
#variable_conflict use_column
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
