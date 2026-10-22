"use client";

import { useState, useTransition } from "react";
import { generateRecurringIncome } from "@/app/(app)/fijos/acciones-ingresos";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { llamarAccion } from "@/lib/llamar-accion";

/**
 * Crea los movimientos de los ingresos fijos cuya fecha ya tocaba.
 *
 * Es seguro pulsarlo tantas veces como se quiera: el índice único por ingreso
 * recurrente y fecha impide duplicar, así que un doble clic no ingresa dos veces.
 */
export function GenerateIncomeButton({ pendientes }: { pendientes: number }) {
  const [pending, startTransition] = useTransition();
  // Tres desenlaces, no uno: antes un ERROR se pintaba con el check verde y
  // «Ya están en Movimientos», como si hubiera salido bien.
  const [resultado, setResultado] = useState<
    { tipo: "creados" | "nada" | "error"; texto: string } | null
  >(null);
  const fallo = resultado?.tipo === "error";

  if (pendientes === 0 && resultado === null) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg p-4",
        resultado ? "bg-surface" : "bg-accent-soft",
      )}
      // El desenlace se anuncia: el botón desaparece y el foco se quedaría
      // sin saber qué pasó.
      aria-live="polite"
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-full",
          !resultado
            ? "bg-accent text-accent-ink"
            : fallo
              ? "bg-surface-2 text-expense"
              : "bg-surface-2 text-income",
        )}
      >
        <Icon
          name={!resultado ? "calendar-range" : fallo ? "triangle-alert" : "check"}
          size={20}
        />
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] font-semibold">
          {resultado?.texto ??
            `${pendientes} ${pendientes === 1 ? "ingreso pendiente" : "ingresos pendientes"} de generar`}
        </span>
        <span className="text-[13px] leading-[18px] text-muted">
          {resultado?.tipo === "creados"
            ? "Ya están en Movimientos, con su categoría."
            : resultado?.tipo === "nada"
              ? "Todo lo que tocaba ya estaba generado."
              : fallo
                ? "No se ha generado nada. Vuelve a intentarlo en un momento."
                : "Ingresos fijos cuya fecha ya ha pasado."}
        </span>
      </span>

      {resultado === null || fallo ? (
        <Button
          size="compact"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await llamarAccion(() => generateRecurringIncome(), "generado");
              setResultado(
                !r.ok
                  ? { tipo: "error", texto: r.error }
                  : r.created === 0
                    ? { tipo: "nada", texto: "No había nada que generar" }
                    : {
                        tipo: "creados",
                        texto: `${r.created} ${r.created === 1 ? "movimiento creado" : "movimientos creados"}`,
                      },
              );
            })
          }
        >
          {pending ? "Generando…" : fallo ? "Reintentar" : "Generar"}
        </Button>
      ) : null}
    </div>
  );
}
