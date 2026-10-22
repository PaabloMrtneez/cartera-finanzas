"use client";

import { useId, useState, useTransition } from "react";
import {
  ajustarParticipaciones,
  dejarDeSeguir,
  participacionesDeAportacion,
} from "@/app/(app)/inversiones/mercado-actions";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { FieldError, Input, Label } from "@/components/ui/input";
import { shortDate, todayIso } from "@/lib/dates";
import {
  formatParticipaciones,
  formatPrecio,
  valorEnCentimos,
  type TipoInstrumento,
} from "@/lib/mercado";
import { formatCents } from "@/lib/money";
import { parseParticipaciones } from "@/lib/participaciones";
import { llamarAccion } from "@/lib/llamar-accion";

/** Una aportación cuyas participaciones se estimaron con el precio de su día. */
export type AportacionEstimada = {
  id: string;
  fecha: string;
  /** El importe, ya escrito: formatCents no cruza la frontera como función. */
  importe: string;
  descripcion: string;
};

/** Lo que el diálogo necesita de una posición sincronizada, todo en texto. */
export type PosicionSeguida = {
  position_id: string;
  name: string;
  instrumento: string;
  tipo: TipoInstrumento | null;
  /** Participaciones actuales, decimal exacto en texto. */
  unidades: string | null;
  precio: string | null;
  divisa: string | null;
  /** Unidades de la divisa por euro (BCE); null en euros. */
  cambio: string | null;
  /** Desde cuándo se sigue: ni un ajuste ni la baja pueden ser anteriores. */
  alta: string | null;
  estimadas: AportacionEstimada[];
};

/**
 * El cuerpo de «Ajustar». Tres cosas, de la más frecuente a la más rara:
 *
 *   1. AJUSTAR con lo que dice MyInvestor: el TOTAL de participaciones a una
 *      fecha, no la diferencia. Se anota como un ajuste en el libro y el pasado
 *      no se reescribe; un ajuste equivocado se corrige con otro.
 *   2. CORREGIR las aportaciones cuyas participaciones se estimaron.
 *   3. DEJAR DE SEGUIR, con un segundo toque: vuelve a manual sin salto.
 */
