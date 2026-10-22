-- ===========================================================================
-- Eliminar un fondo (una posición de inversión), con su historia y con aviso.
--
-- Hasta ahora una posición solo se archivaba: la RLS no deja borrarla salvo
-- dentro de `delete_account` (20261007090000_eliminar_cuentas.sql). Archivar
-- sigue siendo lo recomendable —conserva la historia—, pero un fondo dado de
-- alta por error, o uno que ya no se quiere ver ni en el pasado, tiene que
-- poder quitarse de verdad.
--
-- Decisión del usuario: al eliminar un fondo se borran
--
--   · la posición,
--   · sus valoraciones (`valuation`, cascade),
--   · su libro de participaciones (`position_unit_event`, cascade),
--   · y los MOVIMIENTOS QUE LE APORTARON DINERO: todo traspaso enlazado a la
--     posición (`transaction.position_id`), que es exactamente lo que
--     `v_position_contributions` cuenta como aportación.
--
-- Al borrar las aportaciones, el dinero vuelve a contar en las cuentas de las
-- que salió, como si nunca se hubiera movido, y la cuenta de inversión baja lo
-- mismo. Tras una confirmación que enseña todo eso y obliga a escribir el
-- nombre del fondo. Dos funciones, calcadas de las de cuentas:
--
--   position_delete_preview(id)          → qué se borraría y qué cambia.
--   delete_position(id, nombre_escrito)  → lo borra todo en una transacción.
--
-- El catálogo compartido (instrument, instrument_price, fx_rate) NO se toca:
-- no es de nadie, y otro usuario puede estar siguiendo el mismo fondo.
--
-- ── Por qué `security invoker` y la política de borrado ────────────────────
-- Como en delete_account: las dos funciones corren con los permisos de quien
-- llama, así que la RLS se aplica a cada SELECT y a cada DELETE además del
-- filtro explícito por user_id. Para que el DELETE sobre investment_position
-- sea posible sin abrir el borrado directo desde el cliente, la política
-- `investment_position_del` se redefine para que se abra con UNA de dos
-- variables de transacción:
--
--   cartera.cuenta_a_borrar   = id de la cuenta   (la fija delete_account)
--   cartera.posicion_a_borrar = id de la posición (la fija delete_position)
--
-- La segunda abre solo esa fila, solo en esa transacción, y solo después de
-- comprobar el nombre; se vacía al terminar. El cliente no puede fijar ninguna
-- de las dos (PostgREST no expone set_config). Un DELETE directo sobre
-- investment_position sigue afectando a cero filas.
--
-- ── Decisiones de modelo ───────────────────────────────────────────────────
--   · QUÉ ES UNA APORTACIÓN. Cualquier traspaso con position_id = la posición,
--     en el sentido que sea. La interfaz solo enlaza traspasos HACIA la cuenta
--     de la posición (no existe la «retirada» enlazada), pero la base no lo
--     impone, así que el efecto en los saldos se calcula por lados y no se da
--     por supuesto: el lado de origen sube lo que salió por él y el de destino
--     baja lo que entró. Un traspaso no tiene signo (invariante 3): el gasto,
--     el ingreso y el balance de los meses no cambian, solo los saldos.
--   · DESCARTADOS. Los traspasos descartados enlazados a la posición también
--     se borran (no movían saldo, así que no cambian nada). Dejarlos con la FK
--     `set null` los dejaría sin posición, y si llevaban participaciones
--     (`position_units`) el CHECK `tx_units_only_position` haría fallar todo
--     el borrado. Borrando TODA fila con position_id = la posición antes de la
--     posición, no queda ningún camino en el que una fila sobreviva con
--     participaciones y sin posición.
--   · REEMBOLSOS (invariante 4). Una aportación es un TRASPASO, y un
--     reembolso solo puede vivir en un ingreso y apuntar a un gasto
--     (tx_reimburses_only_income, tx_reimburses_target y la FK compuesta con
--     el tipo). Ninguna aportación puede reembolsar ni ser reembolsada: no hay
--     enlaces que desenganchar. Si el modelo cambiara algún día, la FK de
--     reembolso es `set null` y actuaría como en delete_account (el ingreso
--     sobrevive y pasa a ingreso normal).
--   · SUSCRIPCIONES. Una suscripción genera gastos, no traspasos; si alguna
--     aportación llevara subscription_id, se borra la aportación y la
--     suscripción sigue (la FK es del movimiento a la suscripción).
--   · PATRIMONIO. Nada se almacena (invariante 2): saldos, patrimonio, metas y
--     rendimientos se recalculan solos. El patrimonio cambia en
--         + lo aportado (vuelve a la caja de las cuentas de origen)
--         − el valor de la posición (si no estaba archivada; las archivadas ya
--           no contaban en v_net_worth)
--     porque v_net_worth y v_account_worth restan lo aportado del saldo de la
--     cuenta de inversión y suman el valor de las posiciones activas. El
--     preview lo da en céntimos (`net_worth_delta_cents`).
--   · METAS. Una meta cuelga de una cuenta, no de una posición: sigue, y su
--     progreso se recalcula con el nuevo valor de la cuenta.
--
-- Todo importe es entero en céntimos (bigint).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Política de borrado de posiciones: abierta solo dentro de delete_account
-- (toda la cuenta) o de delete_position (esa posición).
--
-- `(select current_setting(...))` se evalúa una vez por sentencia (initplan).
-- El `true` hace que una variable nunca fijada devuelva NULL, y `x = NULL` no
-- deja pasar ninguna fila. Una variable vaciada ('') tampoco casa con un uuid.
-- ---------------------------------------------------------------------------
drop policy investment_position_del on public.investment_position;

