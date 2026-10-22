"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { escaparComodinesLike } from "@/lib/busqueda";
import { cn } from "@/lib/cn";
import { shortDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";
import type { GastoEnlazable } from "./reimburse-picker";
import { mensajeErrorLectura } from "@/lib/llamar-accion";

/**
 * El buscador de gastos que reembolsar: el diálogo de Radix y la consulta a
 * Supabase.
 *
 * Se carga con `next/dynamic` desde `reimburse-picker` la primera vez que se
 * abre, de modo que ni Radix ni `@supabase/supabase-js` entran en el paquete
 * inicial del formulario de movimientos (que se abre en cada alta). El estado de
 * apertura lo gobierna el armazón ligero.
 */
export default function ReimbursePickerContent({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (gasto: GastoEnlazable) => void;
}) {
  const [texto, setTexto] = useState("");
  const [gastos, setGastos] = useState<GastoEnlazable[] | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let vivo = true;
    const temporizador = setTimeout(async () => {
      const supabase = createClient();
      // Por la RPC y no con un `.or()` armado a mano: lo escrito llega a
      // Postgres como parámetro, así que una coma o un paréntesis son texto y
      // no gramática de PostgREST. Solo se escapan los comodines de ILIKE.
      const limpio = texto.trim();
      const { data, error } = await supabase.rpc("search_transactions", {
        p_type: "EXPENSE",
        p_q: limpio ? escaparComodinesLike(limpio) : null,
        p_limit: 30,
      });
      if (vivo) {
        setFallo(error ? mensajeErrorLectura(error, "los gastos") : null);
        setGastos(
          (data ?? []).map((t) => ({
            id: t.id,
            description: t.description,
            amount_cents: t.amount_cents,
            occurred_on: t.occurred_on,
            merchant_raw: t.merchant_raw,
          })),
        );
      }
    }, 250);

    return () => {
      vivo = false;
      clearTimeout(temporizador);
    };
  }, [texto, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="reembolso"
        title="¿Qué gasto reembolsa?"
        description="Solo aparecen gastos: un reembolso no puede apuntar a otra cosa."
      >
        <div className="flex flex-col gap-3">
          <div className="relative">
            <span aria-hidden className="absolute top-1/2 left-3 -translate-y-1/2 text-muted">
              <Icon name="search" size={18} />
            </span>
            <Input
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Busca el gasto…"
              aria-label="Buscar un gasto"
              className="pl-10"
            />
          </div>

          {fallo ? (
            <p role="status" className="py-8 text-center text-[15px] text-muted">
              {fallo}
            </p>
          ) : gastos === null ? (
            <div className="h-40 esqueleto rounded-md" />
          ) : gastos.length === 0 ? (
            <p role="status" className="py-8 text-center text-[15px] text-muted">
              {texto.trim() ? "Ningún gasto coincide." : "Todavía no hay gastos que reembolsar."}
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {gastos.map((gasto) => (
                <li key={gasto.id}>
                  <button
                    type="button"
                    onClick={() => onPick(gasto)}
                    className={cn(
                      "flex w-full min-h-[52px] items-center gap-3 hair-t border-separator px-1 py-2 text-left",
                      "transition-colors duration-150 ease-ui hover:bg-surface-2",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[15px] font-semibold">
                        {gasto.description || gasto.merchant_raw || "Sin descripción"}
                      </span>
                      <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                        {shortDate(gasto.occurred_on)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[15px] font-semibold tabular-nums">
                      {formatCents(gasto.amount_cents)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <span className="text-[13px] leading-[18px] text-muted">
            Un gasto puede recibir varios reembolsos parciales.
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
