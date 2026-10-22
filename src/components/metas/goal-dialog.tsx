"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";
import type { Account } from "@/lib/supabase/database.types";

export type { GoalRow } from "./goal-dialog-content";

/*
 * El cuerpo —Radix y el formulario— se carga al abrir, para no arrastrar esos
 * kilobytes en el paquete inicial de Metas.
 */
const Contenido = dynamic(() => import("./goal-dialog-content"), { ssr: false });

export function GoalDialog({
  goal,
  accounts,
  trigger,
}: {
  goal?: import("./goal-dialog-content").GoalRow;
  accounts: Account[];
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido goal={goal} accounts={accounts} open={open} onOpenChange={onOpenChange} />
      )}
    </DeferredDialog>
  );
}