create policy investment_position_del on public.investment_position for delete to authenticated
  using (
    user_id = (select private.current_user_id())
    and (
      account_id::text = (select current_setting('cartera.cuenta_a_borrar', true))
      or id::text = (select current_setting('cartera.posicion_a_borrar', true))
    )
  );


-- ---------------------------------------------------------------------------
-- position_delete_preview — qué se borraría, sin borrar nada.
--
-- Devuelve un objeto con:
--   position_id, name, archived, follows_instrument
--   account_id, account_name   la cuenta de inversión de la que cuelga
--   value_cents                valor actual de la posición (v_position_value)
--   valuations                 valoraciones que se borran
--   unit_events                eventos del libro de participaciones (ALTA,
--                              AJUSTE, BAJA) que se borran
--   contributions              { count, cents, discarded } — aportaciones que
--                              se borran: las que movían saldo (count, y su
--                              importe total en cents) y las descartadas
--   balance_effects            [{ account_id, name, archived, transfers,
--                                 balance_delta_cents }] — por cada cuenta
--                              cuyo saldo cambia al borrar las aportaciones
--                              (positivo = sube: el dinero vuelve; negativo =
--                              baja). Suman cero: un traspaso solo mueve.
--   net_worth_delta_cents      cuánto cambia el patrimonio neto
--
-- Una posición ajena o inexistente da el mismo error («no encontrada»). Sin
-- aal2 no hay usuario.
-- ---------------------------------------------------------------------------
create or replace function public.position_delete_preview(p_position_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid      uuid := (select private.current_user_id());
  v_posicion public.investment_position%rowtype;
  v_valor    bigint;
  v_seguida  boolean;
  v_aportado bigint;
begin
  if v_uid is null then
    raise exception 'Sesión sin verificar' using errcode = '42501';
  end if;

  select * into v_posicion
  from public.investment_position p
  where p.id = p_position_id and p.user_id = v_uid;

  if not found then
    raise exception 'Posición no encontrada' using errcode = 'P0002';
  end if;

  select coalesce(pv.value_cents, 0)::bigint, (pv.instrument_id is not null)
    into v_valor, v_seguida
  from public.v_position_value pv
  where pv.user_id = v_uid and pv.position_id = p_position_id;

  -- Lo aportado, con el mismo filtro que v_position_contributions.
  select coalesce(sum(t.amount_cents), 0)::bigint into v_aportado
  from public.transaction t
  where t.user_id = v_uid
    and t.position_id = p_position_id
    and t.type = 'TRANSFER'
    and t.status <> 'DISCARDED';

  return jsonb_build_object(
    'position_id',        v_posicion.id,
    'name',               v_posicion.name,
    'archived',           v_posicion.archived,
    'follows_instrument', coalesce(v_seguida, false),
    'account_id',         v_posicion.account_id,
    'account_name', (
      select a.name from public.account a
      where a.user_id = v_uid and a.id = v_posicion.account_id),
    'value_cents',        coalesce(v_valor, 0),

    'valuations', (
      select count(*) from public.valuation v
      where v.user_id = v_uid and v.position_id = p_position_id),
    'unit_events', (
      select count(*) from public.position_unit_event e
      where e.user_id = v_uid and e.position_id = p_position_id),

    'contributions', (
      select jsonb_build_object(
               'count',     count(*) filter (where t.status <> 'DISCARDED'),
               'cents',     v_aportado,
               'discarded', count(*) filter (where t.status = 'DISCARDED'))
      from public.transaction t
      where t.user_id = v_uid and t.position_id = p_position_id),

    'balance_effects', (
      select coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'account_id',          x.cuenta,
                   'name',                a.name,
                   'archived',            a.archived,
                   'transfers',           x.n,
                   'balance_delta_cents', x.delta)
                 order by x.delta desc, a.name),
               '[]'::jsonb)
      from (
        select l.cuenta, count(*) as n, sum(l.delta)::bigint as delta
        from public.transaction t
        cross join lateral (
          -- Salió de aquí: al borrarlo, esta cuenta sube.
          values (t.account_id, t.amount_cents),
          -- Entró aquí: al borrarlo, esta cuenta baja.
                 (t.to_account_id, -t.amount_cents)
        ) as l(cuenta, delta)
        where t.user_id = v_uid
          and t.position_id = p_position_id
          and t.type = 'TRANSFER'
          and t.status <> 'DISCARDED'
        group by l.cuenta
      ) x
      join public.account a on a.user_id = v_uid and a.id = x.cuenta),

    'net_worth_delta_cents',
      v_aportado - case when v_posicion.archived then 0 else coalesce(v_valor, 0) end
  );
