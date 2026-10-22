-- ===========================================================================
-- Eliminar una cuenta, con todo lo suyo y con aviso.
--
-- Hasta ahora una cuenta solo se archivaba: el esquema base quitó a propósito
-- la política de borrado de `account` y de `investment_position` («nadie puede
-- borrarlas aunque el código de la app se equivoque»), y las claves foráneas de
-- movimientos, posiciones, suscripciones e ingresos recurrentes son
-- `on delete restrict`. Archivar sigue siendo lo recomendable —conserva la
-- historia—, pero quien abrió una cuenta por error o de prueba tiene que poder
-- quitarla de verdad.
--
-- Decisión del usuario: se borra la cuenta CON TODO LO SUYO, tras una
-- confirmación que enseña cuánto se va a borrar y obliga a escribir el nombre.
-- Dos funciones:
--
--   account_delete_preview(id)          → recuentos de lo que se borraría.
--   delete_account(id, nombre_escrito)  → lo borra todo en una transacción.
--
-- ── Por qué no se tocan las claves foráneas ────────────────────────────────
-- Pasar las FK a `cascade` convertiría cualquier DELETE sobre `account` en un
-- borrado masivo silencioso. Se dejan en `restrict`: el único camino que borra
-- es `delete_account`, que borra explícitamente y en orden cada dependiente.
-- Las que ya eran `cascade` (tarjeta, meta, valoración) o `set null` (cuenta
-- por defecto del Atajo, enlaces de reembolso, suscripción y posición de un
-- movimiento) se quedan como están.
--
-- ── Por qué `security invoker` y no `definer` ──────────────────────────────
-- Las dos funciones corren con los permisos de quien llama, así que la RLS de
-- cada tabla se aplica a cada SELECT y a cada DELETE: no hay forma de que
-- toquen una fila de otro usuario aunque el filtro explícito por user_id
-- (que también llevan) fallara. Para que el DELETE sobre `account` y sobre
-- `investment_position` sea posible sin abrir el borrado directo desde el
-- cliente, sus nuevas políticas de borrado exigen además que la variable de
-- transacción `cartera.cuenta_a_borrar` contenga el id de esa cuenta. Esa
-- variable solo la fija `delete_account`, con `set_config(..., true)` (local a
-- la transacción) y DESPUÉS de comprobar el nombre; el cliente no tiene forma
-- de fijarla (PostgREST no expone `set_config` ni deja nombrar variables de
-- configuración arbitrarias). Un `DELETE` directo sobre `account` sigue
-- afectando a cero filas, como hasta ahora.
--
-- ── Decisiones de modelo ───────────────────────────────────────────────────
--   · TRASPASOS. Un traspaso es UNA fila (account_id → to_account_id). Si toca
--     esta cuenta por cualquiera de los dos lados, se borra entera, y con ella
--     desaparece su efecto en la OTRA cuenta: si el dinero entró en la otra,
--     su saldo baja; si salió de la otra hacia esta, sube. El preview lo da
--     por cuenta y en céntimos, para avisarlo aparte. Un traspaso no tiene
--     signo (invariante 3): el gasto, el ingreso y el balance de los meses no
--     cambian por él, solo los saldos.
--   · REEMBOLSOS CRUZADOS (invariante 4).
--       - Un ingreso de OTRA cuenta que reembolsaba un gasto de ESTA: el ingreso
--         sobrevive (el dinero entró de verdad en la otra cuenta y su saldo no
--         debe cambiar), y la FK `on delete set null` le quita el enlace al
--         borrarse el gasto. Sin gasto que abaratar, deja de ser un reembolso y
--         pasa a contar como ingreso normal, en su propia categoría (o «Sin
--         categoría»). Es lo único coherente: borrarlo cambiaría el saldo de
--         una cuenta que el usuario no ha pedido tocar, y mantenerlo como
--         reembolso de un gasto inexistente no tiene significado.
--       - Un ingreso de ESTA cuenta que reembolsaba un gasto de OTRA: el
--         ingreso se borra con la cuenta y el gasto de la otra pierde su
--         rebaja; su gasto neto sube lo que valía el reembolso.
--     Ambos casos se cuentan en el preview para avisarlos.
--   · REGLAS DE CLASIFICACIÓN. `merchant_rule` apunta a una categoría, nunca a
--     una cuenta: no hay nada que borrar ni desenganchar.
--   · ATAJO. La cuenta por defecto de la ingesta (`profile.default_ingest_
--     account_id`) ya es `on delete set null`: se queda sin cuenta por defecto
--     y la ingesta rechazará (a la cola de descartes, sin perder nada) los
--     cargos cuya tarjeta no case. Las tarjetas de la cuenta caen con ella, así
--     que sus cargos tampoco casarán. El preview avisa si era la de por defecto.
--     Los dispositivos no apuntan a ninguna cuenta; `ingest_dead_letter`
--     tampoco (guarda el payload crudo): no se tocan.
--   · LÍMITES Y AVISOS. `budget`, `budget_alert` y `budget_forecast_alert`
--     cuelgan de categorías, no de cuentas. Al desaparecer los gastos, el
--     consumo de los límites se recalcula solo (todo se deriva); los avisos
--     ya enviados quedan como registro de lo que se avisó.
--   · SUSCRIPCIONES E INGRESOS RECURRENTES de la cuenta se borran. Si alguno
--     generó movimientos en otra cuenta (porque se le cambió la cuenta después),
--     esos movimientos sobreviven sin enlace (`set null`).
--   · POSICIONES de la cuenta se borran, y sus valoraciones con ellas
--     (`cascade`). Las aportaciones eran traspasos hacia esta cuenta: ya
--     cuentan como traspasos con otras cuentas.
--
-- Nada se almacena (invariante 2): borrar filas basta para que saldos,
-- patrimonio, metas y límites se recalculen. Todo importe es entero en
-- céntimos (bigint).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Políticas de borrado, cerradas salvo dentro de delete_account.
--
-- `(select current_setting(...))` se evalúa una vez por sentencia (initplan),
-- igual que `private.current_user_id()` en el resto de políticas. El segundo
-- argumento `true` hace que una variable nunca fijada devuelva NULL en vez de
-- un error, y `id::text = NULL` no deja pasar ninguna fila.
-- ---------------------------------------------------------------------------
create policy account_del on public.account for delete to authenticated
  using (
    user_id = (select private.current_user_id())
    and id::text = (select current_setting('cartera.cuenta_a_borrar', true))
  );

