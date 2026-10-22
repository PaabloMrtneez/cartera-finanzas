import { BarrasInteractivas } from "@/components/ui/barras-interactivas";
import { monthShortLabel, monthStart, todayIso } from "@/lib/dates";
import { CIFRA_LECTURA } from "@/lib/graficos";
import { formatCents } from "@/lib/money";

export type MesSinClasificar = { period_month: string; cuantos: number; cents: number };

const MES_LARGO = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
const largo = (iso: string) => MES_LARGO.format(new Date(`${iso}T00:00:00Z`));

/**
 * Sin clasificar, mes a mes.
 *
 * No es una cifra más: es un mapa de dónde falta trabajo. Al tocar un mes la
 * cabecera lo lee, y tocarlo otra vez FILTRA el listado de debajo a los sin
 * clasificar de ese mes: del mapa al trabajo en dos toques. Los meses con más
 * cola son a los que les faltan reglas de comercio.
 */
export function UnclassifiedBars({ meses }: { meses: MesSinClasificar[] }) {
  const total = meses.reduce((suma, m) => suma + m.cuantos, 0);
  if (total === 0) return null;

  const actual = monthStart(todayIso());
  const peor = meses.reduce((a, b) => (b.cuantos > a.cuantos ? b : a));
  const marcada = meses.findIndex((m) => m.period_month === actual);

  return (
    <div className="flex flex-col gap-3 px-4 pb-4 lg:px-5">
      <BarrasInteractivas
        tamano="compacto"
        claseAlto="h-[88px] lg:h-[104px]"
        series={[{ id: "cola", nombre: "Sin clasificar", color: "var(--uncat)" }]}
        marcada={marcada >= 0 ? marcada : null}
        enlace="Ver los de ese mes"
        etiquetaAccesible="Movimientos sin clasificar, mes a mes. Recórrelo con las flechas."
        barras={meses.map((m) => ({
          clave: m.period_month,
          valores: [m.cuantos],
          eje: monthShortLabel(m.period_month).split(" ")[0],
          href: m.cuantos > 0 ? `/movimientos?mes=${m.period_month}&categoria=sin` : undefined,
          lectura: {
            rotulo: largo(m.period_month),
            cifra: `${m.cuantos} sin clasificar`,
            detalle: m.cuantos > 0 ? formatCents(m.cents) : "Todo clasificado",
            tono: "neutro",
          },
        }))}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            En los últimos {meses.length} meses
          </span>
          <span className={CIFRA_LECTURA.compacto}>{total} sin clasificar</span>
          <span className="text-[14px] leading-5 text-muted tabular-nums">
            {peor.cuantos > 0 && peor.period_month !== actual
              ? `El mes con más cola es ${monthShortLabel(peor.period_month)}, con ${peor.cuantos}.`
              : "Toca un mes para ver los suyos."}
          </span>
        </div>
      </BarrasInteractivas>
      <p className="text-[13px] leading-[18px] text-muted">
        Los meses con más cola son a los que les faltan reglas de comercio.
      </p>
    </div>
  );
}
