"use client";

import { useId, useState, useTransition } from "react";
import {
  cancelLoan,
  createLoan,
  settleLoan,
  updateLoan,
  updateLoanTerms,
} from "@/app/(app)/prestamos/actions";
import {
  CondicionesPrestamo,
  type CondicionesIniciales,
} from "@/components/prestamos/condiciones-prestamo";
import { EliminarPrestamoPaso } from "@/components/prestamos/eliminar-prestamo-paso";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { FieldError, Input, Label } from "@/components/ui/input";
import { formatCents } from "@/lib/money";
import { hoyEnMadrid } from "@/lib/prestamos";
import { llamarAccion } from "@/lib/llamar-accion";

/** Lo que la hoja necesita saber de un préstamo para gestionarlo. */
export type PrestamoGestion = {
  id: string;
  name: string;
  /** La TAE del contrato, como se escribiría («6,9»), o "" si no se dio. */
  taeContrato: string;
  /** La que se enseña si no hay contrato, ya escrita: «6,92 %». */
  taeCalculada: string;
  activo: boolean;
  /** Sin cuotas cobradas por la app: las condiciones aún se pueden cambiar. */
  puedeCambiarCondiciones: boolean;
  pendienteCents: number;
  cuentaPago: string;
  /** Desde cuándo se puede liquidar: el inicio, o la última cuota cobrada. */
  liquidarDesde: string;
  condiciones: CondicionesIniciales;
};

type Paso = "editar" | "condiciones" | "liquidar" | "cancelar" | "eliminar";

const TITULOS: Record<Paso, (nombre: string) => string> = {
  editar: (n) => n,
  condiciones: () => "Cambiar las condiciones",
  liquidar: (n) => `Liquidar ${n}`,
  cancelar: (n) => `Dejar de seguir ${n}`,
  eliminar: (n) => `Eliminar ${n}`,
};

const DESCRIPCIONES: Record<Paso, string> = {
  editar: "El nombre y la TAE se cambian siempre. Las condiciones, solo antes de la primera cuota.",
  condiciones: "Se rehacen el cuadro, el ingreso del dinero y la comisión. Aún no hay cuotas cobradas.",
  liquidar: "Lo has pagado entero, o lo amortizas ahora: la deuda queda a cero.",
  cancelar: "Deja de cobrar cuotas sin mover dinero.",
  eliminar: "Se borra con todos sus movimientos. No se puede deshacer.",
};

/**
 * El cuerpo de la hoja de un préstamo: el ALTA (sin préstamo) o su GESTIÓN
 * (con él). Se carga con `next/dynamic` la primera vez que se abre, para que
 * Radix y el formulario no entren en el paquete inicial de la pantalla.
 *
 * La gestión tiene pasos dentro de la misma hoja, como «Eliminar cuenta»: el
 * nombre y la TAE se editan siempre; las condiciones, solo si no hay cuotas
 * cobradas (`updateLoanTerms`); «Liquidar» y «Dejar de seguirlo» cierran el
 * préstamo de dos formas distintas y cada una lo explica; y «Eliminar» pide el
 * nombre escrito.
 */
