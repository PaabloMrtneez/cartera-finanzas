-- ===========================================================================
-- Cartera — cálculos derivados
--
-- Nada de esto se almacena. Los saldos, el gasto neto y el patrimonio se
-- calculan siempre desde los movimientos.
--
-- Con cuatro usuarios y unos miles de filas el coste es despreciable, y a
-- cambio es imposible que una cifra se quede obsoleta. Si algún día hiciera
-- falta acelerar, la respuesta correcta NO es cachear el saldo, sino un cierre
-- mensual inmutable verificado contra el recálculo completo.
--
-- Todas las vistas llevan security_invoker: sin él se ejecutarían con los
-- permisos de quien las creó y saltarían la seguridad por filas, filtrando
-- datos entre los cuatro usuarios.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Movimientos con signo, desde el punto de vista de cada cuenta.
--
-- Un traspaso aparece dos veces: sale del origen y entra en el destino. Por eso
-- no tiene signo propio y no afecta al balance del mes.
--
-- Las transacciones PENDING SÍ cuentan: el dinero ya salió de la cuenta. La
-- confirmación es un paso de clasificación, no de realidad; si no contaran, el
-- saldo mentiría hasta que abrieras la app. DISCARDED es el único estado que
-- no suma.
-- ---------------------------------------------------------------------------
create view public.v_account_movement with (security_invoker = true) as
  select t.user_id,
         t.account_id,
         t.id as transaction_id,
         t.occurred_on,
         t.period_month,
         case t.type
           when 'EXPENSE'  then -t.amount_cents
           when 'INCOME'   then  t.amount_cents
           when 'TRANSFER' then -t.amount_cents
         end as delta_cents
  from public.transaction t
  where t.status <> 'DISCARDED'
union all
  select t.user_id,
         t.to_account_id,
         t.id,
         t.occurred_on,
         t.period_month,
         t.amount_cents
  from public.transaction t
  where t.type = 'TRANSFER' and t.status <> 'DISCARDED';


-- ---------------------------------------------------------------------------
-- Saldo de cada cuenta = punto de partida + todo lo que se ha movido.
-- ---------------------------------------------------------------------------
create view public.v_account_balance with (security_invoker = true) as
select a.user_id,
       a.id as account_id,
       a.name,
       a.type,
       a.color,
       a.card_last4,
       a.archived,
       a.initial_balance_cents,
       a.initial_balance_cents + coalesce(m.sum_delta, 0) as balance_cents,
       coalesce(m.movement_count, 0) as movement_count
from public.account a
left join lateral (
  select sum(v.delta_cents) as sum_delta,
         count(*)           as movement_count
  from public.v_account_movement v
  where v.account_id = a.id
) m on true;


-- ---------------------------------------------------------------------------
-- La vista económica: aquí viven los reembolsos y el concepto bruto/neto.
--
-- Un ingreso que reembolsa un gasto NO es un ingreso: abarata el gasto. Por eso
-- se imputa a la categoría del gasto enlazado, no a la suya, y resta del gasto
-- neto en vez de sumar a los ingresos.
--
-- Los traspasos se excluyen aquí, de una vez y para siempre. Así el invariante
-- «un traspaso no afecta a gasto, ingreso, balance, donut ni límites» queda
-- garantizado en un único sitio, y no depende de que cada consulta se acuerde.
-- ---------------------------------------------------------------------------
create view public.v_transaction_econ with (security_invoker = true) as
select t.user_id,
       t.id,
       t.period_month,
       t.occurred_on,
       t.type,
       t.amount_cents,
       t.status,

       case when t.reimburses_id is not null then r.category_id else t.category_id end
         as econ_category_id,

       case
         when t.type = 'EXPENSE'                                then  t.amount_cents
         when t.type = 'INCOME' and t.reimburses_id is not null then -t.amount_cents
         else 0
       end as net_expense_cents,

       case
         when t.type = 'INCOME' and t.reimburses_id is null then t.amount_cents
         else 0
       end as real_income_cents,

       (t.reimburses_id is not null) as is_reimbursement
from public.transaction t
left join public.transaction r
  on r.id = t.reimburses_id and r.user_id = t.user_id
where t.status <> 'DISCARDED'
  and t.type <> 'TRANSFER';


