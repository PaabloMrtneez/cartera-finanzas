-- ===========================================================================
-- Aviso PREDICTIVO de límite: avisar ANTES de pasarse, no después.
--
-- El aviso de límite que ya existe (claim_budget_alerts + budget_alert) es
-- REACTIVO: salta cuando lo YA gastado cruza el 80 % o el 100 % del tope. Llega
-- tarde por definición —cuando ya no hay margen de maniobra—.
--
-- Este mira adelante y usa la MISMA previsión que ve el usuario en Análisis
-- (category_forecast): «a este ritmo cerrarás la categoría en X, y el tope es Y».
-- No recalcula nada; se limita a decidir A QUIÉN y CUÁNDO avisar, con cuatro
-- cautelas para que el aviso sea útil y no ruido:
--
--   1. Solo categorías cuya PREVISIÓN rebasa el tope (category_forecast.rebasa).
--   2. Solo las que AÚN no se han pasado de verdad (gastado < tope): si ya cruzó
--      el 100 %, el reactivo ya avisa y el predictivo sobra.
--   3. Solo límites con warn_at_80 = true: reutilizamos la intención del usuario
--      de querer avisos de ese límite, sin inventar UI nueva.
--   4. Un margen del 5 % (previsión >= tope * 1,05): un rebase de calderilla en la
--      extrapolación no merece interrumpir.
--
-- Y un guardo temporal: extrapolar el día 2 es adivinar. Solo se avisa si ha
-- transcurrido un mínimo de mes (>= 7 días Y al menos un tercio del mes).
--
-- La no-repetición es idéntica a budget_alert: una tabla espejo cuya clave ES el
-- mecanismo. Un INSERT ... ON CONFLICT DO NOTHING que devuelve fila significa
-- «avisa»; que no devuelva nada, «ya avisaste este mes».
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- La marca anti-repetición. Espejo de budget_alert, pero sin `threshold`: el
-- aviso predictivo es UNO por límite y mes, no uno por umbral.
--
-- FK compuesta con user_id (invariante 5): la RLS no protege las claves foráneas.
-- La PK incluye user_id, y como budget_id es único por sí solo, la fila queda
-- igualmente identificada por (budget_id, period_month) — pero llevar user_id en
-- la clave deja explícito de quién es cada marca.
-- ---------------------------------------------------------------------------
create table public.budget_forecast_alert (
  user_id      uuid not null references auth.users(id) on delete cascade,
  budget_id    uuid not null,
  period_month date not null,
  notified_at  timestamptz not null default now(),

  primary key (user_id, budget_id, period_month),
  constraint fc_alert_month_first check (extract(day from period_month) = 1),

  foreign key (user_id, budget_id) references public.budget (user_id, id) on delete cascade
);

comment on table public.budget_forecast_alert is
  'Anti-repetición del aviso PREDICTIVO de límite: una fila por (usuario, límite, mes). Espejo de budget_alert sin threshold; la escribe claim_budget_forecast_alerts, el usuario solo la lee.';


-- ---------------------------------------------------------------------------
-- Seguridad a nivel de fila. Igual que budget_alert: de solo lectura para el
-- usuario —la escribe el motor, no la interfaz—, así que se crean las políticas
-- de lectura y borrado y se dejan fuera las de inserción y actualización.
-- Supabase concede los privilegios por defecto a authenticated/service_role al
-- crear la tabla; aquí solo hay que revocar anon y forzar la RLS.
-- ---------------------------------------------------------------------------
alter table public.budget_forecast_alert enable row level security;
-- FORCE hace que la RLS aplique también al propietario de la tabla.
alter table public.budget_forecast_alert force row level security;
revoke all on table public.budget_forecast_alert from anon;

create policy budget_forecast_alert_sel on public.budget_forecast_alert
  for select to authenticated
  using (user_id = (select private.current_user_id()));
create policy budget_forecast_alert_del on public.budget_forecast_alert
  for delete to authenticated
  using (user_id = (select private.current_user_id()));


