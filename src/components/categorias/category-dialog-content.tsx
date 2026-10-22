"use client";

import { useState, useTransition } from "react";
import {
  createCategory,
  deleteCategory,
  updateCategory,
} from "@/app/(app)/categorias/actions";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { IconPicker } from "@/components/ui/icon-picker";
import { FieldError, Input, Label } from "@/components/ui/input";
import type { Category } from "@/lib/supabase/database.types";
import { TRANSACTION_TYPE_LABELS, type TransactionType } from "@/lib/types";
import { llamarAccion } from "@/lib/llamar-accion";

/**
 * El cuerpo del alta y edición de una categoría: el diálogo de Radix y el
 * formulario, con la vista previa en vivo.
 *
 * Se carga con `next/dynamic` desde `category-dialog` la primera vez que se
 * abre, de modo que Radix no entra en el paquete inicial de Categorías. El
 * estado de apertura lo gobierna el armazón ligero.
 */
export default function CategoryDialogContent({
  category,
  type,
  open,
  onOpenChange,
}: {
  /** Sin categoría es un alta; con ella, una edición. */
  category?: Category;
  /** Tipo al que pertenece. En el alta lo fija el grupo desde el que se abre. */
  type: TransactionType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Vista previa en vivo, como en el prototipo.
  const [name, setName] = useState(category?.name ?? "");
  const [color, setColor] = useState(category?.color ?? "#2f8f4e");
  const [icon, setIcon] = useState(category?.icon ?? "shopping-cart");

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = category
        ? await llamarAccion(() => updateCategory(category.id, formData))
        : await llamarAccion(() => createCategory(formData));

      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
    });
  }

  function onDelete() {
    if (!category) return;
    startTransition(async () => {
      const result = await llamarAccion(() => deleteCategory(category.id), "borrado");
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
        size="categoria"
        title={category ? "Editar categoría" : `Nueva categoría de ${TRANSACTION_TYPE_LABELS[type].toLowerCase()}`}
        description={
          category
            ? "El tipo no se puede cambiar una vez creada."
            : undefined
        }
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <input type="hidden" name="type" value={category?.type ?? type} />

          {/* Vista previa: exactamente como se verá en la lista de movimientos */}
          <div className="flex items-center gap-3 rounded-md bg-surface-2 p-3">
            <span
              className="flex size-[38px] shrink-0 items-center justify-center rounded-full"
              style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}
            >
              <Icon name={icon} size={19} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[17px] leading-[22px] font-semibold">
              {name.trim() || "Sin nombre"}
            </span>
            <span className="text-[13px] leading-[18px] text-muted">
              {TRANSACTION_TYPE_LABELS[category?.type ?? type]}
            </span>
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              required
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Supermercado"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Color</Label>
            <ColorPicker name="color" value={color} onChange={setColor} />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Icono</Label>
            <IconPicker name="icon" value={icon} onChange={setIcon} color={color} />
          </div>

          <FieldError>{error}</FieldError>

          <DialogFooter>
            {category ? (
              <BotonConfirmar
                confirmar="Sí, eliminar"
                onConfirm={onDelete}
                disabled={pending}
                className="text-expense lg:mr-auto"
              >
                Eliminar
              </BotonConfirmar>
            ) : null}
            <Button type="submit" disabled={pending} block>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>

        {category ? (
          <p className="mt-3 text-[13px] leading-[18px] text-muted">
            Si la eliminas, sus movimientos no se borran: pasan a «Sin categoría».
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
