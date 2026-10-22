"use client";

import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { DeferredDialog } from "@/components/ui/deferred-dialog";
import { Icon } from "@/components/ui/icon";
import { shortDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";

export type GastoEnlazable = {
  id: string;
  description: string;
  amount_cents: number;
  occurred_on: string;
  merchant_raw: string | null;
};

/*
 * El buscador de gastos —Radix y el cliente de Supabase— se carga al abrir. El
 * formulario de movimientos se abre en cada alta, así que difiriéndolo esos
 * kilobytes no entran en su paquete inicial: llegan solo si se enlaza un gasto.
 */
const Buscador = dynamic(() => import("./reimburse-picker-content"), { ssr: false });

/**
 * Elegir qué gasto reembolsa un ingreso.
 *
 * Un ingreso enlazado a un gasto deja de contar como ingreso: abarata el gasto.
 * Se imputa a la categoría de ese gasto y resta del gasto neto, que es de donde
 * sale la distinción entre lo que pagaste y lo que te costó de verdad.
 *
 * Solo lista GASTOS, porque la base de datos no admite otra cosa: un reembolso
 * solo puede apuntar a un gasto, y la clave foránea compuesta lo impone.
 */
export function ReimbursePicker({
  value,
  onChange,
  disabled,
}: {
  value: GastoEnlazable | null;
  onChange: (gasto: GastoEnlazable | null) => void;
  /** En un gasto o un traspaso la fila se ve, pero apagada. */
  disabled?: boolean;
}) {
  if (disabled) {
    // Estado inactivo: se apaga con COLOR, no con opacity-40. La opacidad
    // hundía el texto por debajo de AA (2,3:1) sin que fuera un control
    // deshabilitado de verdad; con el texto en `muted` se lee igual de
    // secundario y cumple contraste.
    return (
      <div className="flex min-h-[52px] items-center gap-3 rounded-md bg-surface-2 px-3 py-2 text-muted">
        <Icon name="undo-2" size={18} />
        <span className="flex-1 text-[15px]">Reembolsa un gasto</span>
        <span className="text-[13px]">Solo en ingresos</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name="reimburses_id" value={value?.id ?? ""} />

      {value ? (
        <div className="flex min-h-[52px] items-center gap-3 rounded-md bg-accent-soft px-3 py-2">
          <span className="text-accent">
            <Icon name="undo-2" size={18} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] font-semibold">{value.description}</span>
            <span className="text-[13px] leading-[18px] text-muted tabular-nums">
              {formatCents(value.amount_cents)} · {shortDate(value.occurred_on)}
            </span>
          </span>
          <Button variant="ghost" size="icon" aria-label="Quitar el enlace" onClick={() => onChange(null)}>
            <Icon name="x" size={16} />
          </Button>
        </div>
      ) : (
        <DeferredDialog
          trigger={
            <Button variant="secondary" className="justify-start">
              <Icon name="undo-2" size={16} />
              Reembolsa un gasto
            </Button>
          }
        >
          {({ open, onOpenChange }) => (
            <Buscador
              open={open}
              onOpenChange={onOpenChange}
              onPick={(gasto) => {
                onChange(gasto);
                onOpenChange(false);
              }}
            />
          )}
        </DeferredDialog>
      )}

      <p className="text-[13px] leading-[18px] text-muted">
        {value
          ? "Este ingreso no contará como ingreso: abaratará ese gasto."
          : "Si esto es un Bizum que te devuelve un amigo, enlázalo al gasto y no contará como ingreso."}
      </p>
    </div>
  );
}
