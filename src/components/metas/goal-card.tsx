import { GoalDialog } from "./goal-dialog";
import { ProyeccionMeta, type Proyeccion, type ValorMes } from "./proyeccion-meta";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { todayIso } from "@/lib/dates";
import { cn } from "@/lib/cn";
import { formatCents, formatShare } from "@/lib/money";
import type { Account, Database } from "@/lib/supabase/database.types";

type MetaProgreso = Database["public"]["Views"]["v_savings_goal_progress"]["Row"];

const MES_ANIO = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** Días de hoy (Madrid) a la fecha límite; negativo si ya pasó. */
function diasHasta(deadline: string): number {
  const hoy = new Date(`${todayIso()}T00:00:00Z`).getTime();
  const fin = new Date(`${deadline}T00:00:00Z`).getTime();
  return Math.round((fin - hoy) / 86_400_000);
}

/**
 * Una meta de ahorro: barra de progreso (progreso = saldo real de su cuenta) y,
 * si tiene fecha, el ritmo que hace falta para llegar.
 *
 * La barra es prima de la de límites, pero con el signo cambiado: pasar del
 * 100 % en un límite es malo (rojo), aquí es la meta cumplida (verde `income`).
 *
 * El progreso en curso se llena con el GRADIENTE Aurora —la firma iridiscente—,
 * no con el color suelto de la cuenta: así una meta se lee como «camino hacia» y
 * no como otro bloque de color más. Al alcanzarla, la barra pasa al verde de
 * ingreso, que es el premio. El color de la cuenta se queda en el medallón del
 * icono, que es donde identifica de dónde sale el dinero.
 */
export function GoalCard({
  meta,
  accounts,
  proyeccion,
  historia = [],
}: {
  meta: MetaProgreso;
  accounts: Account[];
  /** Hacia dónde va, al ritmo de los últimos meses (`savings_goal_projection`). */
  proyeccion?: Proyeccion;
  /** Lo que valía la cuenta al cierre de cada mes, para el trazo del pasado. */
  historia?: ValorMes[];
}) {
  const relleno = Math.max(0, Math.min(100, meta.pct));
  const reached = meta.reached;

  // El ritmo: solo con fecha por delante y sin haber llegado aún.
  let ritmo: string | null = null;
  if (!reached && meta.deadline) {
    const dias = diasHasta(meta.deadline);
    if (dias <= 0) {
      ritmo = `la fecha ya pasó`;
    } else {
      const porMes = Math.round(meta.remaining_cents / (dias / 30.44));
      ritmo = `~${formatCents(porMes)}/mes para ${MES_ANIO.format(new Date(`${meta.deadline}T00:00:00Z`))}`;
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4 lg:p-5">
      <div className="flex items-center gap-3">
        <span
          className="flex size-[34px] shrink-0 items-center justify-center rounded-full"
          style={{
            background: `color-mix(in srgb, ${meta.account_color} 16%, transparent)`,
            color: meta.account_color,
          }}
        >
          <Icon name={reached ? "check" : "piggy-bank"} size={18} />
        </span>

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[17px] leading-[22px] font-semibold lg:text-[16px]">
            {meta.name}
          </span>
          <span className="truncate text-[13px] leading-[18px] text-muted">
            {meta.account_name}
            {meta.account_archived ? " · archivada" : ""}
          </span>
        </span>

        <span
          className={cn(
            "shrink-0 text-[17px] font-semibold tabular-nums lg:text-[16px]",
            reached ? "text-income" : "text-fg",
          )}
        >
          {/* Nunca un % negativo: una cuenta de ahorro no debería estar en rojo,
              pero si lo estuviera, «0 %» dice la verdad sin parecer roto. */}
          {formatShare(Math.max(0, meta.pct))}
        </span>

        <GoalDialog
          goal={{
            id: meta.id,
            name: meta.name,
            target_cents: meta.target_cents,
            account_id: meta.account_id,
            deadline: meta.deadline,
          }}
          accounts={accounts}
          trigger={
            <Button variant="ghost" size="icon" aria-label={`Editar ${meta.name}`}>
              <Icon name="pencil" size={18} />
            </Button>
          }
        />
      </div>

      <div className="relative h-[18px] overflow-hidden rounded-full bg-surface-2">
        <div
          className="absolute inset-y-0 left-0 origin-left animate-bar-fill rounded-full"
          style={{
            width: `${relleno}%`,
            background: reached ? "var(--income)" : "var(--grad-aurora)",
          }}
        >
          {/* El barniz de arriba le da el mismo volumen que a los segmentos de la
              banda Aurora, para que la barra pertenezca a la misma familia. */}
          <span
            className="pointer-events-none absolute inset-0 rounded-full [background:linear-gradient(180deg,rgba(255,255,255,0.28),transparent_55%)] [mix-blend-mode:screen]"
            aria-hidden
          />
        </div>
      </div>

      <p className="text-[13px] leading-[18px] text-muted tabular-nums">
        {reached ? (
          <>¡Meta alcanzada! Tienes {formatCents(meta.saved_cents)} en {meta.account_name}.</>
        ) : (
          <>
            {formatCents(meta.saved_cents)} de {formatCents(meta.target_cents)} · te faltan{" "}
            {formatCents(meta.remaining_cents)}
            {ritmo ? ` · ${ritmo}` : ""}
          </>
        )}
      </p>

      {/* Hacia la meta: solo mientras no se ha alcanzado. */}
      {!reached && proyeccion ? (
        <div className="hair-t border-separator pt-3">
          <ProyeccionMeta historia={historia} proyeccion={proyeccion} hoy={todayIso()} />
        </div>
      ) : null}
    </Card>
  );
}
