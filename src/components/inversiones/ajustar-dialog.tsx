"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";

export type { AportacionEstimada, PosicionSeguida } from "./ajustar-dialog-content";

/* El cuerpo se carga al abrir, como el resto de diálogos de Inversiones. */
const Contenido = dynamic(() => import("./ajustar-dialog-content"), { ssr: false });

/**
 * Lo que se hace con una posición que sigue una cotización: ajustar sus
 * participaciones con lo que dice el bróker, corregir las de las aportaciones
 * que se estimaron y dejar de seguirla.
 */
export function AjustarDialog({
  posicion,
  trigger,
}: {
  posicion: import("./ajustar-dialog-content").PosicionSeguida;
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido posicion={posicion} open={open} onOpenChange={onOpenChange} />
      )}
    </DeferredDialog>
  );
}
