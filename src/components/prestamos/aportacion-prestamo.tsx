"use client";

import { useId, useMemo, useState } from "react";
import { ConUnidad } from "@/components/prestamos/condiciones-prestamo";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { formatCents, formatCentsPlain, parseAmountToCents } from "@/lib/money";
import {
  CuadroInvalido,
  cuadroConAportaciones,
  efectoAportacion,
  planParaTerminar,
  type Aportacion,
  type EntradaCuadro,
  type ModoAportacion,
} from "@/lib/prestamos";
import { fechaCuota } from "@/lib/prestamos-vista";

/** Lo que la hoja sabe de un préstamo para calcular una aportación. */
export type DatosAportacion = {
  /** Las condiciones del contrato, para rehacer el cuadro igual que la base. */
  entrada: EntradaCuadro;
  /** Las aportaciones que ya hay, en el orden en que se hicieron. */
  aportaciones: Aportacion[];
  /** Cuotas ya cobradas (last_generated_period). */
  cobradas: number;
  /** Desde qué fecha se puede aportar: la última cuota cobrada o el inicio. */
  desde: string;
  /** La última aportación, si se puede deshacer todavía. */
  ultima: { id: string; importe: number; fecha: string } | null;
};

const MODOS: { valor: ModoAportacion; titulo: string; texto: string }[] = [
  {
    valor: "PLAZO",
    titulo: "Reducir plazo",
    texto: "La misma cuota y terminas antes. Es lo que más intereses ahorra.",
  },
  {
    valor: "CUOTA",
    titulo: "Reducir cuota",
    texto: "Terminas el mismo mes y pagas menos cada mes.",
  },
];

/**
 * La hoja «Aportación extra»: arriba, el simulador «quiero terminar en N
 * meses»; debajo, la aportación con su vista previa EN VIVO (antes → después).
 *
 * Todo se calcula con `src/lib/prestamos.ts`, el mismo cálculo que hace la base
 * (`loan_plan_aportaciones`, comparados al céntimo en
 * scripts/test-aportaciones.mjs): lo que se ve es lo que quedará en el cuadro.
 *
 * Los `name` son los de la server action: amount, on, mode, fee. El formulario
 * lo pone quien lo usa.
 */