-- ---------------------------------------------------------------------------
-- Resumen de un mes.
--
-- Nota sobre reembolsos a caballo entre meses: si compras en enero y te
-- devuelven en febrero, el reembolso resta en FEBRERO, el mes del ingreso. Es
-- la opción estable: los meses ya cerrados no cambian y los avisos que ya se
-- dispararon no se contradicen a posteriori.
-- ---------------------------------------------------------------------------
create view public.v_month_summary with (security_invoker = true) as
select user_id,
       period_month,
       sum(real_income_cents)                          as income_cents,
       sum(net_expense_cents)                          as net_expense_cents,
       sum(real_income_cents) - sum(net_expense_cents) as month_balance_cents,
       sum(amount_cents) filter (where type = 'EXPENSE')            as gross_expense_cents,
       sum(amount_cents) filter (where is_reimbursement)            as reimbursed_cents,
       count(*) filter (where econ_category_id is null
                          and type = 'EXPENSE')                     as unclassified_count,
       count(*) filter (where status = 'PENDING')                   as pending_count
from public.v_transaction_econ
group by user_id, period_month;


-- ---------------------------------------------------------------------------
-- Reparto por categoría de un mes (el donut).
-- ---------------------------------------------------------------------------
create function public.category_breakdown(p_month date)
returns table (
  category_id uuid,
  name        text,
  color       text,
  icon        text,
  net_cents   bigint,
  share       numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select e.econ_category_id as cid,
           sum(e.net_expense_cents) as cents
    from public.v_transaction_econ e
    where e.period_month = date_trunc('month', p_month::timestamp)::date
    group by 1
    having sum(e.net_expense_cents) <> 0
  ),
  total as (
    select nullif(sum(cents), 0) as t from base where cents > 0
  )
  select b.cid,
         coalesce(c.name, 'Sin categoría'),
         coalesce(c.color, '#9ca3af'),
         coalesce(c.icon, 'circle-help'),
         b.cents,
         round(100.0 * b.cents / (select t from total), 1)
  from base b
  left join public.category c on c.id = b.cid
  order by b.cents desc;
$$;


-- ---------------------------------------------------------------------------
-- Comercios sin clasificar que se repiten: la base de «crea una regla para
-- CARREFOUR, hay 7 pagos sin clasificar por 112,40 €».
-- ---------------------------------------------------------------------------
create view public.v_rule_suggestions with (security_invoker = true) as
select t.user_id,
       upper(btrim(t.merchant_raw)) as merchant,
       count(*)                     as occurrences,
       sum(t.amount_cents)          as total_cents,
       max(t.occurred_on)           as last_seen
from public.transaction t
where t.category_id is null
  and t.merchant_raw is not null
  and t.status <> 'DISCARDED'
group by 1, 2
having count(*) >= 2;


-- ===========================================================================
-- Motor de reglas de comercio
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Qué regla gana para un texto de comercio dado.
--
-- IMPORTANTE: usa position(), no LIKE. La especificación original decía
-- `LOWER(merchant) LIKE '%' || LOWER(match_text) || '%'`, y eso está roto: los
-- caracteres % y _ dentro del texto de la regla actuarían como comodines. Una
-- regla «50% dto» casaría con cualquier comercio que empiece por «50», y una
-- regla «a_b» casaría con «acb». position() busca la subcadena literal, que es
-- exactamente la semántica descrita: sin distinguir mayúsculas y en cualquier
-- posición.
--
-- Desempate: gana la regla con el texto más largo, es decir, la más específica.
-- «CARREFOUR EXPRESS» gana a «CARREFOUR».
-- ---------------------------------------------------------------------------
create function private.match_rule(p_user uuid, p_merchant text)
returns table (category_id uuid, category_type public.entry_type, rule_id uuid)
language sql
stable
set search_path = ''
as $$
  select r.category_id, r.category_type, r.id
  from public.merchant_rule r
  where r.user_id = p_user
    and p_merchant is not null
    and position(r.match_norm in lower(p_merchant)) > 0
  order by length(r.match_norm) desc, r.created_at asc, r.id asc
  limit 1;
$$;


