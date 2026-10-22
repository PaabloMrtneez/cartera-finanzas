"use client";

import { useState, useTransition } from "react";
import { saveValuation } from "@/app/(app)/inversiones/actions";
import { BotonSigno, alternarSigno } from "@/components/ui/boton-signo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { monthEnd, shortDate, todayIso } from "@/lib/dates";
import {
  formatCents,
  formatCentsPlain,
  formatSignedDelta,
  parseAmountToCents,
} from "@/lib/money";
import { applyPercent, parsePercent, type BaseValoracion } from "@/lib/valoracion";
import { llamarAccion } from "@/lib/llamar-accion";

type Modo = "valor" | "porcentaje";

/**
 * El cuerpo de la valoración: el diálogo de Radix y el formulario.
 *
 * Se carga con `next/dynamic` desde `valuation-dialog` la primera vez que se
 * abre, de modo que Radix no entra en el paquete inicial de Inversiones. El
 * estado de apertura lo gobierna el armazón ligero.
 *
 * Se puede meter de dos formas, porque a veces el bróker te da el valor y a
 * veces solo el porcentaje: por valor absoluto, o por el porcentaje que ha
 * variado. Pero solo se GUARDA el valor en céntimos — los porcentajes se
 * derivan siempre de las valoraciones, nunca al revés. Si se guardaran las dos
 * cosas, podrían acabar contradiciéndose.
 *
 * La base de un porcentaje es lo que de verdad hay invertido: la valoración
 * del cierre anterior MÁS lo aportado desde entonces, al coste (el criterio de
 * v_position_value). Así un «+5 %» es lo que ha rendido TU dinero, y meter
 * dinero no cuenta como rendimiento.
 *
 * El cálculo es en enteros (lib/valoracion.ts) y lo hace el SERVIDOR al
 * guardar; aquí solo se enseña la vista previa con las mismas funciones, así
 * que la cifra que se ve es la que se guarda.
 */
