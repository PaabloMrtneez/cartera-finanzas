import { BarrasInteractivas } from "@/components/ui/barras-interactivas";
import { CIFRA_LECTURA } from "@/lib/graficos";
import { formatCents, formatSignedDelta } from "@/lib/money";

export type Anio = {
  anio: number;
  income_cents: number;
  net_expense_cents: number;
  saved_cents: number;
  en_curso: boolean;
};

/**
 * Cierre por año: lo que sumaste cada año, en barras que se tocan.
 *
 * Antes era una tabla solo para escritorio —cuatro columnas de cifras no caben
 * en un móvil sin encogerlas—. En barras cabe en las dos anchuras: la forma
 * dice qué año fue bueno, y al tocar uno la cabecera da sus tres cifras
 * (ingresos, gasto neto y lo sumado), que era lo que daba la tabla.
 *
 * El año en curso va marcado —y lo dice su lectura—, porque comparar doce meses
 * cerrados con ocho llevaría a la conclusión equivocada.
 */
export function YearlyClose({ anios }: { anios: Anio[] }) {
  if (anios.length === 0) return null;

  const enCurso = anios.findIndex((a) => a.en_curso);
  const cerrados = anios.filter((a) => !a.en_curso);
  const mejor = cerrados.length > 0 ? cerrados.reduce((a, b) => (b.saved_cents > a.saved_cents ? b : a)) : null;

  return (
    <div className="px-4 pb-4 lg:px-5">
      <BarrasInteractivas
        tamano="compacto"
        claseAlto="h-[120px] lg:h-[140px]"
        series={[{ id: "ahorro", nombre: "Ahorrado", color: "var(--income)" }]}
        colorNegativo="var(--expense)"
        marcada={enCurso >= 0 ? enCurso : null}
        etiquetaAccesible="Lo ahorrado cada año. Recórrelo con las flechas."
        barras={anios.map((a) => ({
          clave: String(a.anio),
          valores: [a.saved_cents],
          eje: String(a.anio),
          lectura: {
            rotulo: a.en_curso ? `${a.anio}, en curso` : String(a.anio),
            cifra: formatSignedDelta(a.saved_cents),
            detalle: `${formatCents(a.income_cents)} entraron, ${formatCents(a.net_expense_cents)} de gasto`,
            tono: a.saved_cents < 0 ? "mal" : a.saved_cents > 0 ? "bien" : "neutro",
          },
        }))}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            {mejor ? `Tu mejor año cerrado, ${mejor.anio}` : "Aún no hay ningún año cerrado"}
          </span>
          <span className={CIFRA_LECTURA.compacto}>
            {mejor ? formatSignedDelta(mejor.saved_cents) : "—"}
          </span>
          <span className="text-[14px] leading-5 text-muted">Toca un año para ver su cierre.</span>
        </div>
      </BarrasInteractivas>
    </div>
  );
}
