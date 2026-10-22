"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteTransaction } from "@/app/(app)/movimientos/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError } from "@/components/ui/input";
import { llamarAccion } from "@/lib/llamar-accion";

export function DeleteTransactionButton({
  id,
  reimbursements = 0,
  reimbursesDescription,
}: {
  id: string;
  /** Cuántos ingresos reembolsan este gasto. Borrarlo los deja sueltos. */
  reimbursements?: number;
  /** Si esto es un ingreso enlazado, el gasto que volverá a costar lo suyo. */
  reimbursesDescription?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Eliminar movimiento">
          <Icon name="trash-2" size={18} />
        </Button>
      </DialogTrigger>

      <DialogContent
        size="borrar"
        title="¿Eliminar el movimiento?"
        description="No se puede deshacer. Los saldos se recalculan solos, porque se derivan de los movimientos."
      >
        {/* El efecto colateral sobre lo enlazado hay que decirlo antes, no después. */}
        {reimbursements > 0 ? (
          <p className="mb-3 flex items-start gap-2 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted">
            <span className="text-warning">
              <Icon name="triangle-alert" size={16} />
            </span>
            <span>
              {reimbursements === 1
                ? "Hay un ingreso que reembolsa este gasto y se quedará sin enlace: volverá a contar como ingreso normal."
                : `Hay ${reimbursements} ingresos que reembolsan este gasto y se quedarán sin enlace: volverán a contar como ingresos normales.`}
            </span>
          </p>
        ) : null}

        {reimbursesDescription ? (
          <p className="mb-3 flex items-start gap-2 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted">
            <span className="text-warning">
              <Icon name="triangle-alert" size={16} />
            </span>
            <span>
              «{reimbursesDescription}» volverá a costar su importe completo, porque este era el
              ingreso que lo abarataba.
            </span>
          </p>
        ) : null}

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
                const result = await llamarAccion(() => deleteTransaction(id), "borrado");
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                router.push("/movimientos");
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
