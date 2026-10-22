-- ===========================================================================
-- Observabilidad de la ingesta del Atajo: que el dueño se entere cuando algo
-- va mal, en vez de descubrirlo por sorpresa dos pagos después.
--
-- La telemetría ya se guardaba —cada rechazo cae en `ingest_dead_letter`, y
-- cada dispositivo lleva `request_count` y `last_used_at`—, pero nadie la
-- miraba hasta abrir Ajustes. Aquí se convierte ese rastro en una SEÑAL de
-- salud por usuario y se le engancha un aviso.
--
-- Dos condiciones, ambas a partir de datos que ya existen:
--
--   (a) Rechazos recientes: demasiados descartes en las últimas 24 h. El Atajo
--       manda basura, o un importe/tarjeta/cuenta viene mal. Umbral: 3.
--   (b) Dispositivo mudo: un dispositivo que ESTUVO activo (request_count > 0)
--       y lleva 5 días o más sin dar señales. El Atajo se rompió o dejó de
--       dispararse. El umbral de 5 días es el mismo que ya usa Ajustes para
--       pintar el dispositivo como «callado» (ver shortcut-settings.tsx), para
--       que el aviso no contradiga a la pantalla.
--
-- El aviso sale UNA VEZ y calla mientras el problema dura: la marca por día en
-- `profile` con una ventana de reposo evita el machaque diario, igual que
-- `pending_notified_on` hace con el recordatorio de pagos sin asignar.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- La marca anti-repetición. Paralela a `pending_notified_on`, pero con una
-- diferencia clave: el recordatorio de pendientes SÍ quiere salir a diario
-- (una vez al día), mientras que este aviso NO debe repetirse cada día
-- mientras el Atajo siga roto. Por eso no basta «< hoy»: hace falta una
-- ventana de reposo de varios días, que aplica la función de abajo.
-- ---------------------------------------------------------------------------
alter table public.profile
  add column if not exists ingest_health_notified_on date;

comment on column public.profile.ingest_health_notified_on is
  'Último día (hora de Madrid) en que se avisó de un problema de salud de la ingesta. Con la ventana de reposo de claim_ingest_health_alerts, es lo que evita repetir el mismo aviso a diario mientras el Atajo siga fallando.';


-- ---------------------------------------------------------------------------
-- La señal de salud, por usuario, derivada de lo ya registrado.
--
-- security_invoker = true: consultada por un usuario desde la app, la RLS de
-- `ingest_dead_letter` e `ingest_device` la deja ver SOLO sus propias filas.
-- Consultada desde dentro de una función SECURITY DEFINER (la de abajo), se
-- ejecuta con los privilegios del dueño y ve a los cuatro, que es justo lo que
-- el reparto de avisos necesita. Mismo patrón que `budget_status`.
-- ---------------------------------------------------------------------------
create view public.v_ingest_health with (security_invoker = true) as
with
  -- (a) Rechazos recientes: descartes de la ingesta en las últimas 24 h.
  --     Se cuentan TODOS los motivos (importe ilegible, tarjeta desconocida,
  --     sin cuenta, límite de peticiones…): cualquiera de ellos es un envío
  --     que no entró y que el dueño querría revisar.
  rechazos as (
    select dl.user_id,
           count(*)::bigint as rejections_24h
    from public.ingest_dead_letter dl
    where dl.user_id is not null
      and dl.received_at >= now() - interval '24 hours'
    group by dl.user_id
  ),
  -- (b) Dispositivos mudos: activos alguna vez (request_count > 0) pero
  --     callados 5 días o más. El umbral vive aquí; cámbialo en un solo sitio.
  mudos as (
    select d.user_id,
           count(*)::bigint as mute_devices,
           max(floor(extract(epoch from (now() - d.last_used_at)) / 86400)::int)
             as max_mute_days
    from public.ingest_device d
    where d.revoked_at is null
      and d.request_count > 0
      and d.last_used_at is not null
      and d.last_used_at < now() - interval '5 days'
    group by d.user_id
  )