create policy investment_position_del on public.investment_position for delete to authenticated
  using (
    user_id = (select private.current_user_id())
    and account_id::text = (select current_setting('cartera.cuenta_a_borrar', true))
  );


-- ---------------------------------------------------------------------------
-- account_delete_preview — qué se borraría, sin borrar nada.
--
-- Devuelve un objeto con:
--   account_id, name, type, archived
--   balance_cents        saldo contable de la cuenta (v_account_balance)
--   worth_cents          lo que aporta al patrimonio (v_account_worth: en una
--                        cuenta de inversión, caja + valor de sus posiciones)
--   transactions         { total, expenses, incomes, transfers } — TODAS las
--                        filas que se borrarían, también las descartadas, y los
--                        traspasos por cualquiera de los dos lados
--   external_transfers   [{ account_id, name, archived, transfers,
--                           balance_delta_cents }] — por cada OTRA cuenta con la
--                        que hay traspasos, cuánto cambia su saldo al borrarlos
--                        (negativo = baja). Los descartados no movían saldo.
--   cards, positions, valuations, subscriptions, recurring_incomes, goals
--   cross_reimbursements {
--     incomes_elsewhere:  { count, cents } — ingresos de otras cuentas que
--                         reembolsaban gastos de esta: pasan a ingreso normal
--     expenses_elsewhere: { count, cents } — gastos de otras cuentas
--                         reembolsados por ingresos de esta: su gasto neto sube
--   }
--   shortcut_default     esta es la cuenta por defecto del Atajo
--   active_devices       dispositivos del Atajo activos (solo si lo anterior)
--
-- Una cuenta ajena o inexistente da el mismo error («no encontrada»): no se
-- distingue para no confirmar que un id existe. Sin aal2 no hay usuario.
-- ---------------------------------------------------------------------------
create or replace function public.account_delete_preview(p_account_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid    uuid := (select private.current_user_id());
  v_cuenta public.account%rowtype;
begin
  if v_uid is null then
    raise exception 'Sesión sin verificar' using errcode = '42501';
  end if;

  select * into v_cuenta
  from public.account a
  where a.id = p_account_id and a.user_id = v_uid;

  if not found then
    raise exception 'Cuenta no encontrada' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'account_id', v_cuenta.id,
    'name',       v_cuenta.name,
    'type',       v_cuenta.type,
    'archived',   v_cuenta.archived,

    'balance_cents', (
      select b.balance_cents::bigint
      from public.v_account_balance b
      where b.user_id = v_uid and b.account_id = p_account_id),
    'worth_cents', (
      select w.worth_cents::bigint
      from public.v_account_worth w
      where w.user_id = v_uid and w.account_id = p_account_id),

    'transactions', (
      select jsonb_build_object(
               'total',     count(*),
               'expenses',  count(*) filter (where t.type = 'EXPENSE'),
               'incomes',   count(*) filter (where t.type = 'INCOME'),
               'transfers', count(*) filter (where t.type = 'TRANSFER'))
      from public.transaction t
      where t.user_id = v_uid
        and (t.account_id = p_account_id or t.to_account_id = p_account_id)),

    'external_transfers', (
      select coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'account_id',          x.otra,
                   'name',                a.name,
                   'archived',            a.archived,
                   'transfers',           x.n,
                   'balance_delta_cents', x.delta)
                 order by abs(x.delta) desc, a.name),
               '[]'::jsonb)
      from (
        select case when t.account_id = p_account_id then t.to_account_id else t.account_id end as otra,
               count(*) as n,
               coalesce(sum(
                 case
                   when t.status = 'DISCARDED'        then 0
                   -- Salió de esta y entró en la otra: al borrarlo, la otra baja.
                   when t.account_id = p_account_id   then -t.amount_cents
                   -- Salió de la otra hacia esta: al borrarlo, la otra sube.
                   else t.amount_cents
                 end), 0)::bigint as delta
        from public.transaction t
        where t.user_id = v_uid
          and t.type = 'TRANSFER'
          and (t.account_id = p_account_id or t.to_account_id = p_account_id)
        group by 1
      ) x
      join public.account a on a.user_id = v_uid and a.id = x.otra),

    'cards', (
      select count(*) from public.card c
      where c.user_id = v_uid and c.account_id = p_account_id),
    'positions', (
      select count(*) from public.investment_position p
      where p.user_id = v_uid and p.account_id = p_account_id),
    'valuations', (
      select count(*)
      from public.valuation v
      join public.investment_position p on p.user_id = v.user_id and p.id = v.position_id
      where v.user_id = v_uid and p.account_id = p_account_id),
    'subscriptions', (
      select count(*) from public.subscription s
      where s.user_id = v_uid and s.account_id = p_account_id),
    'recurring_incomes', (
      select count(*) from public.recurring_income r
      where r.user_id = v_uid and r.account_id = p_account_id),
    'goals', (
      select count(*) from public.savings_goal g
      where g.user_id = v_uid and g.account_id = p_account_id),

    'cross_reimbursements', jsonb_build_object(
      'incomes_elsewhere', (
        select jsonb_build_object('count', count(*), 'cents', coalesce(sum(i.amount_cents), 0)::bigint)
        from public.transaction i
        join public.transaction g on g.user_id = i.user_id and g.id = i.reimburses_id
        where i.user_id = v_uid
          and g.account_id = p_account_id
          and i.account_id <> p_account_id
          and i.status <> 'DISCARDED'),
      'expenses_elsewhere', (
        select jsonb_build_object('count', count(*), 'cents', coalesce(sum(i.amount_cents), 0)::bigint)
        from public.transaction i
        join public.transaction g on g.user_id = i.user_id and g.id = i.reimburses_id
        where i.user_id = v_uid
          and i.account_id = p_account_id
          and g.account_id <> p_account_id
          and i.status <> 'DISCARDED')),

    'shortcut_default', coalesce((
      select pr.default_ingest_account_id = p_account_id
      from public.profile pr
      where pr.user_id = v_uid), false),
    'active_devices', (
      select count(*)
      from public.ingest_device d
      join public.profile pr on pr.user_id = d.user_id
      where d.user_id = v_uid
        and d.revoked_at is null
        and pr.default_ingest_account_id = p_account_id)
  );
