import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { monthShortLabel } from "@/lib/dates";
import { lecturasNivel } from "@/lib/graficos";
import { formatCents, formatCentsRounded } from "@/lib/money";

/** Un punto de la curva: un cierre de mes («2026-08-01») o un día («2026-09-14»). */
export type Punto = { fecha: string; net_worth_cents: number };

export type Granularidad = "dia" | "mes";

const MES_LARGO = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
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

/** «agosto de 2026» o «14 de septiembre de 2026». */
export function rotuloLargo(iso: string, g: Granularidad): string {
  return (g === "dia" ? DIA_LARGO : MES_LARGO).format(fecha(iso));
}

/** «ago 26» (en el eje cabe el año sin comerse el sitio) o «14 sept». */
export function rotuloCorto(iso: string, g: Granularidad): string {
  if (g === "dia") return DIA_CORTO.format(fecha(iso)).replace(".", "");
  return monthShortLabel(iso).replace(/ \d\d(\d\d)$/, " $1");
}

/**
 * Evolución del patrimonio: el gráfico HÉROE de Patrimonio.
 *
 * El trazo se dibuja al entrar y el presente es el punto de oro. Lleva
 * escala y anotaciones (máximo, mínimo, hoy), porque es una curva de NIVEL: lo
 * que se pregunta es «¿cuándo tuve más?», y eso se responde sin tocar nada.
 *
 * LA LECTURA ES LA CIFRA DE LA LOSA. Al recorrer la curva no aparece otra
 * cifra encima: lee el propio patrimonio neto de arriba (`compartida`), que
 * pasa a dar el valor de ese punto y lo que ha cambiado desde el principio del
 * periodo. El periodo anterior, en discontinua, se lee en su leyenda.
 *
 * El eje NO arranca en cero a propósito: el patrimonio es un saldo acumulado, y
 * un eje desde cero aplastaría la curva contra el techo. La escala de la
 * derecha dice de dónde a dónde va, así que nadie lee mal la pendiente.
 *
 * Recibe puntos genéricos: los rangos 1M y 3M son DIARIOS (`net_worth_daily`)
 * y los demás mensuales; solo cambian los rótulos.
 */
export function NetWorthChart({
  puntos,
  previos,
  granularidad,
}: {
  puntos: Punto[];
  /** El periodo anterior, alineado por índice, o null si no hay tanta historia. */
  previos: number[] | null;
  granularidad: Granularidad;
}) {
  if (puntos.length < 2) {
    return (
      <p className="px-[18px] pb-4 text-[13px] leading-[18px] text-muted">
        Con un solo punto todavía no hay curva que dibujar. En cuanto pase otro mes, aquí verás cómo
        evoluciona.
      </p>
    );
  }

  const g = granularidad;
  const valores = puntos.map((p) => p.net_worth_cents);
  const primero = puntos[0];
  const ultimo = puntos[puntos.length - 1];
  const rotulos = puntos.map((p) => rotuloLargo(p.fecha, g));
  const n = puntos.length;
  // En diario, el eje rotula cuatro fechas repartidas; en mensual, tres.
  const marcasX =
    g === "dia" ? [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1] : undefined;

  return (
    <div className="px-[18px] pb-4">
      <LineaInteractiva
        heroe
        anotaciones
        compartida
        altoBase={200}
        claseAlto="h-[200px] lg:h-[280px]"
        ejeX={puntos.map((p) => rotuloCorto(p.fecha, g))}
        marcasX={marcasX}
        lecturas={lecturasNivel(valores, rotulos, {
          // En diario, «desde el 20 sept»: la fecha larga partía la línea en dos.
          desdeRotulo:
            g === "dia" ? `el ${rotuloCorto(primero.fecha, g)}` : rotuloLargo(primero.fecha, g),
        })}
        leyendaPrevia={
          previos
            ? g === "dia"
              ? "Periodo anterior, ese día"
              : "Periodo anterior, ese mes"
            : undefined
        }
        etiquetaAccesible={`Evolución del patrimonio desde ${rotuloLargo(primero.fecha, g)} hasta ${rotuloLargo(ultimo.fecha, g)}: de ${formatCentsRounded(primero.net_worth_cents)} a ${formatCentsRounded(ultimo.net_worth_cents)}. Recórrela con las flechas.`}
        series={[
          {
            id: "patrimonio",
            nombre: "Patrimonio",
            valores,
            textos: valores.map(formatCents),
          },
          ...(previos
            ? [
                {
                  id: "previo",
                  nombre: "Periodo anterior",
                  previa: true,
                  valores: previos,
                  textos: previos.map(formatCents),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
