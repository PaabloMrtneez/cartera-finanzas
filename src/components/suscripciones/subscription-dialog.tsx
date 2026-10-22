"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";
import type { Account, Category } from "@/lib/supabase/database.types";

export type { SubscriptionRow } from "./subscription-dialog-content";

/*
 * El cuerpo —Radix y el formulario— se carga al abrir. Así Fijos no
 * arrastra esos kilobytes en su paquete inicial: el alta y la edición se piden a
 * demanda desde el disparador.
 */
const Contenido = dynamic(() => import("./subscription-dialog-content"), { ssr: false });

export function SubscriptionDialog({
  subscription,
  accounts,
  categories,
  trigger,
}: {
  subscription?: import("./subscription-dialog-content").SubscriptionRow;
  accounts: Account[];
  categories: Category[];
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido
          subscription={subscription}
          accounts={accounts}
          categories={categories}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </DeferredDialog>
  );
}
