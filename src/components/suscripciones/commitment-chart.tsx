import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { monthLabel, monthShortLabel } from "@/lib/dates";
import {
  CIFRA_LECTURA,
  cambiosCompromiso,
  listaNombres,
  type FilaCompromiso,
  type LecturaPunto,
} from "@/lib/graficos";
import { formatSignedDelta, formatCents } from "@/lib/money";

export type PuntoCompromiso = {
  period_month: string;
  monthly_cents: number;
  cuantas: number;
};

const MES_LARGO = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const largo = (iso: string) => MES_LARGO.format(new Date(`${iso}T00:00:00Z`));

/** «entró Netflix · salió Spotify», o null si ese mes no cambió nada. */
function quienCambia(
  cambio: { entran: { nombre: string }[]; salen: { nombre: string }[] } | undefined,
): string | null {
  if (!cambio) return null;
  const partes: string[] = [];
  if (cambio.entran.length > 0) {
    partes.push(
      `${cambio.entran.length === 1 ? "entró" : "entraron"} ${listaNombres(cambio.entran.map((c) => c.nombre))}`,
    );
  }
  if (cambio.salen.length > 0) {
    partes.push(
      `${cambio.salen.length === 1 ? "salió" : "salieron"} ${listaNombres(cambio.salen.map((c) => c.nombre))}`,
    );
  }
  return partes.length > 0 ? partes.join(" · ") : null;
}

/**
 * Gastos fijos al mes, doce meses (el «compromiso»).
 *
 * Lo interesante no es el número de hoy —ese ya está arriba en grande— sino el
 * escalón: cuándo subió y POR QUÉ. Por eso la cabecera da el MAYOR salto y
 * quién lo explica, y al recorrer la curva lee cada mes: lo comprometido, lo
 * que cambió frente al mes anterior y QUÉ gasto fijo entró o salió
 * (`commitment_by_subscription`, comparando cada mes con el anterior). Las
 * anotaciones marcan el máximo, el mínimo y hoy.
 *
 * El eje arranca en cero: es una cantidad, no un saldo.
 */
export function CommitmentChart({
  puntos,
  suscripciones = [],
}: {
  puntos: PuntoCompromiso[];
  /** Las filas de `commitment_by_subscription`: quién cuenta cada mes. */
  suscripciones?: FilaCompromiso[];
}) {
  const conAlgo = puntos.filter((p) => p.monthly_cents > 0);
  if (conAlgo.length < 2) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        Con un solo mes todavía no hay curva. Aquí verás cómo sube y baja lo que sale fijo cada mes.
      </p>
    );
  }

  // El escalón más grande, que es lo que se quiere mirar.
  const saltos = puntos.slice(1).map((p, i) => ({
    mes: p.period_month,
    delta: p.monthly_cents - puntos[i].monthly_cents,
  }));
  const mayor = saltos.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a), {
    mes: "",
    delta: 0,
  });

  const cambios = cambiosCompromiso(suscripciones);
  const lecturas: LecturaPunto[] = puntos.map((p, i) => {
    const delta = i > 0 ? p.monthly_cents - puntos[i - 1].monthly_cents : 0;
    const activas = `${p.cuantas} ${p.cuantas === 1 ? "activo" : "activos"}`;
    const quien = quienCambia(cambios.get(p.period_month));
    return {
      rotulo: largo(p.period_month),
      cifra: formatCents(p.monthly_cents),
      detalle:
        quien && delta !== 0
          ? `${formatSignedDelta(delta)}: ${quien}`
          : i > 0 && delta !== 0
            ? `${activas} · ${formatSignedDelta(delta)} frente al mes anterior`
            : quien
              ? `${activas} · ${quien}`
              : activas,
      // Comprometer más es gastar más: subir es lo malo.
      tono: delta > 0 ? "mal" : delta < 0 ? "bien" : "neutro",
    };
  });

  return (
    <div className="flex flex-col gap-3 px-4 pb-4 lg:px-5">
      <LineaInteractiva
        anotaciones
        desdeCero
        tamano="compacto"
        altoBase={140}
        claseAlto="h-[140px] lg:h-[200px]"
        ejeX={puntos.map((p) => monthShortLabel(p.period_month).split(" ")[0])}
        lecturas={lecturas}
        etiquetaAccesible="Gastos fijos al mes de los últimos doce meses. Recórrelo con las flechas."
        series={[
          {
            id: "compromiso",
            nombre: "Al mes",
            valores: puntos.map((p) => p.monthly_cents),
            textos: [],
          },
        ]}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted first-letter:uppercase">
            {mayor.delta !== 0
              ? `Mayor cambio, en ${monthLabel(mayor.mes)}`
              : "Sin cambios en el año"}
          </span>
          <span className={CIFRA_LECTURA.compacto}>
            {mayor.delta !== 0
              ? formatSignedDelta(mayor.delta)
              : formatCents(puntos[puntos.length - 1].monthly_cents)}
          </span>
          <span className="text-[14px] leading-5 text-muted first-letter:uppercase">
            {(mayor.delta !== 0 ? quienCambia(cambios.get(mayor.mes)) : null) ??
              "Lo que sale fijo cada mes, sumados los activos."}
          </span>
        </div>
      </LineaInteractiva>
    </div>
  );
}
