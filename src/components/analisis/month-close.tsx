"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";

export type { MesCerrado } from "./month-close-content";

/*
 * El cuerpo —Radix y el cliente de Supabase— se carga al abrir. Así Análisis no
 * arrastra esos kilobytes en el paquete inicial: el cierre de mes se consulta a
 * demanda desde la cabecera.
 */
const Contenido = dynamic(() => import("./month-close-content"), { ssr: false });

/**
 * Cierre de mes: qué pasó en un mes ya terminado.
 *
 * Permite recorrer cualquier mes cerrado, no solo el último: mirar atrás es
 * justo para lo que sirve esto.
 */
export function MonthClose({
  months,
  trigger,
}: {
  months: import("./month-close-content").MesCerrado[];
  trigger: React.ReactNode;
}) {
  if (months.length === 0) return null;

  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido months={months} open={open} onOpenChange={onOpenChange} />
      )}
    </DeferredDialog>
  );
}
