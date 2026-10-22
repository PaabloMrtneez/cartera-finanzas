"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { monthLabel, shiftMonth } from "@/lib/dates";

/**
 * Navegador de mes. El mes vive en la dirección, como especifica el prototipo,
 * así que el botón de atrás del navegador recupera el mes anterior y un enlace
 * compartido abre el mismo periodo.
 */
export function MonthNav({
  month,
  all,
  max,
  permiteTodo,
}: {
  month: string;
  all: boolean;
  /**
   * Último mes al que se puede avanzar. Resumen lo fija en el mes en curso:
   * enseñar el ritmo de un mes que no ha ocurrido decía «0,00 € en 30 días»,
   * que no significa nada. Movimientos no lo fija, porque ahí sí tiene sentido
   * ir a un mes futuro: un movimiento puede estar fechado por delante.
   */
  max?: string;
  /**
   * Si se puede quitar el filtro de mes y ver todo. Resumen dice que no: su
   * contenido es mensual de arriba abajo —gasto del mes, ritmo del mes, reparto
   * del mes—, y el botón cambiaba la dirección sin cambiar nada en pantalla.
   */
  permiteTodo?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const enElTope = max !== undefined && month >= max;

  function go(next: string | null) {
    const query = new URLSearchParams(params.toString());
    if (next === null) query.set("mes", "todo");
    else query.set("mes", next);
    router.push(`${pathname}?${query}`, { scroll: false });
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => go(shiftMonth(month, -1))}
          aria-label="Mes anterior"
          disabled={all}
          className="pulsable toque relative flex size-9 items-center justify-center rounded-sm text-muted disabled:opacity-40"
        >
          <Icon name="chevron-left" size={18} />
        </button>

        {/* Anuncia el mes nuevo al pasar con las flechas: el botón no cambia de
            nombre, y sin esto el lector de pantalla no diría adónde has ido. */}
        <span
          aria-live="polite"
          className={cn(
            "min-w-28 text-center text-[15px] font-semibold capitalize",
            all && "text-muted",
          )}
        >
          {all ? "Todo" : monthLabel(month)}
        </span>

        <button
          type="button"
          onClick={() => go(shiftMonth(month, 1))}
          aria-label="Mes siguiente"
          disabled={all || enElTope}
          className="pulsable toque relative flex size-9 items-center justify-center rounded-sm text-muted disabled:opacity-40"
        >
          <Icon name="chevron-right" size={18} />
        </button>
      </div>

      {permiteTodo === false ? null : (
        <button
          type="button"
          onClick={() => go(all ? month : null)}
          className={cn(
            "pulsable toque relative h-9 rounded-sm px-3 text-[13px] font-semibold",
            "transition-[opacity,color,background-color] duration-150 ease-ui",
            all ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-muted",
          )}
        >
          {all ? "Ver un mes" : "Todo"}
        </button>
      )}
    </div>
  );
}
