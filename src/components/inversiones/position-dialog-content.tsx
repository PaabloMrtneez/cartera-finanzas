"use client";

import { useState, useTransition } from "react";
import { archivePosition, createPosition, updatePosition } from "@/app/(app)/inversiones/actions";
import { EliminarFondoPaso } from "@/components/inversiones/eliminar-fondo-paso";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { todayIso } from "@/lib/dates";
import { llamarAccion } from "@/lib/llamar-accion";

export type Posicion = {
  position_id: string;
  name: string;
  color: string;
  account_id: string;
  since: string;
  archived: boolean;
};

/**
 * El cuerpo del alta y edición de una posición: el diálogo de Radix y el
 * formulario.
 *
 * Se carga con `next/dynamic` desde `position-dialog` la primera vez que se
 * abre, de modo que Radix no entra en el paquete inicial de Inversiones. El
 * estado de apertura lo gobierna el armazón ligero.
 *
 * Solo identidad: nombre, color y cuenta. El valor NO se toca aquí — se registra
 * al valorar, que es lo que deja constancia con su fecha. Mezclarlo permitiría
 * cambiar el valor sin dejar rastro de cuándo.
 *
 * En una edición, «Eliminar fondo» sustituye el formulario por la confirmación
 * del borrado (`EliminarFondoPaso`), como «Eliminar cuenta» en Cuentas. Vale
 * igual para una posición manual que para una que sigue una cotización.
 */
export default function PositionDialogContent({
  position,
  accounts,
  open,
  onOpenChange,
}: {
  position?: Posicion;
  accounts: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [color, setColor] = useState(position?.color ?? "#6d4bc4");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /** «eliminar» sustituye el formulario por la confirmación del borrado. */
  const [paso, setPaso] = useState<"editar" | "eliminar">("editar");
  const eliminando = position !== undefined && paso === "eliminar";

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
      const result = position
        ? await llamarAccion(() => updatePosition(position.position_id, formData))
        : await llamarAccion(() => createPosition(formData));

      if (!result.ok) {
        setError(result.error);
        return;
      }
      cambiarApertura(false);
    });
  }

  function onArchive() {
    if (!position) return;
    startTransition(async () => {
      const result = await llamarAccion(() => archivePosition(position.position_id, !position.archived));
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
        size="posicion"
        title={eliminando ? `Eliminar ${position.name}` : position ? "Editar posición" : "Nueva posición"}
        description={
          eliminando
            ? "Se borra el fondo con sus valoraciones y sus aportaciones. No se puede deshacer."
            : "Solo el nombre y dónde está. El valor se registra al valorar."
        }
      >
        {eliminando ? (
          <EliminarFondoPaso
            position={position}
            onVolver={() => setPaso("editar")}
            onArchivar={onArchive}
            onEliminado={() => {
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
                defaultValue={position?.name}
                placeholder="MSCI World"
              />
            </div>

            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="account_id">Cuenta de inversión</Label>
              <Select
                id="account_id"
                name="account_id"
                required
                defaultValue={position?.account_id ?? ""}
                disabled={!!position}
                placeholder="Elige una"
              >
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </Select>
              {position ? (
                <p className="text-[13px] leading-[18px] text-muted">
                  La cuenta no se cambia: sus valoraciones y aportaciones cuelgan de ella.
                </p>
              ) : accounts.length === 0 ? (
                <p className="text-[13px] leading-[18px] text-warning">
                  No tienes ninguna cuenta de tipo Inversión. Crea una en Cuentas y vuelve.
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="since">Desde</Label>
              <Input
                id="since"
                name="since"
                type="date"
                required
                max={todayIso()}
                defaultValue={position?.since ?? todayIso()}
                disabled={!!position}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Color</Label>
              <ColorPicker name="color" value={color} onChange={setColor} />
            </div>

            <FieldError>{error}</FieldError>

            {position ? (
              /*
                En una edición hay tres acciones, como en la hoja de una cuenta.
                En móvil, Archivar y Eliminar comparten fila y Guardar —la
                habitual— va debajo, entera y al alcance del pulgar; en
                escritorio, las dos de quitar a la izquierda y Guardar a la
                derecha. El mismo orden del DOM en las dos anchuras.
              */
              <div className="mt-4 flex flex-wrap gap-3 lg:flex-nowrap lg:gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={onArchive}
                  disabled={pending}
                  block
                  className={cn(!position.archived && "text-expense")}
                >
                  {position.archived ? "Desarchivar" : "Archivar"}
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
                  Eliminar fondo
                </Button>
                <Button type="submit" disabled={pending} className="w-full lg:w-auto">
                  {pending ? "Guardando…" : "Guardar"}
                </Button>
              </div>
            ) : (
              <DialogFooter>
                <Button type="submit" disabled={pending || accounts.length === 0} block>
                  {pending ? "Guardando…" : "Guardar"}
                </Button>
              </DialogFooter>
            )}

            {position ? (
              <p className="text-[13px] leading-[18px] text-muted">
                Archivar conserva su historia y el patrimonio de meses pasados sigue cuadrando. Eliminar
                lo borra con sus valoraciones y sus aportaciones.
              </p>
            ) : null}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