-- ---------------------------------------------------------------------------
-- Aplicar reglas retroactivamente.
--
-- Dos decisiones deliberadas:
--
--   · Solo toca lo que está SIN CLASIFICAR. Nunca pisa una categoría que el
--     usuario haya puesto a mano.
--   · Recalcula qué regla gana en lugar de aplicar la nueva a ciegas. Si creas
--     «CARREFOUR» cuando ya existe «CARREFOUR EXPRESS», una aplicación ingenua
--     le robaría movimientos a la regla más específica.
-- ---------------------------------------------------------------------------
create function public.apply_merchant_rule(p_rule_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user  uuid := (select private.current_user_id());
  v_count integer;
begin
  if v_user is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  with candidate as (
    select t.id as tx_id, m.category_id, m.category_type, m.rule_id
    from public.transaction t
    cross join lateral private.match_rule(t.user_id, t.merchant_raw) m
    where t.user_id = v_user
      and t.category_id is null
      and t.merchant_raw is not null
      and t.status <> 'DISCARDED'
  )
  update public.transaction t
     set category_id   = c.category_id,
         category_type = c.category_type
  from candidate c
  where t.id = c.tx_id
    and c.rule_id = p_rule_id;

  get diagnostics v_count = row_count;

  update public.merchant_rule
     set hit_count = hit_count + v_count
   where id = p_rule_id and user_id = v_user;

  return v_count;
end $$;


-- ---------------------------------------------------------------------------
-- Cuántos movimientos afectaría una regla antes de crearla («coincide con 3
-- del histórico»).
-- ---------------------------------------------------------------------------
create function public.preview_merchant_rule(p_match_text text)
returns table (occurrences integer, total_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer, coalesce(sum(t.amount_cents), 0)::bigint
  from public.transaction t
  where t.user_id = (select private.current_user_id())
    and t.category_id is null
    and t.merchant_raw is not null
    and t.status <> 'DISCARDED'
    and position(lower(btrim(p_match_text)) in lower(t.merchant_raw)) > 0;
$$;


-- ===========================================================================
-- Ingesta desde el Atajo de iOS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Toda la ingesta ocurre dentro de esta función, en una sola transacción de
-- base de datos: autenticación del dispositivo, limitación de peticiones,
-- idempotencia, motor de reglas e inserción. Dos reintentos simultáneos del
-- Atajo no pueden crear dos movimientos.
--
-- Es SECURITY DEFINER a propósito: el Atajo no tiene sesión de usuario, se
-- autentica con su propio token de dispositivo. Por eso NO lleva el filtro de
-- 2FA — un token aleatorio de 256 bits guardado en el llavero del iPhone ES un
-- segundo factor, y además solo puede escribir. Si alguien «endurece» esta
-- función añadiéndole el predicado aal2, romperá la ingesta.
--
-- El importe llega ya convertido a céntimos enteros: lo normaliza la ruta de
-- la API con parseAmountToCents(), que está probada y entiende tanto el formato
-- español como el anglosajón. Hacerlo aquí con replace() de puntos y comas
-- interpretaría «12.40» como 1.240 €.
-- ---------------------------------------------------------------------------
create function public.ingest_transaction(
  p_token        text,
  p_amount_cents bigint,
  p_payload      jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev      public.ingest_device%rowtype;
  v_window   timestamptz := date_trunc('hour', now())
                            + floor(extract(minute from now()) / 10) * interval '10 minutes';
  v_hits     integer;
  v_merchant text := nullif(btrim(p_payload ->> 'merchant'), '');
  v_card     text := nullif(regexp_replace(coalesce(p_payload ->> 'card', ''), '\D', '', 'g'), '');
  v_when     timestamptz;
  v_local    timestamp;
  v_ext      text := nullif(btrim(p_payload ->> 'external_id'), '');
  v_account  uuid;
  v_cat      uuid;
  v_cat_type public.entry_type;
  v_id       uuid;
  v_dup      boolean := false;
begin
  -- 1) Autenticar el dispositivo. La búsqueda va por el hash, nunca por el
  --    secreto, y el índice único sobre token_hash la hace inmediata.
  select * into v_dev
  from public.ingest_device
  where token_hash = extensions.digest(p_token, 'sha256')
    and revoked_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  -- 2) Limitar peticiones: 60 cada 10 minutos y por dispositivo.
  insert into public.ingest_bucket (device_id, window_start, hits)
  values (v_dev.id, v_window, 1)
  on conflict (device_id, window_start)
    do update set hits = public.ingest_bucket.hits + 1
  returning hits into v_hits;

  if v_hits > 60 then
    insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
    values (v_dev.id, v_dev.user_id, 'RATE_LIMITED', p_payload);
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'retry_after', 600);
  end if;

  update public.ingest_device
     set last_used_at = now(), request_count = request_count + 1
   where id = v_dev.id;

  -- 3) El importe ya viene normalizado y validado por la ruta de la API.
  if p_amount_cents is null or p_amount_cents <= 0 then
    insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
    values (v_dev.id, v_dev.user_id, 'BAD_AMOUNT', p_payload);
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  -- 4) Fecha local: los meses deben cuadrar en Madrid, no en UTC.
  v_when  := coalesce((p_payload ->> 'occurred_at')::timestamptz, now());
  v_local := v_when at time zone 'Europe/Madrid';

  -- 5) ¿A qué cuenta va? Primero por la tarjeta; si no, la cuenta que el
  --    usuario haya designado en Ajustes. Nunca se adivina: si no hay ninguna,
  --    se rechaza y queda registrado para poder recuperarlo después.
  select a.id into v_account
  from public.account a
  where a.user_id = v_dev.user_id and a.card_last4 = v_card and not a.archived
  limit 1;

  if v_account is null then
    select p.default_ingest_account_id into v_account
    from public.profile p where p.user_id = v_dev.user_id;
  end if;

  if v_account is null then
    insert into public.ingest_dead_letter (device_id, user_id, reason, payload)
    values (v_dev.id, v_dev.user_id, 'NO_ACCOUNT', p_payload);
    return jsonb_build_object('ok', false, 'error', 'no_account_configured');
  end if;

  -- 6) Idempotencia. Lo ideal es que el Atajo mande un identificador propio por
  --    ejecución; si no lo hace, se sintetiza uno determinista para que un
  --    reintento no duplique el cargo.
  if v_ext is null then
    v_ext := 'syn_' || encode(extensions.digest(
               v_dev.user_id::text || '|' || coalesce(v_merchant, '') || '|'
               || p_amount_cents::text || '|' || to_char(v_local, 'YYYYMMDDHH24MI')
               || '|' || coalesce(v_card, ''), 'sha256'), 'hex');
  end if;

  -- 7) Motor de reglas.
  select m.category_id, m.category_type into v_cat, v_cat_type
  from private.match_rule(v_dev.user_id, v_merchant) m;

  -- 8) Insertar. Si una regla acierta la categoría, el movimiento entra ya
  --    confirmado y contando; si no, espera en la bandeja de pendientes.
  insert into public.transaction (
    user_id, type, amount_cents, description,
    occurred_on, occurred_time, occurred_at,
    account_id, category_id, category_type,
    source, status, merchant_raw, card_last4, external_id, device_id
  )
  values (
    v_dev.user_id, 'EXPENSE', p_amount_cents, coalesce(v_merchant, 'Cargo'),
    v_local::date, v_local::time, v_when,
    v_account, v_cat, v_cat_type,
    'SHORTCUT',
    case when v_cat is null then 'PENDING'::public.tx_status else 'CONFIRMED'::public.tx_status end,
    v_merchant, v_card, v_ext, v_dev.id
  )
  on conflict (user_id, external_id) where external_id is not null do nothing
  returning id into v_id;

  if v_id is null then
    v_dup := true;
    select id into v_id
    from public.transaction
    where user_id = v_dev.user_id and external_id = v_ext;
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'duplicate', v_dup,
    'amount_cents', p_amount_cents,
    'status', case when v_cat is null then 'PENDING' else 'CONFIRMED' end,
    'category', (select c.name from public.category c where c.id = v_cat)
  );
end $$;

revoke all on function public.ingest_transaction(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_transaction(text, bigint, jsonb) to service_role;


-- ---------------------------------------------------------------------------
-- Alta de un dispositivo de ingesta. Devuelve el token en claro UNA SOLA VEZ:
-- en la base de datos solo queda su hash, así que si se pierde hay que generar
-- otro. Es lo correcto — un token recuperable es un token filtrable.
-- ---------------------------------------------------------------------------
create function public.create_ingest_device(p_name text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user   uuid := (select private.current_user_id());
  v_secret text;
  v_token  text;
  v_id     uuid;
begin
  if v_user is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  -- 32 bytes de entropía, en hexadecimal.
  v_secret := encode(extensions.gen_random_bytes(32), 'hex');
  v_token  := 'cart_' || v_secret;

  insert into public.ingest_device (user_id, name, token_hash, token_prefix)
  values (v_user, btrim(p_name), extensions.digest(v_token, 'sha256'),
          'cart_' || left(v_secret, 6))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'name', btrim(p_name), 'token', v_token);
end $$;


create function public.revoke_ingest_device(p_device_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.ingest_device
     set revoked_at = now()
   where id = p_device_id
     and user_id = (select private.current_user_id())
     and revoked_at is null;
$$;
