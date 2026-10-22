"use client";

import { useState, useTransition } from "react";
import { deleteRule } from "@/app/(app)/reglas/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError } from "@/components/ui/input";
import { llamarAccion } from "@/lib/llamar-accion";

export function DeleteRuleButton({ id, matchText }: { id: string; matchText: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(abierto) => {
        setOpen(abierto);
        if (!abierto) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Eliminar la regla ${matchText}`}>
          <Icon name="trash-2" size={16} />
        </Button>
      </DialogTrigger>

      <DialogContent
        size="borrar"
        title="¿Eliminar la regla?"
        description="Los movimientos que ya clasificó se quedan como están. Solo dejará de aplicarse a los que lleguen a partir de ahora."
      >
        <FieldError>{error}</FieldError>
        <DialogFooter>
          <Button variant="secondary" block onClick={() => setOpen(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            block
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                // Antes se ignoraba el resultado y el diálogo se cerraba aunque
                // la regla siguiera ahí.
                const r = await llamarAccion(() => deleteRule(id), "borrado");
                if (!r.ok) {
                  setError(r.error);
                  return;
                }
                setOpen(false);
              })
            }
          >
            {pending ? "Eliminando…" : "Eliminar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
