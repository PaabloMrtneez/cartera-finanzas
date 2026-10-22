"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";
import type { Category } from "@/lib/supabase/database.types";

export type { BudgetExistente } from "./budget-dialog-content";

/*
 * El cuerpo —Radix y el formulario— se carga al abrir. Así Análisis no arrastra
 * esos kilobytes en su paquete inicial: el alta y la edición de un límite se
 * piden a demanda desde el disparador.
 */
const Contenido = dynamic(() => import("./budget-dialog-content"), { ssr: false });

export function BudgetDialog({
  budget,
  categories,
  averages,
  trigger,
}: {
  budget?: import("./budget-dialog-content").BudgetExistente;
  categories: Category[];
  /** Media de 6 meses por categoría, para sugerir un tope con criterio. */
  averages?: Map<string, number>;
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido
          budget={budget}
          categories={categories}
          averages={averages}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </DeferredDialog>
  );
}
