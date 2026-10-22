-- ===========================================================================
-- El recordatorio de pagos sin asignar: una vez al día, a las 9 de la mañana.
--
-- Antes salía cada dos horas, con la tarea programada. Un aviso repetido cada
-- dos horas por algo que no corre prisa se acaba silenciando, y entonces deja
-- de avisar también de lo que sí importa.
--
-- La marca por día es lo que garantiza el «una vez», y no la puntualidad del
-- cron: las tareas de GitHub Actions se retrasan con frecuencia diez o veinte
-- minutos, y a veces más. Fiarse solo de la hora daría avisos repetidos los
-- días que dispare dos veces dentro de la ventana, y ninguno los días que se
-- retrase más de una hora.
--
-- La fecha es la de Madrid, no la del servidor: entre medianoche y las dos, la
-- fecha UTC es todavía la de ayer.
-- ===========================================================================

alter table public.profile
  add column if not exists pending_notified_on date;

comment on column public.profile.pending_notified_on is
  'Último día (hora de Madrid) en que se avisó de los pagos sin asignar. Es lo que hace que el recordatorio salga una sola vez al día.';


create or replace function public.claim_pending_reminder(p_from_hour integer default 9)
returns table (user_id uuid, cuantos integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy  date    := (now() at time zone 'Europe/Madrid')::date;
  v_hora integer := extract(hour from (now() at time zone 'Europe/Madrid'))::integer;
begin
  -- Antes de la hora acordada no se avisa. Después sí, aunque el cron llegue
  -- tarde: lo que impide repetir es la marca, no el reloj.
  if v_hora < p_from_hour then
    return;
  end if;

  return query
  with pendientes as (
    select t.user_id, count(*)::integer as cuantos
    from public.transaction t
    where t.status = 'PENDING'
    group by t.user_id
  ),
  -- Se marca ANTES de devolver, igual que los avisos de límite: si el envío
  -- falla, se pierde un recordatorio, que es mucho mejor que mandar el mismo
  -- cinco veces porque el marcado nunca llegó a ocurrir.
  marcados as (
    update public.profile p
       set pending_notified_on = v_hoy
      from pendientes x
     where p.user_id = x.user_id
       and (p.pending_notified_on is null or p.pending_notified_on < v_hoy)
    returning p.user_id
  )
  select m.user_id, x.cuantos
  from marcados m
  join pendientes x on x.user_id = m.user_id;
end $$;

revoke all on function public.claim_pending_reminder(integer) from public, anon, authenticated;
grant execute on function public.claim_pending_reminder(integer) to service_role;

comment on function public.claim_pending_reminder is
  'Los usuarios a los que toca recordarles los pagos sin asignar, una vez al día desde la hora indicada. Marca antes de devolver: repetir un aviso molesta más que perderlo.';
