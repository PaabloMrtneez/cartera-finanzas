-- ===========================================================================
-- El segundo factor pasa a ser OPCIONAL.
--
-- Regla nueva (decisión del dueño):
--
--   · Quien NO tiene ningún factor verificado entra con la contraseña (aal1)
--     y ve y escribe SUS datos.
--   · Quien SÍ tiene un factor verificado sigue obligado a superarlo (aal2),
--     exactamente igual que hasta ahora: con su contraseña sola, cero filas.
--
-- El aislamiento entre usuarios NO cambia: sigue siendo `user_id =
-- private.current_user_id()`, y current_user_id() sigue devolviendo como mucho
-- el auth.uid() de la sesión. Lo único que cambia es CUÁNDO lo devuelve.
--
-- POR QUÉ SE TOCA UNA SOLA FUNCIÓN
--
-- Se hizo inventario en producción (pg_policies y pg_proc, solo lectura) antes
-- de escribir esto. El único sitio de todo el esquema que mira el nivel de la
-- sesión es private.current_user_id() (20260815090100_rls.sql):
--
--   · Las 66 políticas de public pasan TODAS por (select private.current_user_id()),
--     en las 22 tablas: account, budget, budget_alert, budget_forecast_alert,
--     card, category, fx_rate, ingest_dead_letter, ingest_device, instrument,
--     instrument_price, investment_position, loan, merchant_rule,
--     position_unit_event, profile, push_subscription, recurring_income,
--     savings_goal, subscription, transaction, valuation.
--   · Ninguna política ni función mira `aal` ni `amr` por su cuenta, ni usa
--     auth.uid() directamente.
--   · 23 funciones de public llaman a current_user_id() (las de borrar, los
--     préstamos, importar, generar cargos, las reglas, create_/revoke_
--     ingest_device…). Ninguna mira el nivel por su cuenta.
--   · Las vistas son security_invoker y se apoyan en la RLS de sus tablas.
--
-- Así que basta con cambiar la regla DENTRO de current_user_id(): las 66
-- políticas y las 23 funciones heredan la regla nueva sin reescribirse, y las
-- políticas conservan su forma (select …), que el planificador evalúa una vez
-- por consulta (InitPlan) y no una vez por fila.
--
-- POR QUÉ HACE FALTA UNA FUNCIÓN `security definer`
--
-- Saber si alguien tiene un factor verificado exige leer auth.mfa_factors, que
-- el rol `authenticated` no puede leer (ni debe: lleva los secretos TOTP). La
-- función nueva lo lee con los permisos de su propietario, pero SOLO para la
-- sesión que pregunta (auth.uid()), sin parámetros, y devuelve un booleano: no
-- deja consultar los factores de nadie más ni ver nada de ellos.
--
-- Solo hacia delante: deshacerlo sería otra migración que vuelva a la regla
-- `aal = 'aal2'` a secas.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- ¿Ha cumplido esta sesión con su segundo factor?
--
--   · aal2 → sí, sin más.
--   · aal1 → sí SOLO si el usuario no tiene ningún factor verificado. Un factor
--     a medio dar de alta (unverified) no cuenta: aún no protege nada.
--   · Sin sesión (auth.uid() nulo) → el `not exists` sería cierto, pero da
--     igual: current_user_id() devuelve auth.uid(), que es nulo, y ninguna
--     política deja pasar nada. Aun así se exige uid no nulo, por claridad.
-- ---------------------------------------------------------------------------
create or replace function private.segundo_factor_cumplido()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and (
           coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
           or not exists (
                select 1
                  from auth.mfa_factors f
                 where f.user_id = (select auth.uid())
                   and f.status = 'verified'
              )
         );
$$;

comment on function private.segundo_factor_cumplido() is
  'true si la sesión es aal2, o si es aal1 y su usuario no tiene ningún factor verificado. Solo mira la sesión que pregunta.';

revoke execute on function private.segundo_factor_cumplido() from public;
revoke execute on function private.segundo_factor_cumplido() from anon;
grant execute on function private.segundo_factor_cumplido() to authenticated;


-- ---------------------------------------------------------------------------
-- current_user_id(): misma firma, mismo `security invoker`, misma forma. Solo
-- cambia la condición: de «aal2» a «segundo factor cumplido».
-- ---------------------------------------------------------------------------
create or replace function private.current_user_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select case
           when (select private.segundo_factor_cumplido()) then (select auth.uid())
           else null::uuid
         end;
$$;

grant execute on function private.current_user_id() to authenticated;
