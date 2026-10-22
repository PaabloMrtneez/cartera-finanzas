"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";
import type { Category } from "@/lib/supabase/database.types";

/*
 * El cuerpo —Radix y el formulario— se carga al abrir. Así Reglas no arrastra
 * esos kilobytes en su paquete inicial: el alta se pide a demanda desde el
 * disparador.
 */
const Contenido = dynamic(() => import("./rule-dialog-content"), { ssr: false });

export function RuleDialog({
  categories,
  initialText = "",
  trigger,
}: {
  categories: Category[];
  /** Prellenado cuando se crea desde una sugerencia. */
  initialText?: string;
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido
          categories={categories}
          initialText={initialText}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </DeferredDialog>
  );
}