-- ---------------------------------------------------------------------------
-- Reclamar los avisos predictivos, sin repetir. Mismo patrón que
-- claim_budget_alerts y claim_ingest_health_alerts: marca ANTES de devolver, de
-- modo que un envío que falle pierda un aviso (recuperable el mes siguiente) en
-- vez de mandarlo en bucle. La ruta la llama solo con p_month, igual que a la
-- reactiva; los umbrales del guardo temporal son parámetros con el valor por
-- defecto de la especificación, para que la prueba pueda forzar el «demasiado
-- pronto» sin depender del día en que se ejecute.
--
--   · p_min_dias  — mínimo de días transcurridos del mes.
--   · p_frac_num / p_frac_den — fracción mínima del mes transcurrida
--     (por defecto 1/3): dias_transcurridos * den >= dias_totales * num.
--
-- SECURITY DEFINER + search_path vacío: solo la ejecuta service_role. Dentro,
-- category_forecast y month_forecast (security_invoker) corren con los privilegios
-- del dueño y ven a los cuatro usuarios; los días del mes no dependen del usuario,
-- así que una sola lectura de month_forecast sirve de guardo para todos.
-- ---------------------------------------------------------------------------
create or replace function public.claim_budget_forecast_alerts(
  p_month    date,
  p_min_dias integer default 7,
  p_frac_num integer default 1,
  p_frac_den integer default 3
)
returns table (
  user_id         uuid,
  category_name   text,
  prevision_cents bigint,
  cap_cents       bigint
)
language plpgsql
security definer
set search_path = ''
as $$
-- La tabla de retorno declara una columna `user_id`, que dentro de plpgsql es una
-- variable OUT y chocaría con la columna `user_id` en el INSERT y en el ON CONFLICT
-- (el aviso reactivo no lo sufre porque su clave no incluye user_id). Ante la duda,
-- gana la columna: las referencias a variables van cualificadas o son `v_*`.
#variable_conflict use_column
declare
  v_mes  date := date_trunc('month', p_month::timestamp)::date;
  v_dt   integer;
  v_dtot integer;
begin
  -- Guardo temporal: los días del mes son iguales para todos, una lectura basta.
  select mf.dias_transcurridos, mf.dias_totales
    into v_dt, v_dtot
    from public.month_forecast(v_mes) mf;

  -- Demasiado pronto para extrapolar: calla. No se marca nada, así que cuando el
  -- mes avance el aviso podrá salir.
  if v_dt < p_min_dias or v_dt * p_frac_den < v_dtot * p_frac_num then
    return;
  end if;

  return query
  with candidatos as (
    -- La previsión por categoría, tal cual la ve el usuario. category_forecast
    -- devuelve una fila por límite de CUALQUIER usuario cuando la llama el motor.
    select cf.category_id, cf.name as cat_name, cf.prevision_cents, cf.cap_cents
    from public.category_forecast(v_mes) cf
    where cf.rebasa                                    -- (1) la previsión se pasa
      and cf.gastado_cents < cf.cap_cents              -- (2) aún no se pasó de verdad
      and cf.prevision_cents * 100 >= cf.cap_cents * 105  -- (4) margen del 5 %
  ),
  -- El id de categoría es único, así que resuelve sin ambigüedad su límite y su
  -- dueño. Aquí se aplica (3): solo los límites que quieren aviso.
  con_limite as (
    select b.user_id as uid, b.id as budget_id,
           c.cat_name, c.prevision_cents, c.cap_cents
    from candidatos c
    join public.budget b on b.category_id = c.category_id
    where b.warn_at_80
  ),
  -- Marcar y reclamar en un paso: solo las recién insertadas son las que toca
  -- notificar ahora. Una segunda ejecución el mismo mes no devuelve nada.
  anotados as (
    insert into public.budget_forecast_alert (user_id, budget_id, period_month)
    select cl.uid, cl.budget_id, v_mes
    from con_limite cl
    on conflict (user_id, budget_id, period_month) do nothing
    returning budget_id
  )
  select cl.uid, cl.cat_name, cl.prevision_cents, cl.cap_cents
  from anotados a
  join con_limite cl on cl.budget_id = a.budget_id;
end $$;

revoke all on function public.claim_budget_forecast_alerts(date, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_budget_forecast_alerts(date, integer, integer, integer)
  to service_role;

comment on function public.claim_budget_forecast_alerts is
  'Los avisos PREDICTIVOS de límite que toca mandar ahora: categorías cuya previsión rebasa el tope (con margen del 5 %) pero que aún no se han pasado de verdad, en límites con warn_at_80, y solo con suficiente mes transcurrido. Marca antes de devolver: uno por límite y mes.';
