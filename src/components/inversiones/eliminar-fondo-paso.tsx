"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { deletePosition, previewPositionDeletion } from "@/app/(app)/inversiones/actions";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import {
  type PositionDeletePreview,
  fraseBorradoFondo,
  frasePatrimonio,
  frasesSaldos,
  fraseValorFondo,
  nombreConfirma,
} from "@/lib/eliminar-fondo";
import { llamarAccion } from "@/lib/llamar-accion";

type Estado =
  { tipo: "cargando" } | { tipo: "error"; error: string } | { tipo: "listo"; preview: PositionDeletePreview };

/**
 * El paso de confirmación de «Eliminar fondo», dentro de la misma hoja de la
 * posición (sustituye al formulario; no es un diálogo encima de otro). Calcado
 * de `EliminarCuentaPaso`.
 *
 * Eliminar un fondo se lleva por delante sus valoraciones, su libro de
 * participaciones y los traspasos que le aportaron dinero, y no se puede
 * deshacer. Por eso primero se enseña CUÁNTO se borra, luego lo que cambia en
 * las cuentas —el dinero aportado vuelve a las de origen y la de inversión baja
 * lo mismo— y en el patrimonio, y solo se activa el botón final cuando se
 * escribe el nombre exacto del fondo. La base lo vuelve a comprobar.
 */
export function EliminarFondoPaso({
  position,
  onVolver,
  onArchivar,
  onEliminado,
}: {
  position: { position_id: string; name: string; archived: boolean };
  onVolver: () => void;
  /** Archivar en su lugar. Solo se ofrece si el fondo no está archivado ya. */
  onArchivar: () => void;
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
    previewPositionDeletion(position.position_id).then(
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
  }, [position.position_id, intento]);

  /*
   * Al entrar en el paso, el foco va a su región (no al campo): en móvil,
   * enfocar el campo sacaría el teclado y taparía justo los avisos que hay que
   * leer antes de escribir. Con preventScroll, por lo mismo que en el diálogo.
   */
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
  }, []);

  const confirma = nombreConfirma(escrito, position.name);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirma) return;
    setError(null);
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await llamarAccion(() => deletePosition(position.position_id, formData), "borrado");
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
        <Resumen
          preview={estado.preview}
          archivado={position.archived}
          onArchivar={onArchivar}
          pending={pending}
        />
      ) : null}

      {estado.tipo === "listo" ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor={campo}>
              Escribe <span className="text-fg">{position.name}</span> para confirmar
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
              {pending ? "Eliminando…" : "Eliminar fondo"}
            </Button>
          </DialogFooter>
        </form>
      ) : null}
    </div>
  );
}

/** Lo que se borra y lo que cambia en las cuentas, en frases. */
function Resumen({
  preview,
  archivado,
  onArchivar,
  pending,
}: {
  preview: PositionDeletePreview;
  archivado: boolean;
  onArchivar: () => void;
  pending: boolean;
}) {
  const saldos = frasesSaldos(preview);

  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="text-[17px] leading-[22px] font-semibold text-fg lg:text-[15px] lg:leading-5">
          {fraseBorradoFondo(preview)}
        </p>
        <p className="text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">
          {fraseValorFondo(preview)}
        </p>
        {preview.follows_instrument ? (
          <p className="text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">
            El instrumento y sus precios no se borran: son de todos y otros pueden seguirlo.
          </p>
        ) : null}
      </div>

      {/* Lo que cambia FUERA del fondo va aparte y destacado: es lo que no se
          espera quien solo piensa en «este» fondo. */}
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
          <li className="list-disc">{frasePatrimonio(preview)}</li>
        </ul>
        {saldos.length > 0 ? (
          <p className="text-[13px] leading-[18px] text-muted">
            Los traspasos que aportaron dinero al fondo se borran: es como si ese dinero nunca se hubiera
            movido.
          </p>
        ) : null}
      </div>

      {/* La alternativa que conserva la historia, antes del campo de confirmar. */}
      {!archivado ? (
        <div className="hair-t flex flex-col gap-2 border-hairline pt-4 lg:flex-row lg:items-center lg:gap-4">
          <p className="flex-1 text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">
            ¿Solo quieres que no estorbe? Archivarlo conserva sus valoraciones y sus aportaciones, y el
            patrimonio de meses pasados sigue cuadrando.
          </p>
          <Button variant="secondary" size="compact" onClick={onArchivar} disabled={pending}>
            Archivar en su lugar
          </Button>
        </div>
      ) : null}
    </>
  );
}
