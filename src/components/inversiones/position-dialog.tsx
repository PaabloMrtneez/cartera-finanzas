"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";

export type { Posicion } from "./position-dialog-content";

/*
 * El cuerpo —Radix y el formulario— se carga al abrir. Así Inversiones no
 * arrastra esos kilobytes en su paquete inicial: el alta y la edición de una
 * posición se piden a demanda desde el disparador.
 */
const Contenido = dynamic(() => import("./position-dialog-content"), { ssr: false });

/**
 * Alta y edición de una posición.
 *
 * Solo identidad: nombre, color y cuenta. El valor NO se toca aquí — se registra
 * al valorar, que es lo que deja constancia con su fecha.
 */
export function PositionDialog({
  position,
  accounts,
  trigger,
}: {
  position?: import("./position-dialog-content").Posicion;
  accounts: { id: string; name: string }[];
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido
          position={position}
          accounts={accounts}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </DeferredDialog>
  );
}
