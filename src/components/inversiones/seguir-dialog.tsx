"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";

export type { PosicionConvertible } from "./seguir-dialog-content";

/*
 * El cuerpo —Radix, la búsqueda y el formulario— se carga al abrir, como el
 * resto de diálogos de Inversiones: no entra en el paquete inicial.
 */
const Contenido = dynamic(() => import("./seguir-dialog-content"), { ssr: false });

/**
 * Seguir la cotización de un fondo, un ETF o una acción.
 *
 * Buscar por ISIN o por nombre, elegir la candidata que coincide con la del
 * bróker y anotar cuántas participaciones tienes, cuánto has aportado y a qué
 * fecha. Sirve para una posición NUEVA o para convertir una manual
 * (`posicionId`, o eligiéndola en el propio diálogo).
 */
export function SeguirDialog({
  accounts,
  manuales,
  posicionId,
  trigger,
}: {
  accounts: { id: string; name: string }[];
  /** Las posiciones manuales que se pueden convertir, con lo ya aportado a cada una. */
  manuales: import("./seguir-dialog-content").PosicionConvertible[];
  /** Si viene, se convierte esa posición y no se ofrece elegir. */
  posicionId?: string;
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido
          accounts={accounts}
          manuales={manuales}
          posicionId={posicionId}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </DeferredDialog>
  );
}