end $$;

comment on function public.position_delete_preview(uuid) is
  'Lo que borraria delete_position: valoraciones, eventos del libro de participaciones y aportaciones (traspasos enlazados), con el cambio de saldo de cada cuenta afectada y del patrimonio, en centimos. No borra nada.';

revoke all on function public.position_delete_preview(uuid) from public, anon;
grant execute on function public.position_delete_preview(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- delete_position — borra la posición, su historia y sus aportaciones, en una
-- sola transacción.
--
-- `p_confirm_name` tiene que coincidir EXACTAMENTE con el nombre de la
-- posición tras btrim en los dos lados. Mayúsculas y tildes cuentan.
--
-- Orden:
--   1. FOR UPDATE sobre la posición: nadie la renombra entre la comprobación y
--      el borrado, y una aportación nueva que llegue a la vez espera (su FK
--      necesita un bloqueo compatible sobre la fila) y luego falla, en vez de
--      colarse con la posición ya borrada.
--   2. Las aportaciones: TODA fila de transaction con position_id = la
--      posición, también las descartadas (ver arriba).
--   3. La posición. Sus valoraciones y su libro caen en cascada (contados
--      antes).
--
-- Si el DELETE de la posición no borra una fila (no debería pasar: ya se
-- comprobó que es suya), se lanza un error y la transacción entera se deshace:
-- nunca se quedan las aportaciones borradas con la posición viva.
--
-- Devuelve los recuentos de lo borrado.
-- ---------------------------------------------------------------------------
create or replace function public.delete_position(p_position_id uuid, p_confirm_name text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid          uuid := (select private.current_user_id());
  v_nombre       text;
  v_valoraciones bigint;
  v_eventos      bigint;
  v_aportado     bigint;
  v_movimientos  bigint;
  v_posiciones   bigint;
begin
  if v_uid is null then
    raise exception 'Sesión sin verificar' using errcode = '42501';
  end if;

  select p.name into v_nombre
  from public.investment_position p
  where p.id = p_position_id and p.user_id = v_uid
  for update;

  if not found then
    raise exception 'Posición no encontrada' using errcode = 'P0002';
  end if;

  if p_confirm_name is null or btrim(p_confirm_name) <> btrim(v_nombre) then
    raise exception 'El nombre no coincide con el de la posición' using errcode = '22023';
  end if;

  -- Recuentos de lo que cae en cascada, antes de que caiga.
  select count(*) into v_valoraciones
  from public.valuation v
  where v.user_id = v_uid and v.position_id = p_position_id;

  select count(*) into v_eventos
  from public.position_unit_event e
  where e.user_id = v_uid and e.position_id = p_position_id;

  select coalesce(sum(t.amount_cents), 0)::bigint into v_aportado
  from public.transaction t
  where t.user_id = v_uid
    and t.position_id = p_position_id
    and t.type = 'TRANSFER'
    and t.status <> 'DISCARDED';

  -- 2. Las aportaciones, todas.
  delete from public.transaction t
  where t.user_id = v_uid and t.position_id = p_position_id;
  get diagnostics v_movimientos = row_count;

  -- 3. La posición: abre la política SOLO para esta fila y SOLO aquí.
  perform set_config('cartera.posicion_a_borrar', p_position_id::text, true);

  delete from public.investment_position p
  where p.id = p_position_id and p.user_id = v_uid;
  get diagnostics v_posiciones = row_count;

  perform set_config('cartera.posicion_a_borrar', '', true);

  if v_posiciones <> 1 then
    raise exception 'No se pudo eliminar la posición' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'transactions',        v_movimientos,
    'contributed_cents',   v_aportado,
    'valuations',          v_valoraciones,
    'unit_events',         v_eventos
  );
end $$;

comment on function public.delete_position(uuid, text) is
  'Borra una posicion con sus valoraciones, su libro de participaciones y todas sus aportaciones (traspasos enlazados, tambien los descartados), si p_confirm_name coincide con su nombre. El catalogo de instrumentos y precios no se toca. Una sola transaccion. Devuelve los recuentos.';

revoke all on function public.delete_position(uuid, text) from public, anon;
grant execute on function public.delete_position(uuid, text) to authenticated;
