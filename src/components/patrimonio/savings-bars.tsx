import { AhorroConmutable } from "@/components/patrimonio/ahorro-conmutable";
import { BarrasInteractivas } from "@/components/ui/barras-interactivas";
import { monthLabel, monthShortLabel } from "@/lib/dates";
import { CIFRA_LECTURA, mediaEntera, tasaAgregada, tasaAhorro, textoTasa } from "@/lib/graficos";
import { formatCents, formatSignedDelta } from "@/lib/money";

export type MesAhorro = {
  period_month: string;
  income_cents: number;
  net_expense_cents: number;
  saved_cents: number;
};

const MES_LARGO = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const largo = (iso: string) => MES_LARGO.format(new Date(`${iso}T00:00:00Z`));
const eje = (iso: string) => monthShortLabel(iso).split(" ")[0];

/**
 * La barra de una tasa se dibuja entre −100 % y +100 %. Un mes con 10 € de
 * ingreso y 1.000 € de gasto da −9.900 %, y esa barra aplastaría al resto
 * hasta hacerlas invisibles. La GEOMETRÍA se recorta; la cifra que se lee al
 * tocarla sigue siendo la verdadera.
 */
const TOPE_TASA = 100;
const recortar = (v: number) => Math.min(Math.max(v, -TOPE_TASA), TOPE_TASA);

/**
 * Lo que sumas cada mes: ingresos menos gasto neto, en euros o en TASA DE
 * AHORRO (lo sumado entre lo que entró, `tasaAhorro`).
 *
 * Los meses en rojo se dibujan por DEBAJO de la línea del cero, no como una
 * barra corta. Un mes en el que gastaste más de lo que entró no es un mes malo
 * de ahorro: es un mes en el que el patrimonio bajó, y tiene que verse así.
 *
 * La MEDIA va en discontinua, con su rótulo en el canal de la derecha: la
 * pregunta de este gráfico es «¿este mes sumé más o menos de lo normal?». En
 * la tasa, la media es la del periodo PONDERADA (Σ sumado / Σ ingresado), no
 * la media de las tasas: un mes de 100 € no pesa lo que uno de 3.000 €.
 *
 * Los traspasos no aparecen por ningún lado: mueven dinero, no lo crean.
 */
export function SavingsBars({ meses }: { meses: MesAhorro[] }) {
  const conDatos = meses.filter((m) => m.income_cents !== 0 || m.net_expense_cents !== 0);
  if (conDatos.length === 0) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        Aquí verás cuánto sumas cada mes en cuanto haya movimientos.
      </p>
    );
  }

  const enRojo = conDatos.filter((m) => m.saved_cents < 0);
  const media = mediaEntera(conDatos.map((m) => m.saved_cents)) ?? 0;
  const tasaMedia = tasaAgregada(conDatos);
  const conIngreso = conDatos.filter((m) => m.income_cents > 0).length;

  const importe = (
    <BarrasInteractivas
      tamano="compacto"
      claseAlto="h-[132px] lg:h-[160px]"
      series={[{ id: "ahorro", nombre: "Lo que sumas", color: "var(--income)" }]}
      colorNegativo="var(--expense)"
      media={conDatos.length > 1 ? { valor: media } : null}
      etiquetaAccesible="Lo que sumas cada mes. Recórrelo con las flechas."
      barras={meses.map((m) => ({
        clave: m.period_month,
        valores: [m.saved_cents],
        eje: eje(m.period_month),
        lectura: {
          rotulo: largo(m.period_month),
          cifra: formatSignedDelta(m.saved_cents),
          detalle: `${formatCents(m.income_cents)} entraron, ${formatCents(m.net_expense_cents)} de gasto`,
          tono: m.saved_cents < 0 ? "mal" : m.saved_cents > 0 ? "bien" : "neutro",
        },
      }))}
    >
      <div className="flex flex-col gap-1">
        <span className="text-[13px] leading-[18px] font-semibold text-muted">De media al mes</span>
        <span className={CIFRA_LECTURA.compacto}>{formatSignedDelta(media)}</span>
        <span className="text-[14px] leading-5 text-muted tabular-nums first-letter:uppercase">
          {enRojo.length === 0
            ? "Ningún mes en rojo"
            : enRojo.length === 1
              ? `${monthLabel(enRojo[0].period_month)}, único mes en rojo`
              : `${enRojo.length} meses en rojo`}
        </span>
      </div>
    </BarrasInteractivas>
  );

  const tasa =
    conIngreso === 0 ? (
      <p className="text-[13px] leading-[18px] text-muted">
        Sin ingresos en estos meses no hay tasa que calcular: es lo sumado entre lo que entra. En
        cuanto entre el primero, aquí verás qué parte guardas.
      </p>
    ) : (
      <BarrasInteractivas
        tamano="compacto"
        claseAlto="h-[132px] lg:h-[160px]"
        series={[{ id: "tasa", nombre: "Tasa de ahorro", color: "var(--income)" }]}
        colorNegativo="var(--expense)"
        media={tasaMedia !== null && conIngreso > 1 ? { valor: recortar(tasaMedia) } : null}
        etiquetaAccesible="Tasa de ahorro de cada mes: lo sumado entre lo que entró. Recórrelo con las flechas."
        barras={meses.map((m) => {
          const t = tasaAhorro(m.saved_cents, m.income_cents);
          return {
            clave: m.period_month,
            valores: [t === null ? 0 : recortar(t)],
            eje: eje(m.period_month),
            lectura: {
              rotulo: largo(m.period_month),
              cifra: textoTasa(t),
              detalle:
                t === null
                  ? "Sin ingresos ese mes: no hay tasa"
                  : `${formatSignedDelta(m.saved_cents)} de ${formatCents(m.income_cents)} que entraron`,
              tono: t === null ? "neutro" : t < 0 ? "mal" : t > 0 ? "bien" : "neutro",
            },
          };
        })}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            Tasa del periodo
          </span>
          <span className={CIFRA_LECTURA.compacto}>{textoTasa(tasaMedia)}</span>
          <span className="text-[14px] leading-5 text-muted tabular-nums">
            {tasaMedia === null
              ? "Sin ingresos no hay tasa que calcular."
              : tasaMedia >= 0
                ? `De cada 100 € que entran, guardas ${Math.round(tasaMedia)} €`
                : "Has gastado más de lo que ha entrado."}
          </span>
        </div>
      </BarrasInteractivas>
    );

  return (
    <div className="flex flex-col gap-3 pb-4">
      <AhorroConmutable>
        <div data-panel="importe" className="px-4 lg:px-5">
          {importe}
        </div>
        <div data-panel="tasa" className="px-4 lg:px-5">
          {tasa}
        </div>
      </AhorroConmutable>
      <p className="px-4 text-[13px] leading-[18px] text-muted lg:px-5">
        Ingresos menos gasto neto. Los traspasos no cuentan: mueven, no crean.
      </p>
    </div>
  );
}
