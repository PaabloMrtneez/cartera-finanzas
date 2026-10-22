import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { cn } from "@/lib/cn";
import { shortDate } from "@/lib/dates";
import { CIFRA_LECTURA, type LecturaPunto } from "@/lib/graficos";
import { formatCents, formatPercent } from "@/lib/money";

export type PuntoRendimiento = {
  position_id: string;
  name: string;
  color: string;
  fecha: string;
  value_cents: number;
  cost_cents: number;
  return_pct: number | null;
};

/**
 * Rendimiento acumulado de UNA posición, en porcentaje.
 *
 * En porcentaje y no en euros: es lo que permite comparar una posición de 500 €
 * con otra de 5.000 tarjeta con tarjeta. La línea del 0 % va más marcada: es la
 * frontera entre ganar y perder, y es lo primero que se busca.
 *
 * Es una curva de nivel, así que lleva escala y anotaciones (máximo, mínimo y
 * hoy). La cabecera da el rendimiento del periodo y, al recorrer la curva, lee
 * cada valoración: el porcentaje, lo que valía y lo aportado hasta entonces.
 *
 * El porcentaje viene calculado sobre el coste aportado hasta cada fecha, así
 * que meter dinero nuevo no aparece como si hubiera rendido.
 */
export function PerformanceChart({
  puntos,
  periodo,
  rendimiento,
  sincronizada = false,
}: {
  puntos: PuntoRendimiento[];
  /** «en los últimos 3 meses», para la cabecera y el pie. */
  periodo?: string;
  /** El rendimiento del periodo (`position_return`), o null si no hay base. */
  rendimiento: number | null;
  /** Sigue una cotización: la curva es diaria, no de valoraciones mensuales. */
  sincronizada?: boolean;
}) {
  const validos = puntos
    .filter((p) => p.return_pct !== null)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const cabecera = (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] leading-[18px] font-semibold text-muted first-letter:uppercase">
        Rendimiento {periodo ?? ""}
      </span>
      <span
        className={cn(
          CIFRA_LECTURA.compacto,
          rendimiento === null ? "text-muted" : rendimiento >= 0 ? "text-income" : "text-expense",
        )}
      >
        {formatPercent(rendimiento)}
      </span>
      <span className="text-[14px] leading-5 text-muted">
        {validos.length > 0
          ? `Vale ${formatCents(validos[validos.length - 1].value_cents)} · aportado ${formatCents(validos[validos.length - 1].cost_cents)}`
          : "Sin valoraciones en el periodo"}
      </span>
    </div>
  );

  if (validos.length < 2) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 lg:px-5">
        {cabecera}
        <p className="text-[13px] leading-[18px] text-muted">
          {sincronizada
            ? "La curva se dibuja con el precio de cada día: en cuanto lleguen dos, aparece."
            : `Con una sola valoración no hay curva que dibujar${periodo ? ` ${periodo}` : ""}. Se valora una vez al mes, así que en periodos cortos puede que todavía no haya dos con las que comparar: prueba con un rango más largo.`}
        </p>
      </div>
    );
  }

  const valores = validos.map((p) => Number(p.return_pct));
  const lecturas: LecturaPunto[] = validos.map((p) => {
    const pct = Number(p.return_pct);
    return {
      rotulo: shortDate(p.fecha),
      cifra: formatPercent(pct),
      detalle: `Vale ${formatCents(p.value_cents)} · aportado ${formatCents(p.cost_cents)}`,
      tono: pct > 0 ? "bien" : pct < 0 ? "mal" : "neutro",
    };
  });

  return (
    <div className="flex flex-col gap-3 px-4 pb-4 lg:px-5">
      <LineaInteractiva
        anotaciones
        incluirCero
        formato="porcentaje"
        tamano="compacto"
        altoBase={140}
        claseAlto="h-[140px] lg:h-[220px]"
        ejeX={validos.map((p) => shortDate(p.fecha))}
        lecturas={lecturas}
        etiquetaAccesible={`Rendimiento acumulado de ${validos[0].name}. Recórrelo con las flechas.`}
        series={[{ id: validos[0].position_id, nombre: validos[0].name, valores, textos: [] }]}
      >
        {cabecera}
      </LineaInteractiva>

      <p className="text-[13px] leading-[18px] text-muted">
        Acumulado en porcentaje{periodo ? ` ${periodo}` : ""}, con base 0 % al principio del
        periodo. Las aportaciones se descuentan: meter dinero no cuenta como ganar.
      </p>
    </div>
  );
}
