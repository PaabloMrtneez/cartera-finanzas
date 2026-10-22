"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { deleteAccount, previewAccountDeletion } from "@/app/(app)/cuentas/actions";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import {
  type AccountDeletePreview,
  bloqueadaPorPrestamo,
  desgloseMovimientos,
  fraseAtajo,
  fraseBorrado,
  fraseSaldo,
  frasesReembolsos,
  frasePrestamos,
  frasesTraspasos,
  nombreConfirma,
} from "@/lib/eliminar-cuenta";
import { llamarAccion } from "@/lib/llamar-accion";

type Estado =
  { tipo: "cargando" } | { tipo: "error"; error: string } | { tipo: "listo"; preview: AccountDeletePreview };

/**
 * El paso de confirmación de «Eliminar cuenta», dentro de la misma hoja de la
 * cuenta (sustituye al formulario; no es un diálogo encima de otro).
 *
 * Borrar una cuenta se lleva por delante todos sus movimientos y lo que cuelga
 * de ella, y no se puede deshacer. Por eso no basta el botón de dos toques
 * (`BotonConfirmar`): primero se enseña CUÁNTO se va a borrar, luego lo que
 * cambia FUERA de la cuenta —los saldos de las cuentas con las que tenía
 * traspasos, los reembolsos que cruzan— y solo se activa el botón final cuando
 * se escribe el nombre exacto de la cuenta. La base lo vuelve a comprobar.
 */
export function EliminarCuentaPaso({
  account,
  onVolver,
  onArchivar,
  onEliminada,
}: {
  account: { id: string; name: string; archived: boolean };
  onVolver: () => void;
  /** Archivar en su lugar. Solo se ofrece si la cuenta no está archivada ya. */
  onArchivar: () => void;
  onEliminada: () => void;
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
    previewAccountDeletion(account.id).then(
      (r) => {
        if (!vivo) return;
        setEstado(r.ok ? { tipo: "listo", preview: r.preview } : { tipo: "error", error: r.error });
      },
      () =>
        vivo &&
        setEstado({
          tipo: "error",
          error: "Sin conexión. Inténtalo de nuevo.",
        }),
    );
    return () => {
      vivo = false;
    };
  }, [account.id, intento]);

  /*
   * Al entrar en el paso, el foco va a su región (no al campo): en móvil,
   * enfocar el campo sacaría el teclado y taparía justo los avisos que hay que
   * leer antes de escribir. Con preventScroll, por lo mismo que en el diálogo.
   */
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
  }, []);

  const confirma = nombreConfirma(escrito, account.name);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirma) return;
    setError(null);
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await llamarAccion(() => deleteAccount(account.id, formData), "borrado");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onEliminada();
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
        <Resumen
          preview={estado.preview}
          archivada={account.archived}
          onArchivar={onArchivar}
          pending={pending}
        />
      ) : null}

      {/*
        Si un préstamo usa la cuenta, la base no deja borrarla: no se pide el
        nombre para luego fallar. Solo queda volver (o archivarla, arriba).
      */}
      {estado.tipo === "listo" && bloqueadaPorPrestamo(estado.preview) ? (
        <DialogFooter>
          <Button variant="secondary" block onClick={onVolver}>
            Volver
          </Button>
        </DialogFooter>
      ) : null}

      {estado.tipo === "listo" && !bloqueadaPorPrestamo(estado.preview) ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor={campo}>
              Escribe <span className="text-fg">{account.name}</span> para confirmar
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
              maxLength={60}
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
              {pending ? "Eliminando…" : "Eliminar cuenta"}
            </Button>
          </DialogFooter>
        </form>
      ) : null}
    </div>
  );
}

/** Lo que se borra y lo que cambia fuera, en frases. */
function Resumen({
  preview,
  archivada,
  onArchivar,
  pending,
}: {
  preview: AccountDeletePreview;
  archivada: boolean;
  onArchivar: () => void;
  pending: boolean;
}) {
  const desglose = desgloseMovimientos(preview);
  const fuera = [...frasesTraspasos(preview), ...frasesReembolsos(preview)];
  const atajo = fraseAtajo(preview);
  if (atajo) fuera.push(atajo);
  const prestamos = frasePrestamos(preview);

  return (
    <>
      {/* Lo que impide borrarla, lo primero: antes de leer nada más. */}
      {prestamos ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md bg-surface-2 p-3 text-[15px] leading-5 text-fg lg:text-[14px]"
        >
          <span className="mt-[2px] shrink-0 text-warning">
            <Icon name="lock" size={16} />
          </span>
          <span>{prestamos}</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="text-[17px] leading-[22px] font-semibold text-fg lg:text-[15px] lg:leading-5">
          {fraseBorrado(preview)}
        </p>
        {desglose ? (
          <p className="text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">{desglose}</p>
        ) : null}
        <p className="text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">
          {fraseSaldo(preview)}
        </p>
      </div>

      {/* Lo que cambia FUERA de la cuenta va aparte y destacado: es lo que no se
          espera quien solo piensa en «esta» cuenta. */}
      {fuera.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-3">
          <p className="flex items-center gap-2 text-[15px] leading-5 font-semibold text-fg lg:text-[14px]">
            <span className="text-warning">
              <Icon name="triangle-alert" size={16} />
            </span>
            Cambia también fuera de esta cuenta
          </p>
          <ul className="flex flex-col gap-[6px] pl-6 text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">
            {fuera.map((frase) => (
              <li key={frase} className="list-disc">
                {frase}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* La alternativa que conserva la historia, antes del campo de confirmar. */}
      {!archivada ? (
        <div className="hair-t flex flex-col gap-2 border-hairline pt-4 lg:flex-row lg:items-center lg:gap-4">
          <p className="flex-1 text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">
            ¿Solo quieres que no estorbe? Archivarla conserva toda su historia y la quita de los selectores
            del día a día.
          </p>
          <Button variant="secondary" size="compact" onClick={onArchivar} disabled={pending}>
            Archivar en su lugar
          </Button>
        </div>
      ) : null}
    </>
  );
}
