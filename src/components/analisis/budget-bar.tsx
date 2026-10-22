import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { daysInMonth, parseIsoDate, todayIso } from "@/lib/dates";
import { formatCents, formatShare } from "@/lib/money";

export type BudgetStatus = {
  budget_id: string;
  category_id: string;
  name: string;
  color: string;
  icon: string;
  cap_cents: number;
  rollover_cents: number;
  effective_cap_cents: number;
  spent_cents: number;
  pct: number | null;
};

/**
 * Barra de consumo de un límite.
 *
 * Lleva dos marcas: lo gastado, y una gris que indica **el ritmo** — cuánto
 * llevarías gastado si el mes fuera lineal. Comparar las dos dice más que el
 * porcentaje suelto: al día 3 del mes, ir al 20 % del tope es ir muy caro.
 *
 * Lo que se pasa del tope se pinta rayado, para que se vea que es exceso y no
 * simplemente «barra llena».
 *
 * Material Aurora: mientras es camino, el relleno es el espectro iridiscente
 * (como el progreso de Metas); al 80 % pasa al aviso y al 100 % al gasto.
 */
export function BudgetBar({
  budget,
  month,
  compact = false,
}: {
  budget: BudgetStatus;
  /** Mes que se está mirando, para saber si el ritmo aplica. */
  month: string;
  compact?: boolean;
}) {
  const tope = budget.effective_cap_cents;
  const gastado = budget.spent_cents;
  const pct = tope > 0 ? (gastado / tope) * 100 : 0;
  const exceso = Math.max(0, gastado - tope);

  // El ritmo solo tiene sentido en el mes en curso: en un mes cerrado, la
  // referencia es el mes entero.
  const hoy = todayIso();
  const esMesActual = hoy.slice(0, 7) === month.slice(0, 7);
  const ritmo = esMesActual ? (parseIsoDate(hoy).day / daysInMonth(month)) * 100 : null;

  // Tres tramos, la semántica de siempre: hasta el 80 % es camino (el espectro
  // Aurora, como el progreso de una meta), del 80 % al tope es aviso, y pasado
  // el tope es gasto. El tono no viaja solo: a partir del aviso lleva icono.
  const tramo = pct >= 100 ? "pasado" : pct >= 80 ? "aviso" : "camino";
  const tono = tramo === "pasado" ? "text-expense" : tramo === "aviso" ? "text-warning" : "text-fg";
  const relleno =
    tramo === "pasado"
      ? "var(--expense)"
      : tramo === "aviso"
        ? "var(--warning)"
        : "var(--grad-aurora)";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span
          className="flex size-[30px] shrink-0 items-center justify-center rounded-full"
          style={{
            background: `color-mix(in srgb, ${budget.color} 16%, transparent)`,
            color: budget.color,
          }}
        >
          <Icon name={budget.icon} size={16} />
        </span>

        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{budget.name}</span>

        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 cifra text-[19px] leading-6 font-medium",
            tono,
          )}
        >
          {tramo !== "camino" ? <Icon name="triangle-alert" size={14} /> : null}
          {formatShare(pct)}
        </span>
      </div>

      {/*
        La barra. La marca de ritmo va FUERA del carril (que recorta), para que
        sobresalga por arriba y por abajo y se lea como una muesca, no como una
        raya más dentro del relleno.
      */}
      <div className="relative">
        <div className="relative h-[10px] overflow-hidden rounded-full bg-surface-2">
          <div
            className="absolute inset-y-0 left-0 origin-left animate-bar-fill rounded-full"
            style={{ width: `${Math.min(100, pct)}%`, background: relleno }}
          >
            {/* El barniz de la banda Aurora: brillo arriba, volumen. */}
            <span
              className="pointer-events-none absolute inset-0 rounded-full [background:linear-gradient(180deg,rgba(255,255,255,0.3),transparent_60%)] [mix-blend-mode:screen]"
              aria-hidden
            />
          </div>

          {/* Lo que se pasa del tope, rayado: exceso, no «barra llena». */}
          {exceso > 0 ? (
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  "repeating-linear-gradient(135deg, rgba(255,255,255,0.45) 0 3px, transparent 3px 6px)",
              }}
            />
          ) : null}
        </div>

        {/* Marca de ritmo: dónde deberías ir a estas alturas del mes. */}
        {ritmo !== null && ritmo < 100 ? (
          <span
            className="absolute -top-[4px] -bottom-[4px] w-[2px] -translate-x-1/2 rounded-full bg-fg opacity-55"
            style={{ left: `${ritmo}%` }}
            aria-hidden
          />
        ) : null}
      </div>

      {!compact ? (
        <p className="text-[13px] leading-[18px] text-muted tabular-nums">
          {formatCents(gastado)} de {formatCents(tope)}
          {budget.rollover_cents > 0
            ? ` · incluye ${formatCents(budget.rollover_cents)} arrastrados`
            : ""}
          {exceso > 0 ? ` · ${formatCents(exceso)} de más` : ""}
          {ritmo !== null && exceso === 0 && pct > ritmo
            ? " · vas por delante del ritmo del mes"
            : ""}
        </p>
      ) : null}
    </div>
  );
}
