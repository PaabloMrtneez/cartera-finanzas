"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { monthLabel } from "@/lib/dates";
import { formatCents, formatPercent, percentChange } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";
import { mensajeErrorLectura } from "@/lib/llamar-accion";

export type MesCerrado = {
  period_month: string;
  income_cents: number;
  net_expense_cents: number;
  month_balance_cents: number;
  gross_expense_cents: number | null;
  reimbursed_cents: number | null;
};

type Cambio = {
  category_id: string | null;
  name: string;
  color: string;
  icon: string;
  current_cents: number;
  previous_cents: number;
  delta_cents: number;
};

/**
 * El cuerpo del cierre de mes: el diálogo de Radix, el navegador entre meses y
 * las consultas a Supabase (`month_changes`, `mark_month_seen`).
 *
 * Se carga con `next/dynamic` desde `month-close` la primera vez que se abre, de
 * modo que ni Radix ni `@supabase/supabase-js` entran en el paquete inicial de
 * Análisis. El estado de apertura lo gobierna el armazón ligero.
 */
export default function MonthCloseContent({
  months,
  open,
  onOpenChange,
}: {
  months: MesCerrado[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [indice, setIndice] = useState(0);
  // Los cambios se guardan junto al índice del mes al que pertenecen. Así el
  // cuerpo deriva en el render si lo que tiene es del mes que se está viendo, y
  // no hace falta ponerlos a null dentro del efecto (que forzaría un render de
  // más y es justo lo que el lint desaconseja).
  const [cambios, setCambios] = useState<{
    indice: number;
    filas: Cambio[];
    fallo: string | null;
  } | null>(null);

  const mes = months[indice];
  const filas = cambios && cambios.indice === indice ? cambios.filas : null;
  const fallo = cambios && cambios.indice === indice ? cambios.fallo : null;
  const mayorCambio = Math.max(1, ...(filas ?? []).map((f) => Math.abs(f.delta_cents)));

  // La carga va en el efecto; el estado que se pinta se deriva arriba, no se
  // escribe aquí de forma síncrona. El armazón monta este cuerpo ya abierto la
  // primera vez, con lo que la carga inicial (mes 0) entra por este mismo
  // camino.
  useEffect(() => {
    if (!open) return;
    const objetivo = months[indice];
    if (!objetivo) return;

    let vivo = true;
    const supabase = createClient();
    void supabase
      .rpc("month_changes", { p_month: objetivo.period_month })
      .then(({ data, error }) => {
        if (!vivo) return;
        setCambios({
          indice,
          filas: data ?? [],
          fallo: error ? mensajeErrorLectura(error, "los cambios del mes") : null,
        });
      });
    // Se anota que ya se ha visto, para no volver a insistir con este mes.
    void supabase.rpc("mark_month_seen", { p_month: objetivo.period_month });

    return () => {
      vivo = false;
    };
  }, [open, indice, months]);

  // Al cerrar se vuelve al mes más reciente, para que la próxima apertura
  // empiece como la primera. Es un cambio de estado en un evento, no en un
  // efecto.
  function alCambiarApertura(siguiente: boolean) {
    onOpenChange(siguiente);
    if (!siguiente) setIndice(0);
  }

  return (
    <Dialog open={open} onOpenChange={alCambiarApertura}>
      <DialogContent
        size="cierre"
        title={mes ? `${capitalizar(monthLabel(mes.period_month))}, cerrado` : "Cierre de mes"}
        description="Un mes terminado ya no cambia: sus cifras son definitivas."
      >
        {!mes ? null : (
          <div className="flex flex-col gap-4">
            {/* Navegador entre meses cerrados. Como en `MonthNav`: a la izquierda
                el mes anterior y a la derecha el siguiente (estaban al revés).
                La lista va del más reciente (índice 0) al más antiguo. */}
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Mes anterior"
                disabled={indice >= months.length - 1}
                onClick={() => setIndice(indice + 1)}
              >
                <Icon name="chevron-left" size={18} />
              </Button>
              <span aria-live="polite" className="flex-1 text-center text-[15px] font-semibold capitalize">
                {monthLabel(mes.period_month)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Mes siguiente"
                disabled={indice === 0}
                onClick={() => setIndice(indice - 1)}
              >
                <Icon name="chevron-right" size={18} />
              </Button>
            </div>

            {/* Las cuatro cifras del mes: una rejilla cerrada con filetes, sin
                cajas sueltas. Son las lecturas del mes, en la de display. */}
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md hair border-hairline bg-hairline">
              {[
                { etiqueta: "Gasto neto", valor: formatCents(mes.net_expense_cents) },
                { etiqueta: "Ingresos", valor: formatCents(mes.income_cents), tono: "text-income" },
                {
                  etiqueta: "Devuelto",
                  valor: formatCents(mes.reimbursed_cents ?? 0),
                },
                {
                  etiqueta: "Balance",
                  valor: `${mes.month_balance_cents >= 0 ? "+" : ""}${formatCents(mes.month_balance_cents)}`,
                  tono: mes.month_balance_cents < 0 ? "text-expense" : undefined,
                },
              ].map((kpi) => (
                <div key={kpi.etiqueta} className="flex flex-col gap-1 bg-surface p-3 lg:p-4">
                  <span className="text-[13px] leading-[18px] text-muted">{kpi.etiqueta}</span>
                  <span className={cn("cifra text-[24px] leading-[30px] font-medium", kpi.tono)}>
                    {kpi.valor}
                  </span>
                </div>
              ))}
            </div>

            {/* Lo que más cambió respecto al mes anterior. */}
            <div className="flex flex-col gap-2">
              <p className="text-[13px] leading-[18px] font-semibold tracking-[0.03em] text-muted uppercase">
                Lo que más cambió
              </p>

              {filas === null ? (
                <div className="h-32 esqueleto rounded-md" />
              ) : fallo ? (
                <p role="status" className="py-4 text-[15px] text-muted">
                  {fallo}
                </p>
              ) : filas.length === 0 ? (
                <p className="py-4 text-[15px] text-muted">
                  Nada cambió de forma apreciable respecto al mes anterior.
                </p>
              ) : (
                <ul>
                  {filas.map((cambio) => {
                    const subio = cambio.delta_cents > 0;
                    const pct = percentChange(cambio.current_cents, cambio.previous_cents);
                    // Cuánto pesa este cambio frente al mayor de la lista: la
                    // barra fina bajo el nombre lo dice sin leer cifras.
                    const peso = Math.abs(cambio.delta_cents) / mayorCambio;

                    return (
                      <li
                        key={cambio.category_id ?? "sin"}
                        className="flex min-h-12 items-center gap-3 hair-t border-separator py-2.5"
                      >
                        <span
                          className="flex size-[30px] shrink-0 items-center justify-center rounded-full"
                          style={{
                            background: `color-mix(in srgb, ${cambio.color} 16%, transparent)`,
                            color: cambio.color,
                          }}
                        >
                          <Icon name={cambio.icon} size={16} />
                        </span>

                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[15px] font-semibold">{cambio.name}</span>
                          <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                            {formatCents(cambio.previous_cents)} →{" "}
                            {formatCents(cambio.current_cents)}
                          </span>
                          <span
                            className="mt-1.5 h-[4px] origin-left animate-bar-fill rounded-full"
                            style={{
                              width: `${Math.max(4, peso * 100)}%`,
                              background: subio ? "var(--expense)" : "var(--income)",
                            }}
                            aria-hidden
                          />
                        </span>

                        <span
                          className={cn(
                            "shrink-0 text-right text-[15px] font-semibold tabular-nums",
                            subio ? "text-expense" : "text-income",
                          )}
                        >
                          {subio ? "+" : "−"}
                          {formatCents(Math.abs(cambio.delta_cents))}
                          {pct !== null ? (
                            <span className="block text-[13px] font-medium text-muted">
                              {formatPercent(pct, 0)}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function capitalizar(texto: string) {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}
