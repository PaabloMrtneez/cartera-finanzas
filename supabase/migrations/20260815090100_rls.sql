-- ===========================================================================
-- Cartera — seguridad a nivel de fila
--
-- El aislamiento entre los cuatro usuarios descansa en dos piezas:
--
--   · Las claves foráneas compuestas del esquema, que impiden REFERENCIAR
--     filas ajenas (ver 20260815090000_schema.sql).
--   · Las políticas de este fichero, que impiden LEER y ESCRIBIR filas ajenas.
--
-- Hacen falta las dos. Ninguna sustituye a la otra.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- El 2FA se impone aquí, en el dato, no en un `if` de React.
--
-- Si la sesión no ha superado el segundo factor (aal2), esta función devuelve
-- NULL. Como user_id es NOT NULL en todas las tablas, `user_id = NULL` evalúa a
-- NULL y ninguna política deja pasar nada: cero filas visibles, cero escrituras.
--
-- Esto no bloquea el alta del propio 2FA: enrolar un TOTP se hace contra los
-- endpoints de autenticación, que no pasan por la base de datos.
--
-- El (select ...) de dentro no es cosmético: convierte la llamada en un
-- InitPlan que se evalúa una vez por consulta y no una vez por fila.
-- ---------------------------------------------------------------------------
create or replace function private.current_user_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select case
           when (select auth.jwt() ->> 'aal') = 'aal2' then (select auth.uid())
           else null::uuid
         end;
$$;

grant execute on function private.current_user_id() to authenticated;


-- ---------------------------------------------------------------------------
-- Las cuatro políticas de cada tabla, generadas en bloque para que no se quede
-- ninguna suelta por descuido.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profile', 'account', 'category', 'investment_position', 'subscription',
    'transaction', 'merchant_rule', 'budget', 'budget_alert', 'valuation',
    'ingest_device', 'ingest_dead_letter'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    -- FORCE hace que la RLS aplique también al propietario de la tabla.
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon', t);

    execute format($p$
      create policy %1$s_sel on public.%1$I for select to authenticated
        using (user_id = (select private.current_user_id()))$p$, t);
    execute format($p$
      create policy %1$s_ins on public.%1$I for insert to authenticated
        with check (user_id = (select private.current_user_id()))$p$, t);
    execute format($p$
      create policy %1$s_upd on public.%1$I for update to authenticated
        using (user_id = (select private.current_user_id()))
        with check (user_id = (select private.current_user_id()))$p$, t);
    execute format($p$
      create policy %1$s_del on public.%1$I for delete to authenticated
        using (user_id = (select private.current_user_id()))$p$, t);
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- Excepciones deliberadas
-- ---------------------------------------------------------------------------

-- Las cuentas y las posiciones se archivan, no se borran: quitando la política
-- de borrado, nadie puede borrarlas aunque el código de la app se equivoque.
drop policy account_del on public.account;
drop policy investment_position_del on public.investment_position;

-- El perfil lo crea un disparador al darse de alta el usuario, y no se borra.
drop policy profile_ins on public.profile;
drop policy profile_del on public.profile;

-- El dispositivo de ingesta no se edita: se crea y se revoca, y ambas cosas
-- pasan por funciones dedicadas que controlan el token.
drop policy ingest_device_ins on public.ingest_device;
drop policy ingest_device_upd on public.ingest_device;

-- Los avisos de límite y los descartes de la ingesta son de solo lectura para
-- el usuario: los escribe el motor, no la interfaz.
drop policy budget_alert_ins on public.budget_alert;
drop policy budget_alert_upd on public.budget_alert;
drop policy ingest_dead_letter_ins on public.ingest_dead_letter;
drop policy ingest_dead_letter_upd on public.ingest_dead_letter;

-- La cubeta del limitador no la toca nadie desde el cliente.
alter table public.ingest_bucket enable row level security;
alter table public.ingest_bucket force row level security;
revoke all on table public.ingest_bucket from anon, authenticated;


-- ---------------------------------------------------------------------------
-- Privilegios a nivel de columna
-- ---------------------------------------------------------------------------

-- Reasignar una fila a otro usuario no es nunca una operación legítima. El
-- WITH CHECK ya lo detendría, pero es mejor no depender de un solo cerrojo.
revoke update (user_id) on
  public.account, public.category, public.transaction, public.merchant_rule,
  public.subscription, public.budget, public.investment_position, public.valuation
  from authenticated;

-- El tipo de una categoría es inmutable (también hay disparador, por el mensaje).
revoke update (type) on public.category from authenticated;

-- Aunque la política deje leer la fila del dispositivo, el hash del token no
-- sale de la base de datos jamás.
revoke select (token_hash) on public.ingest_device from authenticated;


-- ---------------------------------------------------------------------------
-- Perfil automático al crear el usuario.
--
-- Es lo ÚNICO que se siembra. Ni categorías ni cuentas por defecto: la app
-- arranca vacía a propósito, y «Sin categoría» no es una fila sino la ausencia
-- de una (category_id NULL).
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profile (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (user_id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