select
  coalesce(r.user_id, m.user_id)        as user_id,
  coalesce(r.rejections_24h, 0)         as rejections_24h,
  coalesce(m.mute_devices, 0)           as mute_devices,
  m.max_mute_days                       as max_mute_days,
  -- Umbral de rechazos: 3 en 24 h. Un rechazo suelto (un pago raro, una
  -- tarjeta recién estrenada) es ruido normal y no merece interrumpir.
  (coalesce(r.rejections_24h, 0) >= 3)  as many_rejections,
  -- La salud está mal si se cumple CUALQUIERA de las dos condiciones.
  (coalesce(r.rejections_24h, 0) >= 3
     or coalesce(m.mute_devices, 0) > 0) as unhealthy
from rechazos r
full outer join mudos m on m.user_id = r.user_id;

comment on view public.v_ingest_health is
  'Salud de la ingesta del Atajo por usuario, derivada de ingest_dead_letter e ingest_device. Aislada por RLS (security_invoker). unhealthy = rechazos>=3 en 24h O algún dispositivo mudo >=5 días.';


-- ---------------------------------------------------------------------------
-- Reclamar los avisos de salud, sin repetir. Igual que claim_pending_reminder
-- y claim_budget_alerts: marca ANTES de devolver, para que un envío que falla
-- pierda un aviso (recuperable) en vez de mandarlo en bucle.
--
--   · p_from_hour   — no avisa antes de esa hora de Madrid. Como el recordatorio,
--                     el aviso es de mañana; no se distingue la corrida diaria
--                     de las de cada 2 h en el endpoint, así que la cadencia la
--                     dan la hora y la marca, no el cron.
--   · p_cooldown_days — ventana de reposo. Un problema que persiste vuelve a
--                     avisar como mucho cada N días, no cada día.
--
-- SECURITY DEFINER + search_path vacío: solo la puede ejecutar service_role, y
-- ve a todos los usuarios a través de la vista para repartir cada aviso a su
-- dueño.
-- ---------------------------------------------------------------------------
create or replace function public.claim_ingest_health_alerts(
  p_from_hour     integer default 9,
  p_cooldown_days integer default 3
)
returns table (
  user_id        uuid,
  rejections_24h bigint,
  many_rejections boolean,
  mute_devices   bigint,
  max_mute_days  integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoy  date    := (now() at time zone 'Europe/Madrid')::date;
  v_hora integer := extract(hour from (now() at time zone 'Europe/Madrid'))::integer;
begin
  -- Antes de la hora acordada, calla. Después avisa aunque el cron llegue
  -- tarde: lo que impide repetir es la marca, no el reloj.
  if v_hora < p_from_hour then
    return;
  end if;

  return query
  with malos as (
    select h.user_id, h.rejections_24h, h.many_rejections,
           h.mute_devices, h.max_mute_days
    from public.v_ingest_health h
    where h.unhealthy
  ),
  -- Se marca a quien toca avisar (nunca avisado, o fuera de la ventana de
  -- reposo). El <= hace que un problema persistente re-avise exactamente cada
  -- p_cooldown_days días.
  marcados as (
    update public.profile p
       set ingest_health_notified_on = v_hoy
      from malos x
     where p.user_id = x.user_id
       and (p.ingest_health_notified_on is null
            or p.ingest_health_notified_on <= v_hoy - p_cooldown_days)
    returning p.user_id
  )
  select m.user_id, x.rejections_24h, x.many_rejections,
         x.mute_devices, x.max_mute_days
  from marcados m
  join malos x on x.user_id = m.user_id;
end $$;

revoke all on function public.claim_ingest_health_alerts(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_ingest_health_alerts(integer, integer) to service_role;

comment on function public.claim_ingest_health_alerts is
  'Los usuarios con la ingesta del Atajo en mal estado a los que toca avisar. Marca antes de devolver y respeta una ventana de reposo: repetir un aviso a diario molesta más que perder uno.';
