-- ===========================================================================
-- Metas de ahorro: un objetivo con nombre, importe y (opcional) fecha, ligado a
-- una cuenta de ahorro.
--
-- Modelo elegido: el PROGRESO es el saldo real de la cuenta. No se almacena
-- nada de progreso (invariante «los saldos no se guardan, se derivan de los
-- movimientos»): sale de v_account_balance, igual que el saldo que ves en
-- Cuentas. Así la meta nunca miente ni se desincroniza: lo que hay en la cuenta
-- ES lo ahorrado.
--
-- De ahí una consecuencia del modelo, que la tabla impone: UNA meta por cuenta.
-- Dos metas sobre la misma cuenta se disputarían el mismo dinero.
-- ===========================================================================

create table public.savings_goal (
  id           uuid not null default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  target_cents bigint not null,
  account_id   uuid not null,
  -- Opcional: sin fecha es una meta sin prisa; con fecha, la pantalla calcula el
  -- ritmo que hace falta para llegar.
  deadline     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  primary key (id),
  unique (user_id, id),
  -- Una meta por cuenta: el corazón del modelo «progreso = saldo».
  unique (user_id, account_id),

  constraint goal_name_len        check (length(btrim(name)) between 1 and 60),
  constraint goal_target_positive check (target_cents > 0),

  -- Clave foránea COMPUESTA con user_id (invariante 5): la RLS no protege las
  -- FK, así que sin esto un usuario podría apuntar una meta a la cuenta de otro.
  foreign key (user_id, account_id)
    references public.account (user_id, id) on delete cascade
);

-- updated_at automático, con el mismo disparador compartido que el resto.
create trigger savings_goal_touch before update on public.savings_goal
  for each row execute function private.tg_touch_updated_at();


-- ---------------------------------------------------------------------------
-- Seguridad a nivel de fila: las cuatro políticas, igual que las demás tablas
-- del usuario. La meta SÍ se puede borrar desde el cliente (a diferencia de las
-- cuentas, que se archivan): por eso conserva su política de borrado.
-- ---------------------------------------------------------------------------
alter table public.savings_goal enable row level security;
alter table public.savings_goal force row level security;
revoke all on table public.savings_goal from anon;

create policy savings_goal_sel on public.savings_goal for select to authenticated
  using (user_id = (select private.current_user_id()));
create policy savings_goal_ins on public.savings_goal for insert to authenticated
  with check (user_id = (select private.current_user_id()));
create policy savings_goal_upd on public.savings_goal for update to authenticated
  using (user_id = (select private.current_user_id()))
  with check (user_id = (select private.current_user_id()));
create policy savings_goal_del on public.savings_goal for delete to authenticated
  using (user_id = (select private.current_user_id()));

-- Reasignar una fila a otro usuario no es nunca legítimo (además del WITH CHECK).
revoke update (user_id) on public.savings_goal from authenticated;


-- ---------------------------------------------------------------------------
-- El progreso, DERIVADO. Une la meta con el saldo de su cuenta (v_account_balance,
-- que ya trae los tres invariantes económicos) y calcula lo que falta y el %.
-- El porcentaje es un ratio, no dinero: numeric está bien, como en budget_status.
-- security_invoker: la RLS de savings_goal y de las vistas de saldo mandan.
-- ---------------------------------------------------------------------------
create view public.v_savings_goal_progress with (security_invoker = true) as
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
       coalesce(b.balance_cents, 0)                               as saved_cents,
       greatest(0, g.target_cents - coalesce(b.balance_cents, 0)) as remaining_cents,
       case when g.target_cents > 0
              then round(100.0 * coalesce(b.balance_cents, 0) / g.target_cents, 1)
            else 0
       end                                                        as pct,
       (coalesce(b.balance_cents, 0) >= g.target_cents)           as reached
from public.savings_goal g
join public.account a
  on a.user_id = g.user_id and a.id = g.account_id
left join public.v_account_balance b
  on b.user_id = g.user_id and b.account_id = g.account_id;

comment on view public.v_savings_goal_progress is
  'Progreso de cada meta = saldo de su cuenta (derivado de v_account_balance) contra el objetivo. Nada se almacena.';
