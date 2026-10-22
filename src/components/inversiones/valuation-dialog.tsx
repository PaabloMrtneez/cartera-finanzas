"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";
import type { BaseValoracion } from "@/lib/valoracion";

/*
 * El cuerpo —Radix y el formulario— se carga al abrir. Así Inversiones no
 * arrastra esos kilobytes en su paquete inicial: valorar una posición se pide a
 * demanda desde el disparador.
 */
const Contenido = dynamic(() => import("./valuation-dialog-content"), { ssr: false });

/**
 * Registrar cuánto vale una posición.
 *
 * Se puede meter por valor absoluto o por porcentaje, pero solo se guarda el
 * valor en céntimos: los porcentajes se derivan siempre de las valoraciones.
 */
export function ValuationDialog({
  positionId,
  positionName,
  base,
  respaldo,
  trigger,
}: {
  positionId: string;
  positionName: string;
  /**
   * Sobre qué se aplica un porcentaje, a fecha de hoy: la valoración del cierre
   * anterior y lo aportado desde entonces (ver `baseDeValoracion`). null si la
   * posición no tiene ninguna valoración de un mes anterior.
   */
  base: BaseValoracion | null;
  /**
   * La posición sigue la cotización de un instrumento: la valoración a mano es
   * un RESPALDO, que manda solo hasta que llegue un precio de su misma fecha o
   * posterior. `ultimoPrecio` es la fecha del último precio, ya escrita.
   */
  respaldo?: { ultimoPrecio: string | null };
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido
          positionId={positionId}
          positionName={positionName}
          base={base}
          respaldo={respaldo}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </DeferredDialog>
  );
}
