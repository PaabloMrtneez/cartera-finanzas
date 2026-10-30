"use client";

import { useId, useState, useTransition } from "react";
import { guardarTarjetaCartera, quitarTarjetaCartera } from "@/app/(app)/ajustes/actions";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { llamarAccion } from "@/lib/llamar-accion";

export type TarjetaCartera = { id: string; name: string; account_id: string };

/**
 * A qué cuenta van los avisos de cada tarjeta de Cartera.
 *
 * El aviso de Cartera dice la tarjeta por su NOMBRE («Santander», «Revolut»),
 * no por sus dígitos. Si se llama igual que una cuenta, va sola; si no —la
 * cuenta «Revoult» y la tarjeta «Revolut»—, se asigna aquí. Sin asignar, el
 * cargo va a la cuenta de respaldo de arriba, pendiente y con una nota.
 *
 * Y sirve para las recargas: pagar con una tarjeta a OTRA de esta lista
 * (recargar Revolut con la de Santander) se apunta como traspaso, no como
 * gasto.
 */
export function TarjetasCartera({
  tarjetas,
  cuentas,
}: {
  tarjetas: TarjetaCartera[];
  cuentas: { id: string; name: string }[];
}) {
  const ids = { nombre: useId(), cuenta: useId() };
  const [nombre, setNombre] = useState("");
  const [cuenta, setCuenta] = useState("");
  // Al añadir, se vacía el formulario: el desplegable vuelve a «Elige una cuenta».
  const [vuelta, setVuelta] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function ejecutar(accion: () => Promise<{ ok: boolean; error?: string }>, alAcabar?: () => void) {
    setError(null);
    startTransition(async () => {
      const r = await llamarAccion(accion);
      if (!r.ok) {
        setError(r.error ?? "No se ha podido guardar.");
        return;
      }
      alAcabar?.();
    });
  }

  const nombreCuenta = new Map(cuentas.map((c) => [c.id, c.name]));

  return (
    <div className="flex flex-col gap-3 hair-t border-separator px-[18px] py-3">
      <div className="flex flex-col gap-1">
        <span className="text-[15px] leading-5 font-semibold">Tarjetas de Cartera</span>
        <p className="text-[13px] leading-[18px] text-muted">
          El aviso de Cartera dice la tarjeta por su nombre. Si se llama igual que una de tus cuentas, va
          sola; si no, asígnala aquí. Pagar con una tarjeta a otra de esta lista (recargar Revolut con
          la de Santander) se apunta como traspaso, no como gasto.
        </p>
      </div>

      {tarjetas.length > 0 ? (
        <ul className="flex flex-col">
          {tarjetas.map((t) => (
            <li key={t.id} className="flex min-h-12 items-center gap-3 hair-t border-separator py-2 first:border-t-0">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-semibold">{t.name}</span>
                <span className="truncate text-[13px] leading-[18px] text-muted">
                  → {nombreCuenta.get(t.account_id) ?? "una cuenta archivada"}
                </span>
              </span>
              <BotonConfirmar
                variant="ghost"
                size="compact"
                confirmar="Sí, quitar"
                disabled={pending}
                className="text-expense"
                onConfirm={() => ejecutar(() => quitarTarjetaCartera(t.id))}
              >
                Quitar
              </BotonConfirmar>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        key={vuelta}
        className="flex flex-col gap-3 lg:flex-row lg:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          ejecutar(
            () => guardarTarjetaCartera(nombre, cuenta),
            () => {
              setNombre("");
              setCuenta("");
              setVuelta((v) => v + 1);
            },
          );
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <Label htmlFor={ids.nombre}>Nombre en el aviso</Label>
          <Input
            id={ids.nombre}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            maxLength={60}
            autoComplete="off"
            placeholder="Revolut"
            required
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <Label htmlFor={ids.cuenta}>Va a la cuenta</Label>
          <Select
            id={ids.cuenta}
            required
            placeholder="Elige una cuenta"
            value={cuenta}
            onValueChange={setCuenta}
          >
            {cuentas.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary" disabled={pending || !nombre.trim() || !cuenta}>
          {pending ? "Guardando…" : "Asignar"}
        </Button>
      </form>
      <FieldError>{error}</FieldError>
    </div>
  );
}
