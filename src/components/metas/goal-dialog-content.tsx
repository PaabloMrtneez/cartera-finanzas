"use client";

import { useState, useTransition } from "react";
import { createGoal, deleteGoal, updateGoal } from "@/app/(app)/metas/actions";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { formatCentsPlain } from "@/lib/money";
import type { Account } from "@/lib/supabase/database.types";
import { llamarAccion } from "@/lib/llamar-accion";

export type GoalRow = {
  id: string;
  name: string;
  target_cents: number;
  account_id: string;
  deadline: string | null;
};

/**
 * El cuerpo del alta y edición de una meta: el diálogo de Radix y el
 * formulario. Se carga con `next/dynamic` desde `goal-dialog` al abrir, para no
 * arrastrar Radix en el paquete inicial de Metas.
 *
 * `accounts` llega con todas las cuentas activas —de dinero y de inversión—
 * desde la pantalla: aquí solo se listan.
 */
export default function GoalDialogContent({
  goal,
  accounts,
  open,
  onOpenChange,
}: {
  goal?: GoalRow;
  accounts: Account[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [importe, setImporte] = useState(goal ? formatCentsPlain(goal.target_cents) : "");

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = goal ? await llamarAccion(() => updateGoal(goal.id, formData)) : await llamarAccion(() => createGoal(formData));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="meta" title={goal ? "Editar meta" : "Nueva meta"}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              required
              maxLength={60}
              defaultValue={goal?.name}
              placeholder="Fondo de emergencia"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="target">Objetivo</Label>
              <Input
                id="target"
                name="target"
                inputMode="decimal"
                required
                value={importe}
                onChange={(e) => setImporte(e.target.value)}
                placeholder="5.000"
                className="text-right tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="deadline">Fecha límite</Label>
              <Input id="deadline" name="deadline" type="date" defaultValue={goal?.deadline ?? ""} />
            </div>
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="account_id">Cuenta</Label>
            <Select
              id="account_id"
              name="account_id"
              required
              defaultValue={goal?.account_id}
              placeholder="Elige una"
            >
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </Select>
            <p className="text-[13px] leading-[18px] text-muted">
              El progreso es lo que hay en esta cuenta: su saldo, o el valor invertido si es una
              cuenta de inversión. Una meta por cuenta.
            </p>
          </div>

          <FieldError>{error}</FieldError>

          <DialogFooter>
            {goal ? (
              <BotonConfirmar
                confirmar="Sí, eliminar"
                disabled={pending}
                className="text-expense lg:mr-auto"
                onConfirm={() =>
                  startTransition(async () => {
                    const result = await llamarAccion(() => deleteGoal(goal.id), "borrado");
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    onOpenChange(false);
                  })
                }
              >
                Eliminar
              </BotonConfirmar>
            ) : null}
            <Button type="submit" disabled={pending} block>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>

        {goal ? (
          <p className="mt-3 flex items-start gap-2 text-[13px] leading-[18px] text-muted">
            <Icon name="triangle-alert" size={14} />
            Borrar la meta no toca el dinero de la cuenta: solo quita el objetivo.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
