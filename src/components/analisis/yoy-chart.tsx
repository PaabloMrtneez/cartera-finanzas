"use client";

import { useState } from "react";
import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { CIFRA_LECTURA, type LecturaPunto } from "@/lib/graficos";
import { formatCents, formatPercent, formatSignedDelta, percentChange } from "@/lib/money";

export type PuntoYoY = {
  period_month: string;
  net_expense_cents: number | null;
  prev_net_expense_cents: number | null;
  income_cents: number | null;
  prev_income_cents: number | null;
};

type Modo = "gasto" | "ingreso";

const MES_CORTO = new Intl.DateTimeFormat("es-ES", { month: "short", timeZone: "UTC" });
const MES_LARGO = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
const fecha = (iso: string) => new Date(`${iso}T00:00:00Z`);
const corto = (iso: string) => MES_CORTO.format(fecha(iso)).replace(".", "");
const largo = (iso: string) => MES_LARGO.format(fecha(iso));

/** El mismo mes, un año antes: «2026-09-01» → «2025-09-01». */
const restarAnio = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;

const MODOS = {
  gasto: {
    actual: (p: PuntoYoY) => p.net_expense_cents,
    previo: (p: PuntoYoY) => p.prev_net_expense_cents,
    nombre: "gasto neto",
    // En el gasto, subir es lo malo; en los ingresos, lo bueno.
    subirEsBueno: false,
  },
  ingreso: {
    actual: (p: PuntoYoY) => p.income_cents,
    previo: (p: PuntoYoY) => p.prev_income_cents,
    nombre: "ingresos",
    subirEsBueno: true,
  },
} as const;

/**
 * Año a año: cada mes contra el mismo mes del año pasado, en gasto o en
 * ingresos (`year_over_year` trae los dos).
 *
 * La línea de este año va con el espectro; la del año pasado, discontinua y
 * apagada, sobre la MISMA escala —comparar dos curvas con ejes distintos no
 * compara nada—. La cabecera da lo que solo sabe este gráfico: cuánto cambia el
 * mes en curso frente al del año pasado. Y al recorrer la curva, lee la
 * DIFERENCIA de cada mes con el suyo de hace un año.
 *
 * Un mes sin ningún movimiento llega como null y corta la línea, en vez de bajar
 * a cero: con poco histórico, una línea plana en cero parecería que dejaste de
 * gastar meses que en realidad no registraste.
 */
export function YoyChart({ puntos }: { puntos: PuntoYoY[] }) {
  const [modo, setModo] = useState<Modo>("gasto");
  const m = MODOS[modo];
  const conActual = puntos.filter((p) => m.actual(p) !== null);

  const selector = (
    <Segmented
      label="Qué comparar"
      value={modo}
      onChange={setModo}
      options={[
        { value: "gasto", label: "Gasto" },
        { value: "ingreso", label: "Ingresos" },
      ]}
    />
  );

  if (puntos.length === 0 || conActual.length === 0) {
    return (
      <div className="flex flex-col gap-4 px-4 pb-4 lg:px-5 lg:pb-5">
        <p className="text-[13px] leading-[18px] text-muted">
          Todavía no hay {m.nombre} en estos meses. La tendencia aparece en cuanto empieces a
          apuntar, y la comparación con el año pasado, cuando haya un año por detrás.
        </p>
        {puntos.length > 0 ? selector : null}
      </div>
    );
  }

  const tonoDe = (delta: number) =>
    delta === 0 ? ("neutro" as const) : delta > 0 === m.subirEsBueno ? ("bien" as const) : ("mal" as const);

  const lecturas: LecturaPunto[] = puntos.map((p) => {
    const actual = m.actual(p);
    const previo = m.previo(p);
    if (actual === null) {
      return { rotulo: largo(p.period_month), cifra: "—", detalle: "Sin movimientos ese mes", tono: "neutro" };
    }
    if (previo === null || previo === 0) {
      return {
        rotulo: largo(p.period_month),
        cifra: formatCents(actual),
        detalle: `Sin dato de ${largo(restarAnio(p.period_month))}`,
        tono: "neutro",
      };
    }
    const delta = actual - previo;
    return {
      rotulo: largo(p.period_month),
      cifra: formatCents(actual),
      detalle: `${formatSignedDelta(delta)} (${formatPercent(percentChange(actual, previo), 0)}) frente a ${largo(restarAnio(p.period_month))}`,
      tono: tonoDe(delta),
    };
  });

  // El titular sale del último mes de la ventana (el mes en curso).
  const ultimo = puntos[puntos.length - 1];
  const actual = m.actual(ultimo);
  const anterior = m.previo(ultimo);
  const delta = actual !== null && anterior !== null ? percentChange(actual, anterior) : null;

  return (
    <div className="flex flex-col gap-4 px-4 pb-4 lg:px-5 lg:pb-5">
      <LineaInteractiva
        escala
        desdeCero
        altoBase={150}
        claseAlto="h-[150px] lg:h-[240px]"
        ejeX={puntos.map((p) => corto(p.period_month))}
        lecturas={lecturas}
        leyendaPrevia="Año pasado, ese mes"
        etiquetaAccesible={`${modo === "gasto" ? "Gasto neto" : "Ingresos"} de los últimos doce meses frente al mismo mes del año anterior. Recórrelo con las flechas.`}
        series={[
          {
            id: "actual",
            nombre: "Este año",
            valores: puntos.map(m.actual),
            textos: puntos.map((p) => {
              const v = m.actual(p);
              return v === null ? "—" : formatCents(v);
            }),
          },
          {
            id: "anterior",
            nombre: "Año pasado",
            previa: true,
            valores: puntos.map(m.previo),
            textos: puntos.map((p) => {
              const v = m.previo(p);
              return v === null ? "—" : formatCents(v);
            }),
          },
        ]}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted first-letter:uppercase">
            {largo(ultimo.period_month)} frente a {largo(restarAnio(ultimo.period_month))}
          </span>
          <span
            className={cn(
              CIFRA_LECTURA.normal,
              delta === null ? "text-muted" : undefined,
            )}
          >
            {delta === null ? "—" : formatPercent(delta, 0)}
          </span>
          <span className="text-[14px] leading-5 text-muted tabular-nums">
            {actual === null
              ? `Este mes aún no hay ${m.nombre}.`
              : anterior === null || anterior === 0
                ? `Llevas ${formatCents(actual)}; del año pasado no hay con qué comparar.`
                : `${formatCents(actual)} contra ${formatCents(anterior)}`}
          </span>
        </div>
      </LineaInteractiva>
      {selector}
    </div>
  );
}