end $$;

comment on function public.account_delete_preview(uuid) is
  'Recuentos de lo que borraria delete_account: movimientos, traspasos con otras cuentas (y el cambio de saldo de cada una, en centimos), tarjetas, posiciones, valoraciones, suscripciones, ingresos recurrentes, metas, reembolsos cruzados y cuenta por defecto del Atajo. No borra nada.';

revoke all on function public.account_delete_preview(uuid) from public, anon;
grant execute on function public.account_delete_preview(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- delete_account — borra la cuenta y todo lo suyo, en una sola transacción.
--
-- `p_confirm_name` tiene que coincidir EXACTAMENTE con el nombre de la cuenta,
-- tras quitar espacios de los extremos (btrim) en los dos lados. Mayúsculas y
-- tildes cuentan: es una confirmación, no una búsqueda.
--
-- Orden:
--   1. Movimientos de la cuenta y traspasos por cualquiera de sus lados. Los
--      enlaces de reembolso que apuntaban a sus gastos desde otras cuentas se
--      ponen a NULL solos (FK `set null`).
--   2. Suscripciones e ingresos recurrentes (ya sin movimientos propios que los
--      referencien; los de otras cuentas, si hay, se desenganchan solos).
--   3. Posiciones (sus valoraciones caen en cascada; las aportaciones eran
--      traspasos y ya se borraron en el paso 1).
--   4. Metas y tarjetas (serían cascada, pero se borran explícitamente para
--      contarlas).
--   5. La cuenta. La cuenta por defecto del Atajo se pone a NULL sola.
--
-- Si el último DELETE no borra la cuenta (no debería pasar: ya se comprobó que
-- es suya), se lanza un error y la transacción entera se deshace: nunca se
-- quedan los dependientes borrados con la cuenta viva.
--
-- Devuelve los recuentos de lo borrado.
-- ---------------------------------------------------------------------------
create or replace function public.delete_account(p_account_id uuid, p_confirm_name text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid           uuid := (select private.current_user_id());
  v_nombre        text;
  v_movimientos   bigint;
  v_suscripciones bigint;
  v_ingresos      bigint;
  v_valoraciones  bigint;
  v_posiciones    bigint;
  v_metas         bigint;
  v_tarjetas      bigint;
  v_cuentas       bigint;
begin
  if v_uid is null then
    raise exception 'Sesión sin verificar' using errcode = '42501';
  end if;

  -- FOR UPDATE: que nada la cambie (ni la renombre) entre la comprobación del
  -- nombre y el borrado.
  select a.name into v_nombre
  from public.account a
  where a.id = p_account_id and a.user_id = v_uid
  for update;

  if not found then
    raise exception 'Cuenta no encontrada' using errcode = 'P0002';
  end if;

  if p_confirm_name is null or btrim(p_confirm_name) <> btrim(v_nombre) then
    raise exception 'El nombre no coincide con el de la cuenta' using errcode = '22023';
  end if;

  -- Abre las políticas de borrado de account e investment_position SOLO para
  -- esta cuenta y SOLO en esta transacción.
  perform set_config('cartera.cuenta_a_borrar', p_account_id::text, true);

  -- 1. Movimientos, incluidos los traspasos por cualquiera de los dos lados.
  delete from public.transaction t
  where t.user_id = v_uid
    and (t.account_id = p_account_id or t.to_account_id = p_account_id);
  get diagnostics v_movimientos = row_count;

  -- 2. Compromisos periódicos.
  delete from public.subscription s
  where s.user_id = v_uid and s.account_id = p_account_id;
  get diagnostics v_suscripciones = row_count;

  delete from public.recurring_income r
  where r.user_id = v_uid and r.account_id = p_account_id;
  get diagnostics v_ingresos = row_count;

  -- 3. Posiciones y, en cascada, sus valoraciones (contadas antes).
  select count(*) into v_valoraciones
  from public.valuation v
  join public.investment_position p on p.user_id = v.user_id and p.id = v.position_id
  where v.user_id = v_uid and p.account_id = p_account_id;

  delete from public.investment_position p
  where p.user_id = v_uid and p.account_id = p_account_id;
  get diagnostics v_posiciones = row_count;

  -- 4. Metas y tarjetas.
  delete from public.savings_goal g
  where g.user_id = v_uid and g.account_id = p_account_id;
  get diagnostics v_metas = row_count;

  delete from public.card c
  where c.user_id = v_uid and c.account_id = p_account_id;
  get diagnostics v_tarjetas = row_count;

  -- 5. La cuenta.
  delete from public.account a
  where a.id = p_account_id and a.user_id = v_uid;
  get diagnostics v_cuentas = row_count;

  if v_cuentas <> 1 then
    raise exception 'No se pudo eliminar la cuenta' using errcode = '42501';
  end if;

  -- Se vuelve a cerrar en cuanto ya no hace falta, sin esperar al final de la
  -- transacción.
  perform set_config('cartera.cuenta_a_borrar', '', true);

  return jsonb_build_object(
    'transactions',      v_movimientos,
    'subscriptions',     v_suscripciones,
    'recurring_incomes', v_ingresos,
    'positions',         v_posiciones,
    'valuations',        v_valoraciones,
    'goals',             v_metas,
    'cards',             v_tarjetas
  );
end $$;

comment on function public.delete_account(uuid, text) is
  'Borra una cuenta con todos sus movimientos (incluidos los traspasos por cualquiera de sus lados), tarjetas, posiciones y valoraciones, suscripciones, ingresos recurrentes y metas, si p_confirm_name coincide con su nombre. Una sola transaccion. Devuelve los recuentos.';

revoke all on function public.delete_account(uuid, text) from public, anon;
grant execute on function public.delete_account(uuid, text) to authenticated;
