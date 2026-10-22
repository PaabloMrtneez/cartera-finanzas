-- ===========================================================================
-- Apuntar un gasto y declarar de paso que se repite.
--
-- Va en una sola función, y no en dos escrituras desde la aplicación, porque
-- las dos cosas tienen que pasar juntas o ninguna. Si se creara el gasto y
-- fallara la suscripción, quedaría un movimiento suelto y la persona creyendo
-- que se repite: el mes siguiente no llegaría el cargo y no habría forma de
-- saber por qué.
--
-- El gasto se enlaza a su suscripción con `subscription_id`. Eso hace dos cosas:
-- lo cuenta como el primer cargo en el histórico, y lo protege del generador,
-- porque el índice único (user_id, subscription_id, occurred_on) impide que
-- vuelva a crearse ese mismo día.
--
-- `source` se queda en MANUAL a propósito: RECURRING significa «lo generó el
-- sistema», y este lo has escrito tú. El enlace es lo que hace el trabajo; el
-- origen solo cuenta la verdad de dónde vino.
--
-- La siguiente fecha de cargo se adelanta una periodicidad desde la fecha del
-- gasto, así que el generador arranca por el cargo que viene y no repite el
-- que acabas de apuntar.
-- ===========================================================================

create or replace function public.create_expense_with_subscription(
  p_amount_cents bigint,
  p_description  text,
  p_occurred_on  date,
  p_account_id   uuid,
  p_category_id  uuid,
  p_periodicity  public.periodicity,
  p_note         text default null,
  p_occurred_time time default '00:00'
)
returns table (transaction_id uuid, subscription_id uuid, next_charge_date date)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user     uuid := (select private.current_user_id());
  v_cat_type public.entry_type;
  v_sub      uuid;
  v_tx       uuid;
  v_siguiente date;
begin
  if v_user is null then
    raise exception 'Sesión no válida';
  end if;

  -- El tipo de la categoría se lee de la propia categoría, no se recibe: es lo
  -- que impide colgar un gasto de una categoría de ingresos, porque la clave
  -- foránea compuesta comprueba el par (id, tipo).
  if p_category_id is not null then
    select c.type into v_cat_type
    from public.category c
    where c.id = p_category_id and c.user_id = v_user;

    if v_cat_type is null then
      raise exception 'La categoría no existe';
    end if;
    if v_cat_type <> 'EXPENSE' then
      raise exception 'Una suscripción solo puede colgar de una categoría de gasto';
    end if;
  end if;

  v_siguiente := private.next_charge(p_occurred_on, p_periodicity);

  insert into public.subscription (
    user_id, description, amount_cents, periodicity,
    next_charge_date, started_at, account_id, category_id, category_type, active
  )
  values (
    v_user, p_description, p_amount_cents, p_periodicity,
    v_siguiente, p_occurred_on, p_account_id, p_category_id, v_cat_type, true
  )
  returning id into v_sub;

  insert into public.transaction (
    user_id, type, amount_cents, description, occurred_on, occurred_time,
    account_id, category_id, category_type, note,
    source, status, subscription_id
  )
  values (
    v_user, 'EXPENSE', p_amount_cents, p_description, p_occurred_on, p_occurred_time,
    p_account_id, p_category_id, v_cat_type, p_note,
    'MANUAL', 'CONFIRMED', v_sub
  )
  returning id into v_tx;

  return query select v_tx, v_sub, v_siguiente;
end;
$$;

comment on function public.create_expense_with_subscription is
  'Crea un gasto y la suscripción que lo repite, en una sola transacción. El gasto queda enlazado, así que el generador no lo duplica.';
