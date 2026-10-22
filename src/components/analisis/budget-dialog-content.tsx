"use client";

import { useState, useTransition } from "react";
import { createBudget, deleteBudget, updateBudget } from "@/app/(app)/analisis/actions";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { formatCents, formatCentsPlain } from "@/lib/money";
import type { Category } from "@/lib/supabase/database.types";
import { llamarAccion } from "@/lib/llamar-accion";

export type BudgetExistente = {
  budget_id: string;
  category_id: string;
  name: string;
  cap_cents: number;
  warn_at_80: boolean;
  discount_reimbursements: boolean;
  rollover_unspent: boolean;
};

/**
 * El cuerpo del alta y edición de un límite: el diálogo de Radix y el
 * formulario, con las sugerencias a partir de la media.
 *
 * Se carga con `next/dynamic` desde `budget-dialog` la primera vez que se abre,
 * de modo que Radix no entra en el paquete inicial de Análisis. El estado de
 * apertura lo gobierna el armazón ligero.
 */
export default function BudgetDialogContent({
  budget,
  categories,
  averages,
  open,
  onOpenChange,
}: {
  budget?: BudgetExistente;
  categories: Category[];
  /** Media de 6 meses por categoría, para sugerir un tope con criterio. */
  averages?: Map<string, number>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [categoryId, setCategoryId] = useState(budget?.category_id ?? "");
  const [cap, setCap] = useState(budget ? formatCentsPlain(budget.cap_cents) : "");
  const [avisar, setAvisar] = useState(budget?.warn_at_80 ?? true);
  const [descontar, setDescontar] = useState(budget?.discount_reimbursements ?? true);
  const [arrastrar, setArrastrar] = useState(budget?.rollover_unspent ?? false);

  const media = categoryId ? averages?.get(categoryId) : undefined;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = budget
        ? await llamarAccion(() => updateBudget(budget.budget_id, formData))
        : await llamarAccion(() => createBudget(formData));

      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size={budget ? "limite" : "limiteNuevo"}
        title={budget ? `Límite de ${budget.name}` : "Nuevo límite"}
        description="Los límites nunca bloquean nada: solo colorean y avisan."
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {budget ? (
            <input type="hidden" name="category_id" value={budget.category_id} />
          ) : (
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="category_id">Categoría</Label>
              <Select
                id="category_id"
                name="category_id"
                required
                placeholder="Elige una categoría de gasto"
                value={categoryId}
                onValueChange={setCategoryId}
              >
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </Select>
              {categories.length === 0 ? (
                <p className="text-[13px] leading-[18px] text-muted">
                  Todas tus categorías de gasto tienen ya un límite.
                </p>
              ) : null}
            </div>
          )}

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="cap">Tope mensual</Label>
            <Input
              id="cap"
              name="cap"
              inputMode="decimal"
              required
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="200,00"
              className="text-right tabular-nums"
            />

            {/* Sugerencias con criterio, a partir de lo que gastas de verdad. */}
            {media !== undefined && media > 0 ? (
              <div className="flex flex-wrap gap-2">
                {[
                  { etiqueta: "Su media", valor: media },
                  { etiqueta: "Holgado", valor: Math.round(media * 1.2) },
                  { etiqueta: "Ajustado", valor: Math.round(media * 0.85) },
                ].map((sugerencia) => (
                  <button
                    key={sugerencia.etiqueta}
                    type="button"
                    onClick={() => setCap(formatCentsPlain(sugerencia.valor))}
                    className={cn(
                      "h-8 rounded-xs bg-surface-2 px-3 text-[13px] font-semibold text-muted",
                      "transition-colors duration-150 ease-ui hover:text-fg",
                    )}
                  >
                    {sugerencia.etiqueta} · {formatCents(sugerencia.valor)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[13px] leading-[18px] text-muted">
                Cuando tengas unos meses de histórico, aquí saldrán sugerencias con tu media.
              </p>
            )}
          </div>

          <div className="flex flex-col">
            <SwitchRow
              label="Avisar al 80 %"
              hint="Un solo aviso por umbral y mes. El 80 % y el 100 % son avisos distintos."
              name="warn_at_80"
              checked={avisar}
              onCheckedChange={setAvisar}
            />
            <SwitchRow
              label="Descontar reembolsos"
              hint="Si alguien te devuelve parte de un gasto, no consume tope. Recomendado."
              name="discount_reimbursements"
              checked={descontar}
              onCheckedChange={setDescontar}
            />
            <SwitchRow
              label="Arrastrar lo que sobre"
              hint="Lo no gastado se suma al tope del mes siguiente."
              name="rollover_unspent"
              checked={arrastrar}
              onCheckedChange={setArrastrar}
            />
          </div>

          <FieldError>{error}</FieldError>

          <DialogFooter>
            {budget ? (
              <BotonConfirmar
                confirmar="Sí, quitarlo"
                disabled={pending}
                className="text-expense lg:mr-auto"
                onConfirm={() =>
                  startTransition(async () => {
                    const result = await llamarAccion(() => deleteBudget(budget.budget_id), "borrado");
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    onOpenChange(false);
                  })
                }
              >
                Quitar el límite
              </BotonConfirmar>
            ) : null}
            <Button type="submit" disabled={pending} block>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
