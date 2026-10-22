"use client";

import { useEffect, useState, useTransition } from "react";
import { createRule, previewRule } from "@/app/(app)/reglas/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { formatCents } from "@/lib/money";
import type { Category } from "@/lib/supabase/database.types";
import { llamarAccion } from "@/lib/llamar-accion";

/**
 * El cuerpo del alta de una regla de comercio: el diálogo de Radix, el
 * formulario y la vista previa de cuántos movimientos tocaría.
 *
 * Se carga con `next/dynamic` desde `rule-dialog` la primera vez que se abre, de
 * modo que Radix no entra en el paquete inicial de Reglas. El estado de apertura
 * lo gobierna el armazón ligero.
 */
export default function RuleDialogContent({
  categories,
  initialText = "",
  open,
  onOpenChange,
}: {
  categories: Category[];
  /** Prellenado cuando se crea desde una sugerencia. */
  initialText?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState(initialText);
  const [categoryId, setCategoryId] = useState("");
  const [retro, setRetro] = useState(true);
  const [preview, setPreview] = useState<{
    text: string;
    occurrences: number;
    totalCents: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Cuántos movimientos tocaría, mientras se escribe.
  useEffect(() => {
    const clean = text.trim();
    if (clean.length < 2) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      // Es solo una vista previa: sin red no se enseña y ya está; el alta no
      // depende de ella.
      const result = await previewRule(clean).catch(() => null);
      if (!cancelled && result) setPreview({ text: clean, ...result });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text]);

  // Se deriva en el renderizado en vez de guardarse: así nunca se enseña el
  // resultado de un texto que ya se ha cambiado.
  const current = preview && preview.text === text.trim() ? preview : null;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await llamarAccion(() => createRule(formData));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      setText("");
      setCategoryId("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="registro"
        title="Nueva regla de comercio"
        description="Cuando el comercio de un pago contenga este texto, se clasificará solo."
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="match_text">Si el comercio contiene</Label>
            <Input
              id="match_text"
              name="match_text"
              required
              minLength={2}
              maxLength={60}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="MERCADONA"
              // Es un código de comercio, no texto: sin corrector ni
              // autocompletado, y el teclado de iOS ya en mayúsculas.
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="characters"
              className="font-mono uppercase"
            />
            <p className="text-[13px] leading-[18px] text-muted">
              No distingue mayúsculas y basta con que aparezca en cualquier parte del nombre. Si dos
              reglas coinciden, gana la más específica.
            </p>
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="category_id">Clasificar como</Label>
            <Select
              id="category_id"
              name="category_id"
              required
              placeholder="Elige una categoría"
              value={categoryId}
              onValueChange={setCategoryId}
            >
              {categories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </Select>
          </div>

          {current && current.occurrences > 0 ? (
            <div className="flex items-start gap-2 rounded-md bg-accent-soft p-3">
              <span className="text-accent">
                <Icon name="check" size={16} />
              </span>
              <div className="flex flex-col gap-1">
                <p className="text-[15px] leading-5 font-semibold">
                  Coincide con {current.occurrences}{" "}
                  {current.occurrences === 1 ? "movimiento" : "movimientos"} del histórico
                </p>
                <p className="text-[13px] leading-[18px] text-muted tabular-nums">
                  {formatCents(current.totalCents)} sin clasificar
                </p>
              </div>
            </div>
          ) : null}

          <SwitchRow
            label="Aplicarla a los que ya están"
            hint="Solo toca los que siguen sin categoría; nunca pisa lo que hayas clasificado a mano."
            name="apply_retroactively"
            checked={retro}
            onCheckedChange={setRetro}
          />

          <FieldError>{error}</FieldError>

          <DialogFooter>
            <Button type="submit" disabled={pending} block>
              {pending ? "Creando…" : "Crear la regla"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
