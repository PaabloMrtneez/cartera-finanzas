import { BandaAurora, type SegmentoBanda } from "@/components/ui/banda-aurora";
import { COLOR_OTROS, ESPECTRO_AURORA, MAX_SEGMENTOS } from "@/lib/aurora";
import { formatCents, formatCentsRounded, formatShare } from "@/lib/money";

export type Trozo = {
  category_id: string | null;
  name: string;
  color: string;
  net_cents: number;
  share: number | null;
};

/**
 * El reparto del gasto por categoría, dibujado con la banda Aurora.
 *
 * Es el envoltorio de dominio: formatea los importes en el servidor (strings, que
 * sí cruzan a cliente) y le pasa a la banda genérica los segmentos ya hechos. La
 * banda pone la interactividad.
 *
 * Solo entran los trozos POSITIVOS. Una categoría puede quedar en negativo cuando
 * el reembolso supera al gasto; un trozo negativo no se puede dibujar como ancho.
 * Se saca del espectro y se cuenta en el pie, que es lo que hacía el donut.
 */
export function BandaCategorias({
  trozos,
  mes,
  mesIso,
}: {
  trozos: Trozo[];
  /** «septiembre», para los textos. */
  mes: string;
  /** «2026-09-01», para el enlace a los movimientos de cada categoría. */
  mesIso: string;
}) {
  const positivos = trozos.filter((t) => t.net_cents > 0);
  const negativos = trozos.filter((t) => t.net_cents < 0);
  const total = positivos.reduce((suma, t) => suma + t.net_cents, 0);

  if (positivos.length === 0) {
    return (
      <p className="text-[13px] leading-[18px] text-muted">
        {negativos.length > 0
          ? `En ${mes} los reembolsos superan a los gastos, así que no hay reparto que dibujar.`
          : `Todavía no hay gastos en ${mes}.`}
      </p>
    );
  }

  // De mayor a menor, para que el espectro abra por el trozo más grande y para
  // que «Otros» agrupe de verdad la cola pequeña.
  const orden = [...positivos].sort((a, b) => b.net_cents - a.net_cents);

  const comoSegmento = (t: Trozo, color: string): SegmentoBanda => ({
    id: t.category_id ?? "sin",
    nombre: t.name,
    color,
    valor: t.net_cents,
    texto: formatCents(t.net_cents),
    share: formatShare((t.net_cents / total) * 100),
    // Al tocar la categoría, la cabecera ofrece ir a sus movimientos del mes.
    href: `/movimientos?mes=${mesIso}&categoria=${t.category_id ?? "sin"}`,
  });

  // El color sale del espectro Aurora por POSICIÓN, no de `t.color` (el color
  // suelto de cada categoría): así la banda es siempre el degradado de la firma.
  //
  // CABEN TODAS aunque sean 15 o 20: la banda enseña las más grandes y agrupa el
  // resto en un «Otros» gris. Sin esto, una cola de categorías diminutas serían
  // astillas invisibles y la leyenda se iría a diez filas. «Otros» se puede tocar
  // como cualquier segmento: da su suma; el desglose fino vive en Análisis.
  let segmentos: SegmentoBanda[];
  if (orden.length <= MAX_SEGMENTOS) {
    segmentos = orden.map((t, i) => comoSegmento(t, ESPECTRO_AURORA[i]));
  } else {
    const visibles = orden.slice(0, MAX_SEGMENTOS - 1);
    const resto = orden.slice(MAX_SEGMENTOS - 1);
    const sumaResto = resto.reduce((suma, t) => suma + t.net_cents, 0);
    segmentos = visibles.map((t, i) => comoSegmento(t, ESPECTRO_AURORA[i]));
    segmentos.push({
      id: "otros",
      nombre: `Otros · ${resto.length}`,
      color: COLOR_OTROS,
      valor: sumaResto,
      texto: formatCents(sumaResto),
      share: formatShare((sumaResto / total) * 100),
    });
  }

  const nGrupos = positivos.length;

  return (
    <BandaAurora
      segmentos={segmentos}
      etiquetaAccesible={`Reparto del gasto de ${mes} por categoría. Recórrelo con las flechas.`}
      resumen={`${formatCentsRounded(total)} en ${nGrupos} ${nGrupos === 1 ? "grupo" : "grupos"}`}
      nota={
        negativos.length > 0 ? (
          <p className="text-[13px] leading-[18px] text-muted tabular-nums">
            {negativos.length === 1
              ? `${negativos[0].name} queda en ${formatCents(negativos[0].net_cents)} porque te devolvieron más de lo que gastaste, así que no entra en el reparto.`
              : `${negativos.length} categorías quedan en negativo por los reembolsos y no entran en el reparto.`}
          </p>
        ) : null
      }
    />
  );
}
