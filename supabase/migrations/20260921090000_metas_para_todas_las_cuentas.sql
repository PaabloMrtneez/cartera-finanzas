-- ===========================================================================
-- Metas para TODAS las cuentas, con el progreso correcto según el tipo.
--
-- Antes una meta solo podía apoyarse en una cuenta de AHORRO y su progreso era
-- el saldo (v_account_balance). Pero hay quien ahorra en su cuenta principal, en
-- efectivo, o cuyo objetivo es «tener 1.000 € invertidos»: la meta debe valer
-- para cualquier cuenta activa.
--
-- El problema: para una cuenta de INVERSION el saldo contable NO es lo que la
-- persona considera «ahorrado». Su saldo solo cuenta el dinero que entró; el
-- valor real es el de sus posiciones (revalorizadas) más la caja que aún no ha
-- desplegado. Es exactamente lo que aporta esa cuenta al patrimonio neto en
-- v_net_worth. Para el resto de cuentas (BANCO/EFECTIVO/AHORRO) el progreso
-- sigue siendo su saldo derivado.
--
-- Nada se almacena (invariante «los saldos y el valor se derivan de los
-- movimientos y las posiciones»): todo sale de las vistas de inversión que ya
-- existen (v_account_balance, v_position_value, v_position_contributions).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Valor de cada cuenta a efectos de progreso de meta.
--
--   · Cuenta de dinero (no INVERSION): su saldo, tal cual (v_account_balance).
--   · Cuenta de INVERSION: la misma fórmula con la que v_net_worth cuenta esa
--     cuenta, para que no haya dos verdades:
--
--         saldo contable
--         − lo aportado a sus posiciones   (caja que ya pasó a posiciones)
--         + valor de mercado de esas posiciones (solo las activas)
--
--     Los dos primeros dejan la CAJA SIN DESPLEGAR de la cuenta; el tercero
--     suma el VALOR INVERTIDO. Restar lo aportado antes de sumar el valor es lo
--     que evita contar dos veces el dinero que entró y de ahí pasó a una
--     posición —el mismo razonamiento que en v_net_worth—.
--
-- security_invoker: la RLS de las tablas y vistas de base manda; esta vista no
-- ve nada que el usuario no vea.
-- ---------------------------------------------------------------------------
create view public.v_account_worth with (security_invoker = true) as
with invertido as (
  -- Valor de mercado de las posiciones ACTIVAS de cada cuenta de inversión.
  select v.user_id,
         v.account_id,
         coalesce(sum(v.value_cents), 0)::bigint as cents
  from public.v_position_value v
  where not v.archived
  group by v.user_id, v.account_id
),
aportado as (
  -- Lo aportado a las posiciones de cada cuenta (para descontarlo del saldo).
  select p.user_id,
         p.account_id,
         coalesce(sum(c.contributed_cents), 0)::bigint as cents
  from public.v_position_contributions c
  join public.investment_position p
    on p.id = c.position_id and p.user_id = c.user_id
  group by p.user_id, p.account_id
)
select b.user_id,
       b.account_id,
       b.type,
       b.balance_cents,
       case
         when b.type = 'INVERSION'
           then b.balance_cents - coalesce(ap.cents, 0) + coalesce(iv.cents, 0)
         else b.balance_cents
       end as worth_cents
from public.v_account_balance b
left join invertido iv on iv.user_id = b.user_id and iv.account_id = b.account_id
left join aportado ap on ap.user_id = b.user_id and ap.account_id = b.account_id;

comment on view public.v_account_worth is
  'Valor de cada cuenta a efectos de progreso de meta: saldo para las cuentas de dinero; caja sin desplegar + valor de posiciones para las de inversion (misma formula que v_net_worth). Nada se almacena.';


-- ---------------------------------------------------------------------------
-- El progreso de la meta pasa a leer v_account_worth en vez del saldo a pelo.
-- Mismas columnas, mismos tipos, mismo orden: solo cambia de dónde sale el
-- número de progreso. Para una cuenta de dinero es idéntico que antes (worth =
-- saldo); para una de inversión ya mide el valor invertido.
-- ---------------------------------------------------------------------------
create or replace view public.v_savings_goal_progress with (security_invoker = true) as
select g.user_id,
       g.id,
       g.name,
       g.target_cents,
       g.account_id,
       g.deadline,
       g.created_at,
       a.name    as account_name,
       a.color   as account_color,
       a.archived as account_archived,
       coalesce(w.worth_cents, 0)                               as saved_cents,
       greatest(0, g.target_cents - coalesce(w.worth_cents, 0)) as remaining_cents,
       case when g.target_cents > 0
              then round(100.0 * coalesce(w.worth_cents, 0) / g.target_cents, 1)
            else 0
       end                                                      as pct,
       (coalesce(w.worth_cents, 0) >= g.target_cents)           as reached
from public.savings_goal g
join public.account a
  on a.user_id = g.user_id and a.id = g.account_id
left join public.v_account_worth w
  on w.user_id = g.user_id and w.account_id = g.account_id;

comment on view public.v_savings_goal_progress is
  'Progreso de cada meta = valor de su cuenta (v_account_worth: saldo para dinero, caja + valor de posiciones para inversion) contra el objetivo. Nada se almacena.';