export default function AjustarDialogContent({
  posicion,
  open,
  onOpenChange,
}: {
  posicion: PosicionSeguida;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ids = useId();
  const hoy = todayIso();

  const [unidades, setUnidades] = useState("");
  const [fecha, setFecha] = useState(hoy);
  const [nota, setNota] = useState("");
  const [errorUnidades, setErrorUnidades] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, startGuardar] = useTransition();

  const [fechaBaja, setFechaBaja] = useState(hoy);
  const [errorBaja, setErrorBaja] = useState<string | null>(null);
  const [soltando, startSoltar] = useTransition();

  const lectura = unidades.trim() ? parseParticipaciones(unidades, { permitirCero: true }) : null;
  const vistaPrevia =
    lectura?.ok && posicion.precio
      ? valorEnCentimos(
          lectura.valor,
          posicion.precio,
          posicion.divisa && posicion.divisa !== "EUR" ? posicion.cambio : null,
        )
      : null;

  function guardar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const final = parseParticipaciones(unidades, { permitirCero: true });
    if (!final.ok) {
      setErrorUnidades(final.error);
      return;
    }
    startGuardar(async () => {
      const r = await llamarAccion(() =>
        ajustarParticipaciones({
          position_id: posicion.position_id,
          participaciones: unidades,
          fecha,
          nota,
        }),
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setUnidades("");
      setNota("");
      onOpenChange(false);
    });
  }

  function soltar() {
    setErrorBaja(null);
    startSoltar(async () => {
      const r = await llamarAccion(() =>
        dejarDeSeguir({ position_id: posicion.position_id, fecha: fechaBaja }),
      );
      if (!r.ok) {
        setErrorBaja(r.error);
        return;
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="posicion"
        title={`Ajustar ${posicion.name}`}
        description={posicion.instrumento}
      >
        <form onSubmit={guardar} className="flex flex-col gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor={`${ids}-unidades`}>
              {posicion.tipo === "FONDO" || posicion.tipo === null
                ? "Participaciones según MyInvestor"
                : "Acciones según el bróker"}
            </Label>
            <Input
              id={`${ids}-unidades`}
              inputMode="decimal"
              autoComplete="off"
              required
              value={unidades}
              onChange={(e) => {
                setUnidades(e.target.value);
                setErrorUnidades(null);
              }}
              onBlur={() => setErrorUnidades(lectura && !lectura.ok ? lectura.error : null)}
              aria-invalid={errorUnidades ? true : undefined}
              aria-describedby={`${ids}-unidades-ayuda`}
              placeholder="1234,567890"
              className="text-right tabular-nums"
            />
            <p id={`${ids}-unidades-ayuda`} className="text-[13px] leading-[18px] text-muted">
              {posicion.unidades
                ? `Ahora cuenta ${formatParticipaciones(posicion.unidades, posicion.tipo)} `
                : ""}
              Escribe el total que te dice, no la diferencia.
            </p>
            <FieldError>{errorUnidades}</FieldError>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor={`${ids}-fecha`}>A fecha de</Label>
              <Input
                id={`${ids}-fecha`}
                type="date"
                required
                min={posicion.alta ?? undefined}
                max={hoy}
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor={`${ids}-nota`}>Nota</Label>
              <Input
                id={`${ids}-nota`}
                maxLength={200}
                value={nota}
                onChange={(e) => setNota(e.target.value)}
                placeholder="Opcional"
              />
            </div>
          </div>

          {lectura?.ok && posicion.precio && posicion.divisa ? (
            <p className="flex flex-col gap-1 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted tabular-nums">
              <span>
                {formatParticipaciones(lectura.valor, posicion.tipo)} ×{" "}
                {formatPrecio(posicion.precio, posicion.divisa)}
              </span>
              {vistaPrevia !== null ? (
                <span>
                  Con el último precio valdría{" "}
                  <span className="font-semibold text-fg">{formatCents(vistaPrevia)}</span>.
                </span>
              ) : null}
            </p>
          ) : null}

          <FieldError>{error}</FieldError>

          <DialogFooter>
            <Button type="submit" disabled={guardando} block>
              {guardando ? "Guardando…" : "Guardar ajuste"}
            </Button>
          </DialogFooter>
        </form>

        {posicion.estimadas.length > 0 ? (
          <section className="mt-6 flex flex-col gap-3 hair-t border-hairline pt-5">
            <h3 className="text-[15px] leading-5 font-semibold">
              Aportaciones con participaciones estimadas
            </h3>
            <p className="text-[13px] leading-[18px] text-muted">
              Se estimaron con el precio de su día. Si tienes la orden, escribe las de verdad; si
              lo dejas vacío, se siguen estimando.
            </p>
            <ul className="flex flex-col overflow-hidden rounded-md hair border-hairline">
              {posicion.estimadas.map((a) => (
                <FilaEstimada key={a.id} aportacion={a} tipo={posicion.tipo} />
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-6 flex flex-col gap-3 hair-t border-hairline pt-5">
          <h3 className="text-[15px] leading-5 font-semibold">Dejar de seguir la cotización</h3>
          <p className="text-[13px] leading-[18px] text-muted">
            Vuelve a valorarse a mano desde esa fecha. Para que la cifra no salte, se guarda como
            valoración lo que valía ese día. No se pierde nada: el alta, los ajustes y los precios
            se quedan, y la curva del pasado no cambia.
          </p>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="flex flex-col gap-[6px] lg:flex-1">
              <Label htmlFor={`${ids}-baja`}>Desde</Label>
              <Input
                id={`${ids}-baja`}
                type="date"
                required
                min={posicion.alta ?? undefined}
                max={hoy}
                value={fechaBaja}
                onChange={(e) => setFechaBaja(e.target.value)}
              />
            </div>
            <BotonConfirmar
              confirmar="Sí, dejar de seguir"
              onConfirm={soltar}
              disabled={soltando}
              className="text-expense"
            >
              {soltando ? "Un momento…" : "Dejar de seguir"}
            </BotonConfirmar>
          </div>
          <FieldError>{errorBaja}</FieldError>
        </section>
      </DialogContent>
    </Dialog>
  );
}

/** Una aportación estimada, con su campo para escribir las de verdad. */
function FilaEstimada({
  aportacion,
  tipo,
}: {
  aportacion: AportacionEstimada;
  tipo: TipoInstrumento | null;
}) {
  const id = useId();
  const [texto, setTexto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState(false);
  const [guardando, startGuardar] = useTransition();
  const etiqueta = `${tipo === "FONDO" || tipo === null ? "Participaciones" : "Acciones"} de la aportación del ${shortDate(aportacion.fecha)}`;

  function guardar() {
    setError(null);
    if (texto.trim()) {
      const lectura = parseParticipaciones(texto);
      if (!lectura.ok) {
        setError(lectura.error);
        return;
      }
    }
    startGuardar(async () => {
      const r = await llamarAccion(() =>
        participacionesDeAportacion({
          transaction_id: aportacion.id,
          participaciones: texto.trim() ? texto : null,
        }),
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setHecho(true);
    });
  }

  return (
    <li className="flex flex-col gap-2 hair-t border-separator px-3 py-3 first:border-t-0">
      <span className="flex items-baseline justify-between gap-3 text-[15px] leading-5">
        <span className="min-w-0 truncate">
          {shortDate(aportacion.fecha)}
          {aportacion.descripcion ? (
            <span className="text-muted"> · {aportacion.descripcion}</span>
          ) : null}
        </span>
        <span className="shrink-0 font-semibold tabular-nums">{aportacion.importe}</span>
      </span>
      <span className="flex items-center gap-2">
        <Input
          id={id}
          aria-label={etiqueta}
          inputMode="decimal"
          autoComplete="off"
          value={texto}
          onChange={(e) => {
            setTexto(e.target.value);
            setHecho(false);
          }}
          placeholder="Estimadas"
          className="text-right tabular-nums"
        />
        <Button
          type="button"
          variant="secondary"
          className="h-11 shrink-0 lg:h-[38px]"
          disabled={guardando}
          onClick={guardar}
        >
          {guardando ? "…" : "Guardar"}
        </Button>
      </span>
      <span aria-live="polite" className="text-[13px] leading-[18px] text-muted empty:hidden">
        {hecho ? "Guardadas." : ""}
      </span>
      <FieldError>{error}</FieldError>
    </li>
  );
}