export function AportacionPrestamo({
  datos,
  hoy,
  pending,
  onDeshacer,
}: {
  datos: DatosAportacion;
  hoy: string;
  pending: boolean;
  onDeshacer: (id: string) => void;
}) {
  const ids = { meses: useId(), importe: useId(), fecha: useId(), comision: useId() };
  const [importe, setImporte] = useState("");
  const [fecha, setFecha] = useState(hoy);
  const [modo, setModo] = useState<ModoAportacion>("PLAZO");
  const [comision, setComision] = useState("");
  const [meses, setMeses] = useState("");

  const cuadro = useMemo(() => {
    try {
      return cuadroConAportaciones(datos.entrada, datos.aportaciones);
    } catch {
      return null;
    }
  }, [datos.entrada, datos.aportaciones]);

  /**
   * Tras qué cuota se aplica: las vencidas hasta la fecha elegida, como hace
   * la base (genera antes lo vencido hasta esa fecha). Nunca menos que las ya
   * cobradas.
   */
  const despuesDe = (dia: string) =>
    Math.max(datos.cobradas, cuadro ? cuadro.filter((f) => f.fecha <= dia).length : datos.cobradas);
  const kHoy = despuesDe(hoy);
  const kFecha = despuesDe(fecha);
  const restantes = cuadro ? cuadro.filter((f) => f.periodo > kHoy).length : 0;

  const cents = parseAmountToCents(importe);
  const efecto = useMemo(() => {
    if (!cuadro || cents === null || cents <= 0) return null;
    try {
      return {
        ok: true as const,
        valor: efectoAportacion(datos.entrada, datos.aportaciones, { despuesDe: kFecha, importe: cents, modo }),
      };
    } catch (e) {
      if (e instanceof CuadroInvalido) {
        const todo = /paga todo lo que queda/.test(e.message);
        return {
          ok: false as const,
          error: todo ? "Eso es todo lo que queda o más: para pagarlo entero, usa «Pagar todo lo que queda»." : e.message,
        };
      }
      throw e;
    }
  }, [cuadro, cents, kFecha, modo, datos.entrada, datos.aportaciones]);

  const mesesN = /^\d{1,3}$/.test(meses.trim()) ? Number(meses.trim()) : null;
  const plan = useMemo(() => {
    if (!cuadro || mesesN === null) return null;
    return planParaTerminar(datos.entrada, datos.aportaciones, kHoy, mesesN);
  }, [cuadro, mesesN, kHoy, datos.entrada, datos.aportaciones]);

  const usar = (centimos: number) => {
    setImporte(formatCentsPlain(centimos));
    setModo("PLAZO");
    setFecha(hoy);
  };

  const comisionCents = comision.trim() === "" ? 0 : parseAmountToCents(comision);

  return (
    <div className="flex flex-col gap-5">
      {/* El simulador. */}
      <section aria-labelledby={`${ids.meses}-t`} className="flex flex-col gap-3 rounded-md bg-surface-2 p-4">
        <Eyebrow id={`${ids.meses}-t`}>Quiero terminar en…</Eyebrow>
        <div className="flex items-center gap-2">
          <Input
            id={ids.meses}
            inputMode="numeric"
            autoComplete="off"
            value={meses}
            onChange={(e) => setMeses(e.target.value)}
            placeholder={String(Math.max(1, Math.round(restantes / 2)))}
            className="w-24 bg-surface tabular-nums"
            aria-describedby={`${ids.meses}-ayuda`}
          />
          <Label htmlFor={ids.meses} className="text-[15px] font-normal text-fg">
            meses
          </Label>
        </div>
        <p id={`${ids.meses}-ayuda`} className="text-[13px] leading-[18px] text-muted">
          Ahora te {restantes === 1 ? "queda 1 cuota" : `quedan ${restantes} cuotas`}.
        </p>

        {mesesN !== null && plan ? (
          plan.mensual === null && plan.unica === null ? (
            <p className="text-[14px] leading-5 text-muted">
              {mesesN >= restantes
                ? `Ya terminas en ${restantes} ${restantes === 1 ? "cuota" : "cuotas"} o menos.`
                : "Con esos meses habría que pagarlo casi entero: mira «Pagar todo lo que queda»."}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {plan.mensual ? (
                <div className="flex flex-col gap-2 rounded-md bg-surface p-3 lg:flex-row lg:items-center lg:gap-4">
                  <p className="flex-1 text-[14px] leading-5">
                    <span className="font-semibold">Cada mes</span>: paga{" "}
                    <span className="font-semibold tabular-nums">{formatCents(plan.mensual.pagoMes)}</span> (
                    <span className="tabular-nums">{formatCents(plan.mensual.extra)}</span> más que ahora). Te
                    ahorras <span className="font-semibold tabular-nums">{formatCents(plan.mensual.ahorro)}</span> de
                    intereses.
                  </p>
                  <Button variant="secondary" size="compact" onClick={() => usar(plan.mensual!.extra)}>
                    Aportar {formatCents(plan.mensual.extra)} este mes
                  </Button>
                </div>
              ) : null}
              {plan.unica ? (
                <div className="flex flex-col gap-2 rounded-md bg-surface p-3 lg:flex-row lg:items-center lg:gap-4">
                  <p className="flex-1 text-[14px] leading-5">
                    <span className="font-semibold">Una vez, hoy</span>: aporta{" "}
                    <span className="font-semibold tabular-nums">{formatCents(plan.unica.importe)}</span> y sigue con tu
                    cuota. Te ahorras{" "}
                    <span className="font-semibold tabular-nums">{formatCents(plan.unica.ahorro)}</span>.
                  </p>
                  <Button variant="secondary" size="compact" onClick={() => usar(plan.unica!.importe)}>
                    Usar este importe
                  </Button>
                </div>
              ) : null}
            </div>
          )
        ) : null}
      </section>

      {/* La aportación. */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor={ids.importe}>Aportación</Label>
          <ConUnidad
            id={ids.importe}
            name="amount"
            unidad="€"
            inputMode="decimal"
            autoComplete="off"
            required
            value={importe}
            onChange={(e) => setImporte(e.target.value)}
            placeholder="500,00"
          />
        </div>
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor={ids.fecha}>Fecha</Label>
          <Input
            id={ids.fecha}
            name="on"
            type="date"
            required
            min={datos.desde}
            max={hoy}
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] leading-[18px] font-semibold text-muted">¿Qué prefieres?</legend>
        {MODOS.map((o) => (
          <label
            key={o.valor}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md bg-surface-2 p-3",
              "ring-accent has-checked:ring-[1.5px]",
            )}
          >
            <input
              type="radio"
              name="mode"
              value={o.valor}
              checked={modo === o.valor}
              onChange={() => setModo(o.valor)}
              className="mt-[2px] size-[18px] shrink-0 accent-accent"
            />
            <span className="flex flex-col gap-[2px]">
              <span className="text-[15px] leading-5 font-semibold">{o.titulo}</span>
              <span className="text-[13px] leading-[18px] text-muted">{o.texto}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-[6px]">
        <Label htmlFor={ids.comision}>Comisión o intereses del banco (opcional)</Label>
        <ConUnidad
          id={ids.comision}
          name="fee"
          unidad="€"
          inputMode="decimal"
          autoComplete="off"
          value={comision}
          onChange={(e) => setComision(e.target.value)}
          placeholder="0,00"
          aria-describedby={`${ids.comision}-ayuda`}
        />
        <p id={`${ids.comision}-ayuda`} className="text-[13px] leading-[18px] text-muted">
          Lo que te cobre el banco por adelantar capital, o los intereses de los días hasta la próxima
          cuota. Depende de tu contrato, y la ley le pone un tope. Se apunta como gasto.
        </p>
      </div>

      {/* La vista previa: antes → después. */}
      <section aria-label="Cómo queda el préstamo" className="flex flex-col gap-3 rounded-md bg-surface-2 p-4">
        <Eyebrow>Cómo queda</Eyebrow>
        {efecto === null ? (
          <p className="text-[14px] leading-5 text-muted">Escribe el importe para ver el efecto.</p>
        ) : !efecto.ok ? (
          <p className="flex items-start gap-2 text-[14px] leading-5 text-warning">
            <span className="mt-[2px] shrink-0">
              <Icon name="triangle-alert" size={16} />
            </span>
            {efecto.error}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-[13px] leading-[18px] font-semibold text-muted">Intereses que te ahorras</span>
              <span className="cifra text-[30px] leading-9 font-medium text-income" data-testid="ahorro-aportacion">
                {formatCents(efecto.valor.ahorro)}
              </span>
              {comisionCents ? (
                <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                  Pagando {formatCents(comisionCents)} de comisión: {formatCents(efecto.valor.ahorro - comisionCents)} netos.
                </span>
              ) : null}
            </div>
            <dl className="flex flex-col">
              {(
                [
                  ["Última cuota", fechaCuota(efecto.valor.finAntes), fechaCuota(efecto.valor.finDespues)],
                  ["Cuotas que quedan", String(efecto.valor.cuotasAntes), String(efecto.valor.cuotasDespues)],
                  ["Siguiente cuota", formatCents(efecto.valor.cuotaAntes), formatCents(efecto.valor.cuotaDespues)],
                  ["Intereses por pagar", formatCents(efecto.valor.interesesAntes), formatCents(efecto.valor.interesesDespues)],
                ] as const
              ).map(([rotulo, antes, despues]) => (
                <div
                  key={rotulo}
                  className="flex items-baseline justify-between gap-3 hair-t border-separator py-[7px] text-[14px] leading-5"
                >
                  <dt className="text-muted">{rotulo}</dt>
                  <dd className="text-right tabular-nums">
                    <span className="text-muted">{antes}</span>
                    {antes !== despues ? (
                      <>
                        {" → "}
                        <span className="font-semibold">{despues}</span>
                      </>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>

      {datos.ultima ? (
        <div className="flex flex-col gap-2 hair-t border-separator pt-4 lg:flex-row lg:items-center lg:gap-4">
          <p className="flex-1 text-[13px] leading-[18px] text-muted">
            La última aportación ({formatCents(datos.ultima.importe)} el {fechaCuota(datos.ultima.fecha)}) aún se
            puede deshacer: no se ha cobrado ninguna cuota desde entonces.
          </p>
          <BotonConfirmar
            variant="secondary"
            size="compact"
            confirmar="Sí, deshacerla"
            disabled={pending}
            className="text-expense"
            onConfirm={() => onDeshacer(datos.ultima!.id)}
          >
            Deshacer
          </BotonConfirmar>
        </div>
      ) : null}
    </div>
  );
}
