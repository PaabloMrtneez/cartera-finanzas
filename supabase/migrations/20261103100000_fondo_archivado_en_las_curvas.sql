-- ===========================================================================
-- Un fondo archivado deja de contar en las curvas de patrimonio desde que se
-- archiva, como en la cifra de cabecera.
--
-- Hallazgo de la auditoría del 30 de octubre. Archivar una posición la sacaba
-- de v_net_worth (la cifra de Patrimonio, `where not v.archived`), pero
-- private.account_worth_on —de la que salen net_worth_daily, net_worth_monthly
-- y net_worth_history— la seguía sumando. La curva acababa por encima de la
-- cifra, justo por el valor del fondo archivado. Ningún usuario real tenía un
-- fondo archivado; lo destapó test-graficos-datos con el usuario de pruebas.
--
-- No se podía arreglar quitando el fondo de toda la curva: el dinero que se le
-- aportó salió de la caja en su día, así que borrar su valor del pasado hundiría
-- el patrimonio de meses en los que el fondo existía. Hace falta saber CUÁNDO se
-- archivó:
--
--   · investment_position.archived_on: el DÍA en que se archivó, el de Madrid
--     (private.hoy()). Lo pone y lo quita un disparador al cambiar `archived`
--     (la app no tiene que hacer nada). A los ya archivados se les da el día de
--     su updated_at, la mejor fecha que hay.
--   · account_worth_on: el valor de la posición cuenta hasta el día anterior al
--     archivado y deja de contar desde ese día. Hoy coincide con v_net_worth;
--     el pasado no cambia.
--
-- Desarchivar quita la fecha y el fondo vuelve a contar en toda la curva.
-- La curva por posición de Inversiones (position_performance) ya ocultaba los
-- archivados y no se toca.
-- ===========================================================================

alter table public.investment_position add column archived_on date;

-- Una sola vez y fuera de toda función: el día de Madrid de su última edición.
update public.investment_position
   set archived_on = (updated_at at time zone 'Europe/Madrid')::date
 where archived;

alter table public.investment_position
  add constraint position_archived_on_coherente check (archived = (archived_on is not null));

comment on column public.investment_position.archived_on is
  'Día (de Madrid) en que se archivó; lo mantiene tg_posicion_archivada. Desde ese día su valor no cuenta en el patrimonio.';

create or replace function private.tg_posicion_archivada()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not new.archived then
    new.archived_on := null;
  elsif tg_op = 'INSERT' or not old.archived then
    new.archived_on := private.hoy();
  else
    -- Ya estaba archivada: la fecha no se reescribe a mano.
    new.archived_on := old.archived_on;
  end if;
  return new;
end $$;

revoke all on function private.tg_posicion_archivada() from public, anon, authenticated;

create trigger tg_posicion_archivada
  before insert or update of archived, archived_on on public.investment_position
  for each row execute function private.tg_posicion_archivada();

create or replace function private.account_worth_on(p_fechas date[])
returns table (
  account_id       uuid,
  type             public.account_type,
  fecha            date,
  balance_cents    bigint,
  aportado_cents   bigint,
  posiciones_cents bigint,
  worth_cents      bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with fechas as (
    select distinct f.d as fecha
    from unnest(p_fechas) as f(d)
    where f.d is not null
  ),
  eventos as (
    select v.account_id as cuenta,
           v.occurred_on as dia,
           sum(v.delta_cents) as delta,
           0::numeric as aportado
    from public.v_account_movement v
    group by v.account_id, v.occurred_on
    union all
    select p.account_id,
           t.occurred_on,
           0::numeric,
           sum(t.amount_cents)
    from public.transaction t
    join public.investment_position p
      on p.user_id = t.user_id and p.id = t.position_id
    where t.type = 'TRANSFER'
      and t.status <> 'DISCARDED'
    group by p.account_id, t.occurred_on
  ),
  linea as (
    select e.cuenta, e.dia, 0 as orden, e.delta, e.aportado
    from eventos e
    union all
    select a.id, f.fecha, 1, 0::numeric, 0::numeric
    from public.account a
    cross join fechas f
  ),
  acumulado as (
    select l.cuenta,
           l.dia,
           l.orden,
           sum(l.delta)    over w as delta,
           sum(l.aportado) over w as aportado
    from linea l
    window w as (partition by l.cuenta order by l.dia, l.orden
                 rows between unbounded preceding and current row)
  ),
  -- Una posición archivada cuenta hasta el día antes de archivarla y deja de
  -- contar desde ese día, como en v_net_worth (que ya la excluía hoy).
  posiciones as (
    select pv.account_id as cuenta,
           pv.fecha,
           sum(pv.value_cents) as cents
    from private.position_value_on((select array_agg(f.fecha) from fechas f)) pv
    join public.investment_position p
      on p.user_id = pv.user_id and p.id = pv.position_id
    where p.archived_on is null
       or pv.fecha < p.archived_on
    group by pv.account_id, pv.fecha
  )
  select a.id,
         a.type,
         ac.dia,
         (a.initial_balance_cents + coalesce(ac.delta, 0))::bigint,
         coalesce(ac.aportado, 0)::bigint,
         coalesce(po.cents, 0)::bigint,
         (a.initial_balance_cents + coalesce(ac.delta, 0)
            - coalesce(ac.aportado, 0) + coalesce(po.cents, 0))::bigint
  from acumulado ac
  join public.account a on a.id = ac.cuenta
  left join posiciones po on po.cuenta = ac.cuenta and po.fecha = ac.dia
  where ac.orden = 1;
$$;

revoke all on function private.account_worth_on(date[]) from public, anon;
grant execute on function private.account_worth_on(date[]) to authenticated;
