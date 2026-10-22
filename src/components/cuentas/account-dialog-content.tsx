"use client";

import { useRef, useState, useTransition } from "react";
import { createAccount, setAccountArchived, updateAccount } from "@/app/(app)/cuentas/actions";
import { CardManager } from "@/components/cuentas/card-manager";
import { EliminarCuentaPaso } from "@/components/cuentas/eliminar-cuenta-paso";
import { BotonSigno, alternarSigno } from "@/components/ui/boton-signo";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { formatCentsPlain } from "@/lib/money";
import type { Account, Card } from "@/lib/supabase/database.types";
import { ACCOUNT_TYPES_ELEGIBLES, ACCOUNT_TYPE_ICONS, ACCOUNT_TYPE_LABELS, type AccountType } from "@/lib/types";
import { llamarAccion } from "@/lib/llamar-accion";

/**
 * El cuerpo del alta y edición de una cuenta: el diálogo de Radix y el
 * formulario.
 *
 * Se carga con `next/dynamic` desde `account-dialog` la primera vez que se abre,
 * de modo que Radix no entra en el paquete inicial de Cuentas. El estado de
 * apertura lo gobierna el armazón ligero.
 */
export default function AccountDialogContent({
  account,
  cards = [],
  open,
  onOpenChange,
}: {
  /** Sin cuenta es un alta; con cuenta, una edición. */
  account?: Account;
  /** Las tarjetas de la cuenta que se edita. En un alta no hay ninguna todavía. */
  cards?: Card[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const saldoRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [type, setType] = useState<AccountType>(account?.type ?? "BANCO");
  const [color, setColor] = useState(account?.color ?? "#1f7fa8");
  /** «eliminar» sustituye el formulario por la confirmación del borrado. */
  const [paso, setPaso] = useState<"editar" | "eliminar">("editar");
  const eliminando = account !== undefined && paso === "eliminar";

  // Al cerrar la hoja, la próxima vez vuelve a abrirse en el formulario.
  function cambiarApertura(abierto: boolean) {
    if (!abierto) setPaso("editar");
    onOpenChange(abierto);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = account
        ? await llamarAccion(() => updateAccount(account.id, formData))
        : await llamarAccion(() => createAccount(formData));

      if (!result.ok) {
        setError(result.error);
        return;
      }
      cambiarApertura(false);
    });
  }

  function onArchive() {
    if (!account) return;
    startTransition(async () => {
      const result = await llamarAccion(() => setAccountArchived(account.id, !account.archived));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      cambiarApertura(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={cambiarApertura}>
      <DialogContent
        size="registro"
        title={eliminando ? `Eliminar ${account.name}` : account ? "Editar cuenta" : "Nueva cuenta"}
        description={
          eliminando
            ? "Se borra la cuenta con todo lo suyo. No se puede deshacer."
            : account
              ? undefined
              : "El saldo que verás después se deriva de este punto de partida más todos los movimientos."
        }
      >
        {eliminando ? (
          <EliminarCuentaPaso
            account={account}
            onVolver={() => setPaso("editar")}
            onArchivar={onArchive}
            onEliminada={() => {
              cambiarApertura(false);
            }}
          />
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="name">Nombre</Label>
              <Input
                id="name"
                name="name"
                required
                maxLength={60}
                defaultValue={account?.name}
                placeholder="Cuenta principal"
              />
            </div>

            <div className="flex flex-col gap-[6px]">
              <Label>Tipo</Label>
              <input type="hidden" name="type" value={type} />
              <Segmented
                label="Tipo de cuenta"
                value={type}
                onChange={setType}
                options={ACCOUNT_TYPES_ELEGIBLES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] }))}
              />
              <p className="flex items-center gap-[6px] text-[13px] leading-[18px] text-muted">
                <Icon name={ACCOUNT_TYPE_ICONS[type]} size={14} />
                {type === "INVERSION"
                  ? "Podrás colgar posiciones de esta cuenta."
                  : "Sus movimientos cuentan en el balance del mes."}
              </p>
            </div>

            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="initial_balance_cents">Saldo inicial</Label>
              <div className="flex items-center gap-2">
                <BotonSigno
                  onClick={() => {
                    // El campo no es controlado: se le cambia el valor en el DOM.
                    if (saldoRef.current) saldoRef.current.value = alternarSigno(saldoRef.current.value);
                  }}
                />
                <Input
                  ref={saldoRef}
                  id="initial_balance_cents"
                  name="initial_balance_cents"
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  defaultValue={account ? formatCentsPlain(account.initial_balance_cents) : ""}
                  placeholder="0,00"
                  className="text-right tabular-nums"
                />
              </div>
              <p className="text-[13px] leading-[18px] text-muted">
                Puede ser negativo: una tarjeta de crédito arranca en deuda. Coma para los decimales.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Color</Label>
              <ColorPicker name="color" value={color} onChange={setColor} />
            </div>

            {/*
              Las tarjetas se gestionan aparte, con acciones propias: una tarjeta
              necesita el id de una cuenta que ya existe, así que solo se pueden
              añadir cuando la cuenta está guardada. En un alta, una nota lo dice.
            */}
            {account ? (
              <CardManager accountId={account.id} cards={cards} />
            ) : (
              <p className="flex items-center gap-[6px] text-[13px] leading-[18px] text-muted">
                <Icon name="credit-card" size={14} />
                Cuando guardes la cuenta podrás añadirle tarjetas para que el Atajo enrute sus pagos.
              </p>
            )}

            <FieldError>{error}</FieldError>

            {account ? (
              /*
                En una edición hay tres acciones. En móvil, Archivar y Eliminar
                comparten fila y Guardar —la habitual— va debajo, entera y al
                alcance del pulgar; en escritorio, las dos de quitar a la izquierda
                y Guardar a la derecha. El mismo orden del DOM en las dos anchuras.
              */
              <div className="mt-4 flex flex-wrap gap-3 lg:flex-nowrap lg:gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={onArchive}
                  disabled={pending}
                  block
                  className={cn(!account.archived && "text-expense")}
                >
                  {account.archived ? "Desarchivar" : "Archivar"}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    setError(null);
                    setPaso("eliminar");
                  }}
                  disabled={pending}
                  block
                  className="lg:mr-auto"
                >
                  Eliminar cuenta
                </Button>
                <Button type="submit" disabled={pending} className="w-full lg:w-auto">
                  {pending ? "Guardando…" : "Guardar"}
                </Button>
              </div>
            ) : (
              <DialogFooter>
                <Button type="submit" disabled={pending} block>
                  {pending ? "Guardando…" : "Guardar"}
                </Button>
              </DialogFooter>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
