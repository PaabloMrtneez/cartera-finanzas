import { DonutAurora, type LineaCentro, type SectorDonut } from "@/components/ui/donut-aurora";
import { COLOR_OTROS, ESPECTRO_AURORA, MAX_SEGMENTOS } from "@/lib/aurora";
import { formatCents, formatPercent, formatShare, formatSignedDelta, percentChange } from "@/lib/money";

export type PosicionReparto = {
  position_id: string;
  name: string;
  value_cents: number;
  contributed_cents: number;
};

/** Lo aportado frente a lo que vale: «Aportado 1000,00 €» y «+234,00 € (+23,4 %)». */
function aportadoFrenteAValor(valor: number, aportado: number): LineaCentro[] {
  const ganancia = valor - aportado;
  const pct = percentChange(valor, aportado);
  return [
    { texto: `Aportado ${formatCents(aportado)}` },
    {
      texto: pct === null ? formatSignedDelta(ganancia) : `${formatSignedDelta(ganancia)} (${formatPercent(pct)})`,
      tono: ganancia > 0 ? "bien" : ganancia < 0 ? "mal" : "neutro",
    },
  ];
}

/**
 * El reparto de la cartera por posición, en el DONUT Aurora.
 *
 * Aquí el total importa —es lo que tienes invertido— y las partes son pocas: es
 * justo el caso del donut, con el total en el centro. Al tocar un sector, el
 * centro lo lee: lo que vale, su peso, y lo APORTADO frente a lo que vale, que
 * es la pregunta de una inversión. Debajo, la lista con su barra de peso.
 *
 * El color sale del espectro por POSICIÓN (no del color suelto de cada activo),
 * para que el reparto sea siempre el degradado de la firma. Caben todas: las
 * más grandes y una cola agrupada en «Otros», que también se lee.
 */
export function DonutPosiciones({ posiciones }: { posiciones: PosicionReparto[] }) {
  const positivos = posiciones.filter((p) => p.value_cents > 0);
  const total = positivos.reduce((suma, p) => suma + p.value_cents, 0);
  if (positivos.length === 0 || total <= 0) return null;
  const aportadoTotal = positivos.reduce((suma, p) => suma + p.contributed_cents, 0);

  // De mayor a menor, para que el espectro abra por la posición más grande y
  // «Otros» agrupe de verdad la cola pequeña.
  const orden = [...positivos].sort((a, b) => b.value_cents - a.value_cents);

  const sector = (
    id: string,
    nombre: string,
    color: string,
    valor: number,
    aportado: number,
  ): SectorDonut => {
    const share = formatShare((valor / total) * 100);
    return {
      id,
      nombre,
      color,
      valor,
      texto: formatCents(valor),
      share,
      lectura: {
        rotulo: nombre,
        cifra: formatCents(valor),
        lineas: [{ texto: `${share} de la cartera` }, ...aportadoFrenteAValor(valor, aportado)],
      },
    };
  };

  const visibles = orden.length <= MAX_SEGMENTOS ? orden : orden.slice(0, MAX_SEGMENTOS - 1);
  const resto = orden.length <= MAX_SEGMENTOS ? [] : orden.slice(MAX_SEGMENTOS - 1);
  const sectores = visibles.map((p, i) =>
    sector(p.position_id, p.name, ESPECTRO_AURORA[i], p.value_cents, p.contributed_cents),
  );
  if (resto.length > 0) {
    sectores.push(
      sector(
        "otros",
        `Otros · ${resto.length}`,
        COLOR_OTROS,
        resto.reduce((s, p) => s + p.value_cents, 0),
        resto.reduce((s, p) => s + p.contributed_cents, 0),
      ),
    );
  }

  const n = positivos.length;

  return (
    <DonutAurora
      sectores={sectores}
      etiquetaAccesible="Reparto de la cartera por posición."
      centro={{
        rotulo: `${n} ${n === 1 ? "posición" : "posiciones"}`,
        cifra: formatCents(total),
        lineas: aportadoFrenteAValor(total, aportadoTotal),
      }}
    />
  );
}
