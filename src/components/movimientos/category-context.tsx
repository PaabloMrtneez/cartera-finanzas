import { BarrasInteractivas } from "@/components/ui/barras-interactivas";
import { monthShortLabel } from "@/lib/dates";
import { CIFRA_LECTURA, contraMedia, mediaEntera } from "@/lib/graficos";
import { formatCents, formatShare } from "@/lib/money";

export type MesCategoria = { period_month: string; cents: number };

const MES_LARGO = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
const largo = (iso: string) => MES_LARGO.format(new Date(`${iso}T00:00:00Z`));

/**
 * Un gasto, puesto en contexto.
 *
 * Un importe suelto no dice si 34 € es mucho. Con lo que llevas gastado en su
 * categoría este mes y los seis meses detrás, sí. El mes del movimiento va
 * MARCADO (los demás ceden) y la MEDIA de los meses anteriores, en discontinua,
 * dice de un vistazo si este mes va por encima. Al tocar un mes, la cabecera lo
 * lee contra esa media; tocarlo otra vez lleva a sus movimientos.
 *
 * El porcentaje se calcula sobre el gasto NETO de la categoría: si te
 * devolvieron parte, el peso de este gasto sube, que es lo correcto.
 */
export function CategoryContext({
  meses,
  categoria,
  categoriaId,
  mes,
  importe,
}: {
  meses: MesCategoria[];
  categoria: string;
  /** El id de la categoría, o null si el gasto no tiene: entonces, «sin». */
  categoriaId: string | null;
  mes: string;
  importe: number;
}) {
  const deEsteMes = meses[meses.length - 1]?.cents ?? 0;
  if (meses.length === 0 || deEsteMes <= 0) return null;

  const peso = (importe / deEsteMes) * 100;
  const media = meses.length > 1 ? mediaEntera(meses.slice(0, -1).map((m) => m.cents)) : null;
  const filtro = `categoria=${categoriaId ?? "sin"}`;
  const frenteALaMedia = (cents: number) => {
    if (media === null || media <= 0) return {};
    const c = contraMedia(cents, media);
    return { detalle: c.texto, tono: c.tono };
  };

  return (
    <div className="flex flex-col gap-3 px-4 pb-4 lg:px-5">
      <BarrasInteractivas
        tamano="compacto"
        claseAlto="h-[96px] lg:h-[120px]"
        marcada={meses.length - 1}
        media={media !== null && media > 0 ? { valor: media } : null}
        etiquetaAccesible={`Gasto en ${categoria}, mes a mes. Recórrelo con las flechas.`}
        barras={meses.map((m) => ({
          clave: m.period_month,
          valores: [m.cents],
          eje: monthShortLabel(m.period_month).split(" ")[0],
          href: `/movimientos?mes=${m.period_month}&${filtro}`,
          lectura: {
            rotulo: largo(m.period_month),
            cifra: formatCents(m.cents),
            ...frenteALaMedia(m.cents),
          },
        }))}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted first-letter:uppercase">
            {mes} en {categoria}
          </span>
          <span className={CIFRA_LECTURA.compacto}>{formatCents(deEsteMes)}</span>
          <span className="text-[14px] leading-5 text-muted tabular-nums">
            Este gasto es el {formatShare(peso)}
            {media !== null && media > 0
              ? `; el mes va ${deEsteMes > media ? "por encima" : "por debajo"} de la media`
              : ""}
          </span>
        </div>
      </BarrasInteractivas>
    </div>
  );
}
