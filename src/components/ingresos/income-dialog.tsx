"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";
import type { Account, Category } from "@/lib/supabase/database.types";

export type { IncomeRow } from "./income-dialog-content";

/*
 * El cuerpo —Radix y el formulario— se carga al abrir, para no arrastrar esos
 * kilobytes en el paquete inicial de Fijos.
 */
const Contenido = dynamic(() => import("./income-dialog-content"), { ssr: false });

export function IncomeDialog({
  income,
  accounts,
  categories,
  trigger,
}: {
  income?: import("./income-dialog-content").IncomeRow;
  accounts: Account[];
  categories: Category[];
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido
          income={income}
          accounts={accounts}
          categories={categories}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </DeferredDialog>
  );
}