export default function PrestamoDialogContent({
  prestamo,
  cuentas,
  open,
  onOpenChange,
}: {
  prestamo?: PrestamoGestion;
  cuentas: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [paso, setPaso] = useState<Paso>("editar");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = { nombre: useId(), tae: useId(), fecha: useId(), comision: useId() };
  const hoy = hoyEnMadrid();

  function cambiarApertura(abierto: boolean) {
    if (!abierto) {
      setPaso("editar");
      setError(null);
    }
    onOpenChange(abierto);
  }

  function ir(siguiente: Paso) {
    setError(null);
    setPaso(siguiente);
  }

  /** Corre una acción; si sale bien, cierra la hoja y refresca la pantalla. */
  function ejecutar(accion: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const r = await llamarAccion(accion);
      if (!r.ok) {
        setError(r.error ?? "No se pudo guardar.");
        return;
      }
      cambiarApertura(false);
    });
  }

  const alSubmit = (accion: (fd: FormData) => Promise<{ ok: boolean; error?: string }>) =>
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      ejecutar(() => accion(fd));
    };

  const botonesCondiciones = (texto: string, volver?: () => void) => (
    <>
      <FieldError>{error}</FieldError>
      <DialogFooter>
        {volver ? (
          <Button variant="secondary" block onClick={volver} disabled={pending}>
            Volver
          </Button>
        ) : null}
        <Button type="submit" block disabled={pending || cuentas.length === 0}>
          {pending ? "Guardando…" : texto}
        </Button>
      </DialogFooter>
    </>
  );

  // ── Alta ────────────────────────────────────────────────────────────────
  if (!prestamo) {
    return (
      <Dialog open={open} onOpenChange={cambiarApertura}>
        <DialogContent
          size="prestamo"
          title="Nuevo préstamo"
          description="La cuota, los intereses y la TAE se calculan al escribir. Las cuotas se cobran solas cada mes."
        >
          <form onSubmit={alSubmit(createLoan)}>
            <CondicionesPrestamo
              cuentas={cuentas}
              conTae
              cabecera={
                <div className="flex flex-col gap-[6px]">
                  <Label htmlFor={ids.nombre}>Nombre</Label>
                  <Input
                    id={ids.nombre}
                    name="name"
                    required
                    maxLength={40}
                    autoComplete="off"
                    placeholder="Coche"
                  />
                </div>
              }
              pie={botonesCondiciones("Guardar préstamo")}
            />
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Gestión ─────────────────────────────────────────────────────────────
  const p = prestamo;
  return (
    <Dialog open={open} onOpenChange={cambiarApertura}>
      <DialogContent
        size={paso === "condiciones" ? "prestamo" : "base"}
        title={TITULOS[paso](p.name)}
        description={DESCRIPCIONES[paso]}
      >
        {paso === "editar" ? (
          <div className="flex flex-col gap-5">
            <form onSubmit={alSubmit((fd) => updateLoan(p.id, fd))} className="flex flex-col gap-4">
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor={ids.nombre}>Nombre</Label>
                <Input
                  id={ids.nombre}
                  name="name"
                  required
                  maxLength={40}
                  defaultValue={p.name}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor={ids.tae}>TAE del contrato (opcional)</Label>
                <Input
                  id={ids.tae}
                  name="tae"
                  inputMode="decimal"
                  autoComplete="off"
                  defaultValue={p.taeContrato}
                  placeholder={p.taeCalculada.replace(/\s?%$/, "")}
                  aria-describedby={`${ids.tae}-ayuda`}
                  className="tabular-nums"
                />
                <p id={`${ids.tae}-ayuda`} className="text-[13px] leading-[18px] text-muted">
                  Si la dejas vacía, se enseña la calculada con la comisión: {p.taeCalculada}.
                </p>
              </div>
              <FieldError>{error}</FieldError>
              <DialogFooter>
                <Button type="submit" block disabled={pending}>
                  {pending ? "Guardando…" : "Guardar"}
                </Button>
              </DialogFooter>
            </form>

            <section className="flex flex-col gap-2 hair-t border-hairline pt-4">
              <h3 className="text-[15px] leading-5 font-semibold">Condiciones</h3>
              {p.puedeCambiarCondiciones && p.activo ? (
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
                  <p className="flex-1 text-[13px] leading-[18px] text-muted">
                    Aún no se ha cobrado ninguna cuota: puedes corregir el importe, el plazo, el TIN o
                    las fechas.
                  </p>
                  <Button variant="secondary" size="compact" onClick={() => ir("condiciones")}>
                    Cambiar condiciones
                  </Button>
                </div>
              ) : (
                <p className="text-[13px] leading-[18px] text-muted">
                  Ya no se pueden cambiar: hay cuotas cobradas y el cuadro tiene que seguir cuadrando con
                  ellas. Si lo amortizas entero, usa «Liquidar».
                </p>
              )}
            </section>

            {p.activo ? (
              <section className="flex flex-col gap-3 hair-t border-hairline pt-4">
                <h3 className="text-[15px] leading-5 font-semibold">Terminar antes de tiempo</h3>
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
                  <p className="flex-1 text-[13px] leading-[18px] text-muted">
                    <span className="font-semibold text-fg">Liquidar</span>: lo pagas entero (o ya lo
                    pagaste fuera de la app). Se apunta el pago de lo pendiente y la deuda queda a cero.
                  </p>
                  <Button variant="secondary" size="compact" onClick={() => ir("liquidar")}>
                    Liquidar
                  </Button>
                </div>
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
                  <p className="flex-1 text-[13px] leading-[18px] text-muted">
                    <span className="font-semibold text-fg">Dejar de seguirlo</span>: no mueve dinero.
                    Deja de cobrar cuotas y lo pendiente sigue contando como deuda.
                  </p>
                  <Button
                    variant="secondary"
                    size="compact"
                    className="text-expense"
                    onClick={() => ir("cancelar")}
                  >
                    Dejar de seguirlo
                  </Button>
                </div>
              </section>
            ) : null}

            <section className="flex flex-col gap-2 hair-t border-hairline pt-4 lg:flex-row lg:items-center lg:gap-4">
              <p className="flex-1 text-[13px] leading-[18px] text-muted">
                Eliminarlo lo borra con todos sus movimientos, como si nunca lo hubieras apuntado.
              </p>
              <Button variant="destructive" onClick={() => ir("eliminar")}>
                Eliminar préstamo
              </Button>
            </section>
          </div>
        ) : null}

        {paso === "condiciones" ? (
          <form onSubmit={alSubmit((fd) => updateLoanTerms(p.id, fd))}>
            <CondicionesPrestamo
              cuentas={cuentas}
              inicial={p.condiciones}
              pie={botonesCondiciones("Guardar condiciones", () => ir("editar"))}
            />
          </form>
        ) : null}

        {paso === "liquidar" ? (
          <form onSubmit={alSubmit((fd) => settleLoan(p.id, fd))} className="flex flex-col gap-4">
            <p className="text-[15px] leading-5 text-fg lg:text-[14px]">
              Se cobran las cuotas que hayan vencido hasta esa fecha y se apunta un traspaso de lo que
              quede (ahora, {formatCents(p.pendienteCents)}) desde {p.cuentaPago} a la cuenta del
              préstamo. Después no se cobra nada más.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor={ids.fecha}>Fecha</Label>
                <Input
                  id={ids.fecha}
                  name="on"
                  type="date"
                  required
                  defaultValue={hoy}
                  min={p.liquidarDesde}
                  max={hoy}
                />
              </div>
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor={ids.comision}>Comisión (opcional)</Label>
                <Input
                  id={ids.comision}
                  name="fee"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0,00"
                  className="tabular-nums"
                />
              </div>
            </div>
            <p className="text-[13px] leading-[18px] text-muted">
              La comisión de cancelación, si tu banco la cobra, se apunta como gasto.
            </p>
            <FieldError>{error}</FieldError>
            <DialogFooter>
              <Button variant="secondary" block onClick={() => ir("editar")} disabled={pending}>
                Volver
              </Button>
              <Button type="submit" block disabled={pending}>
                {pending ? "Liquidando…" : "Liquidar"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {paso === "cancelar" ? (
          <div className="flex flex-col gap-4">
            <p className="text-[15px] leading-5 text-fg lg:text-[14px]">
              Desde hoy no se cobrarán más cuotas de {p.name}. Lo ya apuntado se queda como está, y los{" "}
              {formatCents(p.pendienteCents)} pendientes siguen contando como deuda en tu patrimonio.
            </p>
            <p className="text-[13px] leading-[18px] text-muted">
              Es para cuando ya no quieres seguirlo aquí. Si lo has pagado entero, mejor «Liquidar»: deja la
              deuda a cero. No tiene vuelta atrás.
            </p>
            <FieldError>{error}</FieldError>
            <DialogFooter>
              <Button variant="secondary" block onClick={() => ir("editar")} disabled={pending}>
                Volver
              </Button>
              <Button
                variant="destructive"
                block
                disabled={pending}
                onClick={() => ejecutar(() => cancelLoan(p.id))}
              >
                {pending ? "Guardando…" : "Dejar de seguirlo"}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {paso === "eliminar" ? (
          <EliminarPrestamoPaso
            prestamo={{ id: p.id, name: p.name, activo: p.activo }}
            onVolver={() => ir("editar")}
            onCancelarEnSuLugar={() => ir("cancelar")}
            onEliminado={() => {
              cambiarApertura(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
