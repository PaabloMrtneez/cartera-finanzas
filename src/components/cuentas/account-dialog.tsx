"use client";

import dynamic from "next/dynamic";
import { DeferredDialog } from "@/components/ui/deferred-dialog";
import type { Account, Card } from "@/lib/supabase/database.types";

/*
 * El cuerpo —Radix y el formulario— se carga al abrir. Así Cuentas no arrastra
 * esos kilobytes en su paquete inicial: el alta y la edición se piden a demanda
 * desde el disparador.
 */
const Contenido = dynamic(() => import("./account-dialog-content"), { ssr: false });

export function AccountDialog({
  account,
  cards,
  trigger,
}: {
  /** Sin cuenta es un alta; con cuenta, una edición. */
  account?: Account;
  /** Las tarjetas de la cuenta que se edita, para gestionarlas en el diálogo. */
  cards?: Card[];
  trigger: React.ReactNode;
}) {
  return (
    <DeferredDialog trigger={trigger}>
      {({ open, onOpenChange }) => (
        <Contenido account={account} cards={cards} open={open} onOpenChange={onOpenChange} />
      )}
    </DeferredDialog>
  );
}
