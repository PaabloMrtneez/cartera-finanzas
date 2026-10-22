"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";
import type { Category } from "@/lib/supabase/database.types";
import type { TransactionType } from "@/lib/types";

/*
 * El cuerpo —Radix y el formulario— se carga al abrir. Así Categorías no
 * arrastra esos kilobytes en su paquete inicial: el alta y la edición se piden a
 * demanda desde el disparador.
 */
const Contenido = dynamic(() => import("./category-dialog-content"), { ssr: false });

export function CategoryDialog({
  category,
  type,
  trigger,
}: {
  /** Sin categoría es un alta; con ella, una edición. */
  category?: Category;
  /** Tipo al que pertenece. En el alta lo fija el grupo desde el que se abre. */
  type: TransactionType;
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido category={category} type={type} open={open} onOpenChange={onOpenChange} />
      )}
    </DeferredDialog>
  );
}
