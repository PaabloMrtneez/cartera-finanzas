"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";

export type { PrestamoGestion } from "./prestamo-dialog-content";

/*
 * El cuerpo —Radix, el formulario y la vista previa— se carga al abrir. Así
 * Préstamos no arrastra esos kilobytes en su paquete inicial.
 */
const Contenido = dynamic(() => import("./prestamo-dialog-content"), { ssr: false });

/**
 * El alta de un préstamo (sin `prestamo`) o su gestión: editar, cambiar las
 * condiciones, aportar de más, liquidar, dejar de seguirlo y eliminar.
 * `paso` la abre directamente en uno (los botones de la ficha).
 */
export function PrestamoDialog({
  prestamo,
  cuentas,
  categorias,
  paso,
  trigger,
}: {
  prestamo?: import("./prestamo-dialog-content").PrestamoGestion;
  paso?: import("./prestamo-dialog-content").Paso;
  cuentas: { id: string; name: string }[];
  categorias: { id: string; name: string }[];
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido
          prestamo={prestamo}
          cuentas={cuentas}
          categorias={categorias}
          pasoInicial={paso}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </DeferredDialog>
  );
}