export default function ValuationDialogContent({
  positionId,
  positionName,
  base: baseRecibida,
  respaldo,
  open,
  onOpenChange,
}: {
  positionId: string;
  positionName: string;
  /** Sigue la cotización de un instrumento: esto es un respaldo (ver ValuationDialog). */
  respaldo?: { ultimoPrecio: string | null };
  /** Sobre qué se aplica un porcentaje; null sin valoración de un mes anterior. */
  base: BaseValoracion | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // En un respaldo solo se mete el valor: un porcentaje sobre la valoración del
  // mes anterior no significa nada en algo que se valora cada día solo.
  const base = respaldo ? null : baseRecibida;
  const [modo, setModo] = useState<Modo>("valor");
  const [valor, setValor] = useState("");
  const [porcentaje, setPorcentaje] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pct = parsePercent(porcentaje);
  const valorCalculado =
    modo === "porcentaje" && base !== null && pct !== null ? applyPercent(base.base, pct) : null;

  const valorFinal = modo === "valor" ? parseAmountToCents(valor) : valorCalculado;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Sin valoración previa no hay sobre qué aplicar un porcentaje: la base
    // sería 0 y se guardaba una valoración de 0 € sin avisar.
    if (modo === "porcentaje" && base === null) {
      setError("Sin una valoración de un mes anterior no se puede usar el porcentaje. Mete el valor.");
      return;
    }

    if (modo === "porcentaje" && pct === null) {
      setError("Escribe un porcentaje válido, por ejemplo 5,2.");
      return;
    }

    if (valorFinal === null || valorFinal < 0) {
      setError(
        modo === "porcentaje" ? "Con ese porcentaje el valor saldría negativo." : "Escribe un valor válido.",
      );
      return;
    }

    const formData = new FormData(event.currentTarget);
    formData.set("modo", modo);
    if (modo === "porcentaje" && base !== null) {
      // Viaja el porcentaje TAL CUAL se escribió y la base que se ha enseñado:
      // el valor lo recalcula el servidor, y si su base no coincide, no guarda.
      formData.set("pct", porcentaje);
      formData.set("base_cents", String(base.base));
    } else {
      formData.set("value", formatCentsPlain(valorFinal));
    }

    startTransition(async () => {
      const result = await llamarAccion(() => saveValuation(formData));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      setValor("");
      setPorcentaje("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="valoracion"
        title={respaldo ? `Valoración a mano · ${positionName}` : `Valorar ${positionName}`}
        description={
          respaldo
            ? "Para cuando el precio no llega. Solo se guarda el valor."
            : "Se valora una vez al mes, a cierre. Solo se guarda el valor: el porcentaje se calcula solo."
        }
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <input type="hidden" name="position_id" value={positionId} />

          {respaldo ? (
            <p className="flex items-start gap-2 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted">
              <span className="mt-[1px] shrink-0 text-accent-text">
                <Icon name="refresh-cw" size={15} />
              </span>
              <span>
                Esta posición sigue la cotización de Yahoo
                {respaldo.ultimoPrecio ? ` (último precio: ${respaldo.ultimoPrecio})` : ""}. Lo
                que metas aquí <span className="font-semibold text-fg">manda hasta que llegue un
                precio de esa fecha o posterior</span>; entonces vuelve a valer participaciones
                × precio, sin que hagas nada.
              </span>
            </p>
          ) : null}

          {respaldo ? null : (
            <Segmented
              label="Cómo quieres meterlo"
              value={modo}
              onChange={setModo}
              options={[
                { value: "valor", label: "Meto el valor" },
                { value: "porcentaje", label: "Meto el %" },
              ]}
            />
          )}

          {modo === "valor" ? (
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="valor">Cuánto vale ahora</Label>
              <Input
                id="valor"
                inputMode="decimal"
                required
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                placeholder="1.234,56"
                className="text-right tabular-nums"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="porcentaje">Cuánto ha variado</Label>
              <div className="flex items-center gap-2">
                <BotonSigno onClick={() => setPorcentaje(alternarSigno)} />
                <Input
                  id="porcentaje"
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  value={porcentaje}
                  onChange={(e) => setPorcentaje(e.target.value)}
                  placeholder="5,2"
                  className="text-right tabular-nums"
                />
                <span className="text-[17px] font-semibold text-muted">%</span>
              </div>
              {base === null ? (
                <p className="text-[13px] leading-[18px] text-warning">
                  Esta posición no tiene ninguna valoración de un mes anterior, así que no hay
                  sobre qué aplicar el porcentaje. Mete el valor.
                </p>
              ) : null}
            </div>
          )}

          {/* Se enseña siempre la cuenta completa, para que nadie tenga que fiarse. */}
          {base !== null ? (
            <div className="flex flex-col gap-1 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted tabular-nums">
              <span className="flex justify-between">
                <span>Valoración del {shortDate(base.fechaPrevia)}</span>
                <span className="font-semibold text-fg">{formatCents(base.valorPrevio)}</span>
              </span>
              {base.aportado !== 0 ? (
                <span className="flex justify-between">
                  <span>Aportado desde entonces</span>
                  <span className="font-semibold text-fg">{formatSignedDelta(base.aportado)}</span>
                </span>
              ) : null}
              {valorFinal !== null ? (
                <>
                  <span className="mt-1 flex justify-between hair-t border-hairline pt-2">
                    <span>Valor que se guarda</span>
                    <span className="font-semibold text-fg">{formatCents(valorFinal)}</span>
                  </span>
                  <span className="flex justify-between">
                    <span>Ganancia real</span>
                    <span
                      className={
                        valorFinal - base.base >= 0
                          ? "font-semibold text-income"
                          : "font-semibold text-expense"
                      }
                    >
                      {formatSignedDelta(valorFinal - base.base)}
                    </span>
                  </span>
                </>
              ) : null}
            </div>
          ) : null}

          {base !== null && base.aportado > 0 ? (
            <p className="flex items-start gap-2 text-[13px] leading-[18px] text-muted">
              <Icon name="triangle-alert" size={14} />
              Lo aportado se descuenta antes de calcular la ganancia: meter dinero no es rendir.
            </p>
          ) : null}

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="date">Fecha de la valoración</Label>
            <Input
              id="date"
              name="date"
              type="date"
              required
              max={todayIso()}
              defaultValue={
                respaldo || monthEnd(todayIso()) > todayIso() ? todayIso() : monthEnd(todayIso())
              }
            />
            <p className="text-[13px] leading-[18px] text-muted">
              Si ya hay una valoración de ese mes, se sustituye.
            </p>
          </div>

          <FieldError>{error}</FieldError>

          <DialogFooter>
            <Button type="submit" disabled={pending} block>
              {pending ? "Guardando…" : "Guardar valoración"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
