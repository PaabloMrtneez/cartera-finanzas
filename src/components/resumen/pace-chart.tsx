import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { CIFRA_LECTURA, proyeccionLineal, type LecturaPunto } from "@/lib/graficos";
import { formatCents, formatSignedDelta } from "@/lib/money";

export type PuntoRitmo = {
  dia: number;
  actual_cents: number | null;
  anterior_cents: number;
};

const capitalizar = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Ritmo del mes: el gasto neto acumulado día a día, contra el mes anterior. Es
 * el gráfico HÉROE de Resumen: el trazo se dibuja al entrar y hoy es el punto
 * de oro.
 *
 * Es una curva acumulada, así que el eje SÍ arranca en cero —al contrario que
 * el de patrimonio—: aquí la pendiente es la velocidad a la que gastas, y
 * moverle el suelo la falsearía.
 *
 * La cabecera no repite lo gastado (eso es el héroe de la pantalla): da lo que
 * solo sabe este gráfico, cuánto vas por encima o por debajo del mes anterior
 * a estas alturas. Y al recorrer la curva lee ESA diferencia día a día.
 *
 * Los días que quedan llegan como null desde la base, y no como cero, para que
 * la línea no baje a plano y parezca que has dejado de gastar.
 *
 * LA PROYECCIÓN. En el mes en curso, y con base para extrapolar, de hoy a fin
 * de mes sale una discontinua en el cian del acento hasta el cierre previsto
 * (`month_forecast`: lo gastado, las suscripciones que faltan y el resto al
 * ritmo de ahora). Es una recta entre dos cifras ciertas —hoy y la previsión—,
 * no una curva inventada día a día. Al recorrerla, lee lo previsto.
 */
export function PaceChart({
  puntos,
  mesActual,
  mesAnterior,
  prevision = null,
}: {
  puntos: PuntoRitmo[];
  mesActual: string;
  mesAnterior: string;
  /** El cierre previsto en céntimos, solo en el mes en curso y con base. */
  prevision?: number | null;
}) {
  const conocidos = puntos.filter((p) => p.actual_cents !== null);

  if (conocidos.length === 0) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        Todavía no hay ningún gasto este mes. En cuanto apuntes el primero, aquí verás cómo va el
        ritmo comparado con {mesAnterior}.
      </p>
    );
  }

  const hoy = conocidos[conocidos.length - 1];
  const gastadoAhora = hoy.actual_cents ?? 0;
  const gastadoEntonces = hoy.anterior_cents;
  const diferencia = gastadoAhora - gastadoEntonces;
  const dias = puntos.length;
  const nDias = (n: number) => `${n} ${n === 1 ? "día" : "días"}`;

  // Días rotulados en el eje: el primero, el 10, el 20 y el último.
  const marcas = [1, 10, 20, dias].filter((d, i, a) => d <= dias && a.indexOf(d) === i);

  // La proyección: null hasta hoy, y de hoy al cierre previsto en recta.
  const iHoy = puntos.findIndex((p) => p.dia === hoy.dia);
  const quedan = puntos.length - 1 - iHoy;
  const proyectada =
    prevision !== null && quedan > 0
      ? [
          ...puntos.slice(0, iHoy).map(() => null),
          ...proyeccionLineal(gastadoAhora, Math.max(prevision, gastadoAhora), quedan),
        ]
      : null;

  const lecturas: LecturaPunto[] = puntos.map((p, i) => {
    const rotulo = `Día ${p.dia} de ${mesActual}`;
    if (p.actual_cents === null && proyectada && proyectada[i] !== null) {
      return {
        rotulo,
        cifra: `≈ ${formatCents(proyectada[i] as number)}`,
        detalle: `Previsto · ${mesAnterior}, ${formatCents(p.anterior_cents)}`,
        tono: "neutro",
      };
    }
    if (p.actual_cents === null) {
      return {
        rotulo,
        cifra: "—",
        detalle: `${capitalizar(mesAnterior)} llevaba ${formatCents(p.anterior_cents)}`,
        tono: "neutro",
      };
    }
    if (p.anterior_cents === 0) {
      return {
        rotulo,
        cifra: formatCents(p.actual_cents),
        detalle: `Gastado; ${mesAnterior} aún no llevaba nada`,
        tono: "neutro",
      };
    }
    const d = p.actual_cents - p.anterior_cents;
    return {
      rotulo,
      cifra: formatSignedDelta(d),
      detalle: `${formatCents(p.actual_cents)} frente a ${formatCents(p.anterior_cents)} de ${mesAnterior}`,
      // Gastar más que el mes anterior es lo malo.
      tono: d > 0 ? "mal" : d < 0 ? "bien" : "neutro",
    };
  });

  return (
    <div className="px-4 pb-4 lg:px-5 lg:pb-5">
      <LineaInteractiva
        heroe
        escala
        desdeCero
        altoBase={160}
        claseAlto="h-[160px] lg:h-[260px]"
        ejeX={puntos.map((p) => String(p.dia))}
        marcasX={marcas.map((d) => d - 1)}
        lecturas={lecturas}
        leyendaPrevia={`${capitalizar(mesAnterior)}, ese día`}
        leyendaProyeccion={proyectada ? "Hasta fin de mes, al ritmo de la previsión" : undefined}
        etiquetaAccesible={`Gasto acumulado de ${mesActual} frente a ${mesAnterior}. Recórrelo con las flechas.`}
        series={[
          {
            id: "actual",
            nombre: mesActual,
            valores: puntos.map((p) => p.actual_cents),
            textos: puntos.map((p) => (p.actual_cents === null ? "—" : formatCents(p.actual_cents))),
          },
          ...(proyectada
            ? [
                {
                  id: "prevision",
                  nombre: "Previsión",
                  proyeccion: true,
                  valores: proyectada,
                  textos: proyectada.map((v) => (v === null ? "—" : formatCents(v))),
                },
              ]
            : []),
          {
            id: "anterior",
            nombre: mesAnterior,
            previa: true,
            valores: puntos.map((p) => p.anterior_cents),
            textos: puntos.map((p) => formatCents(p.anterior_cents)),
          },
        ]}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            {gastadoEntonces > 0
              ? `Frente a ${mesAnterior}, a estas alturas`
              : `Llevas en ${nDias(hoy.dia)}`}
          </span>
          <span className={CIFRA_LECTURA.normal}>
            {gastadoEntonces > 0 ? formatSignedDelta(diferencia) : formatCents(gastadoAhora)}
          </span>
          <span className="text-[14px] leading-5 text-muted tabular-nums">
            {gastadoEntonces > 0
              ? `${formatCents(gastadoAhora)} en ${nDias(hoy.dia)}, frente a ${formatCents(gastadoEntonces)}`
              : `De ${mesAnterior} no hay nada con lo que comparar.`}
          </span>
        </div>
      </LineaInteractiva>
    </div>
  );
}
