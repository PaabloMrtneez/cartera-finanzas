import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { CIFRA_LECTURA, variacionImporte, type LecturaPunto } from "@/lib/graficos";
import { formatCents, formatPercent, formatSignedDelta, percentChange } from "@/lib/money";

export type PuntoCartera = {
  fecha: string;
  value_cents: number;
  cost_cents: number;
};

const DIA_LARGO = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const DIA_CORTO = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const fecha = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * Suma las posiciones fecha a fecha. `position_performance` ya da una fila por
 * posición y por CADA fecha de valoración del periodo (arrastrando la última
 * valoración conocida), así que sumar por fecha es exacto: enteros.
 */
export function carteraPorFecha(
  filas: { fecha: string; value_cents: number; cost_cents: number }[],
): PuntoCartera[] {
  const porFecha = new Map<string, PuntoCartera>();
  for (const f of filas) {
    const p = porFecha.get(f.fecha) ?? {
      fecha: f.fecha,
      value_cents: 0,
      cost_cents: 0,
    };
    p.value_cents += f.value_cents;
    p.cost_cents += f.cost_cents;
    porFecha.set(f.fecha, p);
  }
  return [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/**
 * APORTADO FRENTE A VALOR: el gráfico héroe de Inversiones.
 *
 * Dos curvas de la cartera entera: lo que VALE (el trazo del espectro) y lo
 * que has APORTADO de tu bolsillo (la discontinua). El hueco entre las dos es
 * la ganancia —en verde— o la pérdida —en rojo—, sombreado como una
 * superficie: «metí 6.500 y vale 6.980» se ve antes de leerlo.
 *
 * Lo aportado sube a escalones (cada aportación) y el valor se mueve con cada
 * valoración; por eso el eje no arranca en cero y lleva escala. Al recorrerla,
 * la cabecera lee el valor de ese día y cuánto estaba por encima o por debajo
 * de lo aportado; la leyenda, lo aportado hasta entonces.
 */
export function AportadoValor({ puntos, periodo }: { puntos: PuntoCartera[]; periodo: string }) {
  if (puntos.length < 2) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        Hacen falta dos valoraciones {periodo} para dibujar lo aportado frente a lo que vale. Se
        valora una vez al mes: prueba con un rango más largo.
      </p>
    );
  }

  const ultimo = puntos[puntos.length - 1];
  const diferencia = ultimo.value_cents - ultimo.cost_cents;
  const pct = percentChange(ultimo.value_cents, ultimo.cost_cents);

  const lecturas: LecturaPunto[] = puntos.map((p) => {
    const d = variacionImporte(p.cost_cents, p.value_cents);
    return {
      rotulo: DIA_LARGO.format(fecha(p.fecha)),
      cifra: formatCents(p.value_cents),
      detalle: p.cost_cents > 0 ? `${d.texto} sobre lo aportado` : "Sin aportaciones todavía",
      tono: d.tono,
    };
  });
  const n = puntos.length;

  return (
    <div className="px-4 pb-4 lg:px-5">
      <LineaInteractiva
        heroe
        escala
        sombrearEntre
        altoBase={180}
        claseAlto="h-[180px] lg:h-[240px]"
        ejeX={puntos.map((p) => DIA_CORTO.format(fecha(p.fecha)).replace(".", ""))}
        marcasX={n > 3 ? [0, Math.round((n - 1) / 2), n - 1] : undefined}
        lecturas={lecturas}
        tamano="compacto"
        leyendaPrevia="Aportado, esa fecha"
        etiquetaAccesible={`Valor de la cartera frente a lo aportado, ${periodo}.`}
        series={[
          {
            id: "valor",
            nombre: "Valor",
            valores: puntos.map((p) => p.value_cents),
            textos: puntos.map((p) => formatCents(p.value_cents)),
          },
          {
            id: "aportado",
            nombre: "Aportado",
            previa: true,
            valores: puntos.map((p) => p.cost_cents),
            textos: puntos.map((p) => formatCents(p.cost_cents)),
          },
        ]}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            {diferencia >= 0 ? "Por encima de lo aportado" : "Por debajo de lo aportado"}
          </span>
          <span
            className={`${CIFRA_LECTURA.compacto} ${diferencia > 0 ? "text-income" : diferencia < 0 ? "text-expense" : ""}`}
          >
            {formatSignedDelta(diferencia)}
          </span>
          <span className="text-[14px] leading-5 text-muted tabular-nums">
            {pct === null ? "Sin aportaciones" : formatPercent(pct)} en la última valoración,{" "}
            {DIA_CORTO.format(fecha(ultimo.fecha)).replace(".", "")}
          </span>
        </div>
      </LineaInteractiva>
    </div>
  );
}
