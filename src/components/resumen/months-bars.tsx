"use client";

import { useState } from "react";
import { BarrasInteractivas } from "@/components/ui/barras-interactivas";
import { Segmented } from "@/components/ui/segmented";
import { monthShortLabel } from "@/lib/dates";
import { CIFRA_LECTURA, mediaEntera } from "@/lib/graficos";
import { formatCents, formatSignedDelta } from "@/lib/money";

export type Mes = {
  period_month: string;
  income_cents: number;
  net_expense_cents: number;
};

const MES_LARGO = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
const largo = (iso: string) => MES_LARGO.format(new Date(`${iso}T00:00:00Z`));

type Rango = "6" | "12";

/**
 * Los últimos meses: ingresos contra gasto neto, dos cápsulas por mes, en 6 o
 * 12 meses (`v_month_summary` trae trece; la página pasa doce).
 *
 * Las dos series comparten escala, que es el único modo de que la comparación
 * signifique algo, y el eje arranca en cero: son cantidades, no saldos. La
 * MEDIA del gasto neto —de los meses cerrados de la ventana— va en discontinua.
 *
 * Al tocar un mes, la cabecera da su BALANCE —lo que entró menos lo que se
 * gastó— y sus dos cifras.
 */
export function MonthsBars({ meses }: { meses: Mes[] }) {
  const [rango, setRango] = useState<Rango>("6");

  if (meses.length === 0) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        Aquí aparecerán los últimos meses en cuanto haya movimientos.
      </p>
    );
  }

  const ventana = meses.slice(-Number(rango));
  // La media sin el último mes, que puede estar a medias.
  const cerrados = ventana.length > 1 ? ventana.slice(0, -1) : ventana;
  const media = mediaEntera(cerrados.map((m) => m.net_expense_cents)) ?? 0;

  return (
    <div className="flex flex-col gap-4 px-4 pb-4 lg:px-5 lg:pb-5">
      <BarrasInteractivas
        key={rango}
        tamano="compacto"
        claseAlto="h-[140px] lg:h-[200px]"
        series={[
          { id: "ingresos", nombre: "Ingresos", color: "var(--income)" },
          { id: "gasto", nombre: "Gasto neto", color: "var(--expense)" },
        ]}
        marcada={ventana.length - 1}
        media={media > 0 ? { valor: media } : null}
        etiquetaAccesible="Ingresos contra gasto neto, mes a mes. Recórrelo con las flechas."
        barras={ventana.map((m) => {
          const balance = m.income_cents - m.net_expense_cents;
          return {
            clave: m.period_month,
            valores: [m.income_cents, m.net_expense_cents],
            eje: monthShortLabel(m.period_month).split(" ")[0],
            lectura: {
              rotulo: `Balance de ${largo(m.period_month)}`,
              cifra: formatSignedDelta(balance),
              detalle: `${formatCents(m.income_cents)} entraron, ${formatCents(m.net_expense_cents)} de gasto`,
              tono: balance > 0 ? "bien" : balance < 0 ? "mal" : "neutro",
            },
          };
        })}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            Gasto neto medio, {cerrados.length} {cerrados.length === 1 ? "mes" : "meses"}
          </span>
          <span className={CIFRA_LECTURA.compacto}>{formatCents(media)}</span>
          <span className="flex gap-4 text-[14px] leading-5 text-muted">
            <span className="inline-flex items-center gap-[6px]">
              <span className="size-[9px] rounded-full bg-income" aria-hidden />
              Ingresos
            </span>
            <span className="inline-flex items-center gap-[6px]">
              <span className="size-[9px] rounded-full bg-expense" aria-hidden />
              Gasto neto
            </span>
          </span>
        </div>
      </BarrasInteractivas>

      {meses.length > 6 ? (
        <Segmented
          label="Meses"
          value={rango}
          onChange={setRango}
          options={[
            { value: "6", label: "6 meses" },
            { value: "12", label: `${Math.min(meses.length, 12)} meses` },
          ]}
        />
      ) : null}
    </div>
  );
}
