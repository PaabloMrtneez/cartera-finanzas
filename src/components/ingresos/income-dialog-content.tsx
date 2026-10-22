"use client";

import { useState, useTransition } from "react";
import {
  createRecurringIncome,
  deleteRecurringIncome,
  updateRecurringIncome,
} from "@/app/(app)/fijos/acciones-ingresos";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectItem } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { todayIso } from "@/lib/dates";
import { formatCents, formatCentsPlain, parseAmountToCents } from "@/lib/money";
import type { Account, Category } from "@/lib/supabase/database.types";
import { PERIODICITIES, PERIODICITY_LABELS, PERIODICITY_PER_YEAR, type Periodicity } from "@/lib/types";
import { llamarAccion } from "@/lib/llamar-accion";

export type IncomeRow = {
  id: string;
  description: string;
  amount_cents: number;
  periodicity: Periodicity;
  next_income_date: string;
  started_at: string;
  account_id: string;
  category_id: string | null;
  active: boolean;
};

/**
 * El cuerpo del alta y edición de un ingreso fijo (un ingreso recurrente, en el
 * modelo de datos): el diálogo de Radix y el formulario. Se carga con
 * `next/dynamic` desde `income-dialog` al abrir, para no arrastrar Radix en el
 * paquete inicial de la pantalla.
 *
 * `categories` llega ya filtrado a categorías de INGRESO desde la pantalla.
 */
export default function IncomeDialogContent({
  income,
  accounts,
  categories,
  open,
  onOpenChange,
}: {
  income?: IncomeRow;
  accounts: Account[];
  categories: Category[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [periodicity, setPeriodicity] = useState<Periodicity>(income?.periodicity ?? "MENSUAL");
  const [active, setActive] = useState(income?.active ?? true);
  const [importe, setImporte] = useState(income ? formatCentsPlain(income.amount_cents) : "");
  // «Sin categoría» es una elección real, pero lo que viaja al servidor sigue
  // siendo "" (cadena vacía). El Select usa el centinela "sin" para pintarla y
  // este campo oculto lleva el valor de verdad.
  const [categoryId, setCategoryId] = useState(income?.category_id ?? "");

  const cents = parseAmountToCents(importe);
  const anual = cents !== null && cents > 0 ? cents * PERIODICITY_PER_YEAR[periodicity] : null;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = income
        ? await llamarAccion(() => updateRecurringIncome(income.id, formData))
        : await llamarAccion(() => createRecurringIncome(formData));

      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="suscripcion" title={income ? "Editar ingreso fijo" : "Nuevo ingreso fijo"}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="description">Nombre</Label>
            <Input
              id="description"
              name="description"
              required
              maxLength={60}
              defaultValue={income?.description}
              placeholder="Nómina"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="amount">Importe</Label>
              <Input
                id="amount"
                name="amount"
                inputMode="decimal"
                required
                value={importe}
                onChange={(e) => setImporte(e.target.value)}
                placeholder="1.800"
                className="text-right tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="next_income_date">Próximo ingreso</Label>
              <Input
                id="next_income_date"
                name="next_income_date"
                type="date"
                required
                defaultValue={income?.next_income_date ?? todayIso()}
              />
            </div>
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label>Cada cuánto</Label>
            <input type="hidden" name="periodicity" value={periodicity} />
            <Segmented
              label="Periodicidad"
              value={periodicity}
              onChange={setPeriodicity}
              options={PERIODICITIES.map((p) => ({ value: p, label: PERIODICITY_LABELS[p] }))}
            />
            {anual !== null ? (
              <p className="text-[13px] leading-[18px] text-muted tabular-nums">
                Son {formatCents(anual)} al año.
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="account_id">Cuenta</Label>
              <Select
                id="account_id"
                name="account_id"
                required
                defaultValue={income?.account_id}
                placeholder="Elige una"
              >
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="category_id">Categoría</Label>
              <input type="hidden" name="category_id" value={categoryId} />
              <Select
                id="category_id"
                value={categoryId === "" ? "sin" : categoryId}
                onValueChange={(v) => setCategoryId(v === "sin" ? "" : v)}
              >
                <SelectItem value="sin">Sin categoría</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="started_at">Desde</Label>
            <Input
              id="started_at"
              name="started_at"
              type="date"
              required
              defaultValue={income?.started_at ?? todayIso()}
            />
            <p className="text-[13px] leading-[18px] text-muted">
              Solo informativo: no se generan ingresos anteriores a hoy que no existieran ya.
            </p>
          </div>

          <SwitchRow
            label="Activo"
            hint="En pausa deja de generar movimientos y no cuenta en lo fijo del mes."
            name="active"
            checked={active}
            onCheckedChange={setActive}
          />

          <FieldError>{error}</FieldError>

          <DialogFooter>
            {income ? (
              <BotonConfirmar
                confirmar="Sí, eliminar"
                disabled={pending}
                className="text-expense lg:mr-auto"
                onConfirm={() =>
                  startTransition(async () => {
                    const result = await llamarAccion(() => deleteRecurringIncome(income.id), "borrado");
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

        {income ? (
          <p className="mt-3 flex items-start gap-2 text-[13px] leading-[18px] text-muted">
            <Icon name="triangle-alert" size={14} />
            Al eliminarlo, los movimientos que ya generó se quedan como están. Si solo quieres que
            deje de entrar, ponlo en pausa.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
