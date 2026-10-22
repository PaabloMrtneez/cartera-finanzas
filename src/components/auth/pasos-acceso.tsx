import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Los tres pasos de quien llega por invitación: contraseña, proteger la cuenta
 * (opcional) y listo. Va arriba de cada pantalla del recorrido para que se sepa cuánto
 * falta; quien entra a diario no lo ve nunca.
 *
 * El paso actual lleva el cian sólido del acento (es un estado activo); los
 * hechos, una marca sobre el tinte suave; los que faltan, la superficie neutra.
 */
// «Proteger»: el paso 2 es opcional (recomendado), y puede ser el código o Face ID.
export const PASOS_ACCESO = ["Contraseña", "Proteger", "Listo"] as const;

export function PasosAcceso({ actual }: { actual: 1 | 2 | 3 }) {
  return (
    <ol aria-label="Pasos para entrar en Cartera" className="flex items-center gap-2">
      {PASOS_ACCESO.map((nombre, i) => {
        const n = i + 1;
        const estado = n < actual ? "hecho" : n === actual ? "actual" : "pendiente";
        return (
          <li
            key={nombre}
            aria-current={estado === "actual" ? "step" : undefined}
            className={cn("flex items-center gap-2", i < PASOS_ACCESO.length - 1 && "flex-1")}
          >
            <span
              aria-hidden
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold tabular-nums",
                estado === "actual" && "bg-accent text-accent-ink",
                estado === "hecho" && "bg-accent-soft text-accent-text",
                estado === "pendiente" && "bg-surface-2 text-muted",
              )}
            >
              {estado === "hecho" ? <Check size={14} strokeWidth={2.5} /> : n}
            </span>
            <span
              className={cn(
                "text-[13px] leading-[18px] font-semibold whitespace-nowrap",
                estado === "actual" ? "text-fg" : "text-muted",
              )}
            >
              {nombre}
              <span className="sr-only">
                {estado === "hecho" ? " (hecho)" : estado === "actual" ? " (ahora)" : " (falta)"}
              </span>
            </span>
            {i < PASOS_ACCESO.length - 1 ? (
              <span aria-hidden className="h-px min-w-3 flex-1 bg-hairline" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
