"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { deleteLoan, previewLoanDeletion } from "@/app/(app)/prestamos/actions";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import type { LoanDeletePreview } from "@/lib/prestamos";
import {
  fraseBorradoPrestamo,
  fraseGastoPrestamo,
  frasePatrimonioPrestamo,
  frasesSaldosPrestamo,
  nombreConfirma,
} from "@/lib/prestamos-vista";
import { llamarAccion } from "@/lib/llamar-accion";

type Estado =
  | { tipo: "cargando" }
  | { tipo: "error"; error: string }
  | { tipo: "listo"; preview: LoanDeletePreview };

/**
 * El paso de confirmación de «Eliminar préstamo», dentro de la misma hoja del
 * préstamo (sustituye a la gestión; no es un diálogo encima de otro). Calcado
 * de `EliminarCuentaPaso` y `EliminarFondoPaso`.
 *
 * Eliminar un préstamo se lleva por delante el desembolso, las comisiones,
 * todas las cuotas cobradas y la cuenta del préstamo, y no se puede deshacer.
 * Por eso primero se enseña CUÁNTO se borra, luego lo que cambia en las cuentas
 * y en el patrimonio, y solo se activa el botón final cuando se escribe el
 * nombre exacto. La base lo vuelve a comprobar.
 */
export function EliminarPrestamoPaso({
  prestamo,
  onVolver,
  onCancelarEnSuLugar,
  onEliminado,
}: {
  prestamo: { id: string; name: string; activo: boolean };
  onVolver: () => void;
  /** Dejar de seguirlo en su lugar. Solo si sigue activo. */
  onCancelarEnSuLugar: () => void;
  onEliminado: () => void;
}) {
  const [estado, setEstado] = useState<Estado>({ tipo: "cargando" });
  const [intento, setIntento] = useState(0);
  const [escrito, setEscrito] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const region = useRef<HTMLDivElement>(null);
  const campo = useId();
  const ayuda = useId();

  useEffect(() => {
    let vivo = true;
    previewLoanDeletion(prestamo.id).then(
      (r) => {
        if (!vivo) return;
        setEstado(r.ok ? { tipo: "listo", preview: r.preview } : { tipo: "error", error: r.error });
      },
      () => vivo && setEstado({ tipo: "error", error: "Sin conexión. Inténtalo de nuevo." }),
    );
    return () => {
      vivo = false;
    };
  }, [prestamo.id, intento]);

  // El foco va a la región, no al campo: en móvil, el teclado taparía justo
  // los avisos que hay que leer antes de escribir.
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
  }, []);

  const confirma = nombreConfirma(escrito, prestamo.name);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirma) return;
    setError(null);
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await llamarAccion(() => deleteLoan(prestamo.id, formData), "borrado");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onEliminado();
    });
  }

  return (
    <div
      ref={region}
      tabIndex={-1}
      aria-busy={estado.tipo === "cargando"}
      className="flex flex-col gap-4 outline-none"
    >
      {estado.tipo === "cargando" ? (
        <p className="py-6 text-center text-[15px] leading-5 text-muted lg:text-[14px]" aria-live="polite">
          Calculando qué se borraría…
        </p>
      ) : null}

      {estado.tipo === "error" ? (
        <>
          <FieldError>{estado.error}</FieldError>
          <DialogFooter>
            <Button variant="secondary" block onClick={onVolver}>
              Volver
            </Button>
            <Button
              block
              onClick={() => {
                setEstado({ tipo: "cargando" });
                setIntento((i) => i + 1);
              }}
            >
              Reintentar
            </Button>
          </DialogFooter>
        </>
      ) : null}

      {estado.tipo === "listo" ? (
        <>
          <Resumen
            preview={estado.preview}
            activo={prestamo.activo}
            onCancelarEnSuLugar={onCancelarEnSuLugar}
            pending={pending}
          />

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor={campo}>
                Escribe <span className="text-fg">{prestamo.name}</span> para confirmar
              </Label>
              <Input
                id={campo}
                name="confirm_name"
                value={escrito}
                onChange={(e) => setEscrito(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={40}
                aria-describedby={ayuda}
                aria-invalid={escrito.trim().length > 0 && !confirma ? true : undefined}
              />
              <p id={ayuda} className="text-[13px] leading-[18px] text-muted">
                Tal cual, con sus mayúsculas y tildes. No se puede deshacer.
              </p>
            </div>

            <FieldError>{error}</FieldError>

            <DialogFooter>
              <Button variant="secondary" block onClick={onVolver} disabled={pending}>
                Volver
              </Button>
              <Button type="submit" variant="destructive" block disabled={!confirma || pending}>
                {pending ? "Eliminando…" : "Eliminar préstamo"}
              </Button>
            </DialogFooter>
          </form>
        </>
      ) : null}
    </div>
  );
}

/** Lo que se borra y lo que cambia en las cuentas, en frases. */
function Resumen({
  preview,
  activo,
  onCancelarEnSuLugar,
  pending,
}: {
  preview: LoanDeletePreview;
  activo: boolean;
  onCancelarEnSuLugar: () => void;
  pending: boolean;
}) {
  const saldos = frasesSaldosPrestamo(preview);
  const gasto = fraseGastoPrestamo(preview);

  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="text-[17px] leading-[22px] font-semibold text-fg lg:text-[15px] lg:leading-5">
          {fraseBorradoPrestamo(preview)}
        </p>
        {gasto ? (
          <p className="text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">{gasto}</p>
        ) : null}
      </div>

      {/* Lo que cambia FUERA del préstamo, aparte y destacado. */}
      <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-3">
        <p className="flex items-center gap-2 text-[15px] leading-5 font-semibold text-fg lg:text-[14px]">
          <span className="text-warning">
            <Icon name="triangle-alert" size={16} />
          </span>
          {saldos.length > 0 ? "Cambia también en tus cuentas" : "Cambia en tu patrimonio"}
        </p>
        <ul className="flex flex-col gap-[6px] pl-6 text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">
          {saldos.map((frase) => (
            <li key={frase} className="list-disc">
              {frase}
            </li>
          ))}
          <li className="list-disc">{frasePatrimonioPrestamo(preview)}</li>
        </ul>
        <p className="text-[13px] leading-[18px] text-muted">
          Es como si el préstamo nunca se hubiera apuntado: desaparecen el dinero que entró, las
          cuotas y la deuda.
        </p>
      </div>

      {activo ? (
        <div className="hair-t flex flex-col gap-2 border-hairline pt-4 lg:flex-row lg:items-center lg:gap-4">
          <p className="flex-1 text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">
            ¿Solo quieres que deje de cobrar cuotas? Dejar de seguirlo conserva todo lo apuntado.
          </p>
          <Button variant="secondary" size="compact" onClick={onCancelarEnSuLugar} disabled={pending}>
            Dejar de seguirlo
          </Button>
        </div>
      ) : null}
    </>
  );
}
