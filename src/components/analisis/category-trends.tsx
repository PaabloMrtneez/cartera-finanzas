import { BarrasInteractivas, type BarraDato } from "@/components/ui/barras-interactivas";
import { Icon } from "@/components/ui/icon";
import { monthShortLabel } from "@/lib/dates";
import { CIFRA_LECTURA, contraMedia, mediaEntera } from "@/lib/graficos";
import { formatCents } from "@/lib/money";

export type FilaTendencia = {
  category_id: string | null;
  name: string;
  color: string;
  icon: string;
  period_month: string;
  net_cents: number;
};

const MES_LARGO = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const MES_SOLO = new Intl.DateTimeFormat("es-ES", { month: "long", timeZone: "UTC" });
const fecha = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Cuántas categorías se muestran: las de más gasto en la ventana. */
const TOPE = 6;

type Grupo = {
  key: string;
  name: string;
  color: string;
  icon: string;
  puntos: { period_month: string; net_cents: number }[];
  total: number;
};

/**
 * Tendencia por categoría: la miniserie de gasto de cada categoría en la que más
 * gastas, para pillar de un vistazo las que se van creciendo. El mes en curso va
 * marcado y la MEDIA de los meses cerrados, en discontinua, dice si se dispara.
 *
 * Al tocar un mes, la cifra de la fila pasa a ser la suya (contra la media); y
 * tocarlo otra vez lleva a los movimientos de esa categoría en ese mes. Con poco
 * histórico salen pocas barras; se llenan solas.
 */
export function CategoryTrends({ filas }: { filas: FilaTendencia[] }) {
  // Agrupar por categoría conservando el orden mensual (las filas ya vienen
  // ordenadas por categoría y mes desde `category_trend`).
  const grupos = new Map<string, Grupo>();
  for (const f of filas) {
    const key = f.category_id ?? "sin";
    let g = grupos.get(key);
    if (!g) {
      g = {
        key,
        name: f.name,
        color: f.color,
        icon: f.icon,
        puntos: [],
        total: 0,
      };
      grupos.set(key, g);
    }
    g.puntos.push({ period_month: f.period_month, net_cents: f.net_cents });
    g.total += f.net_cents;
  }

  const orden = [...grupos.values()].sort((a, b) => b.total - a.total).slice(0, TOPE);
  const mesesConGasto = orden[0]?.puntos.length ?? 0;

  return (
    // Múltiplos pequeños: en móvil, uno debajo de otro; en escritorio, una
    // rejilla de tres para comparar formas de un vistazo. Es la misma lista con
    // otra disposición, no otro markup.
    <ul className="lg:grid lg:grid-cols-3 lg:gap-x-8 lg:px-5">
      {orden.map((g) => {
        const ultimo = g.puntos[g.puntos.length - 1];
        // La media de los meses CERRADOS: el mes en curso todavía se está
        // gastando, y contarlo la bajaría.
        const media =
          g.puntos.length > 1 ? mediaEntera(g.puntos.slice(0, -1).map((p) => p.net_cents)) : null;
        const filtro = `categoria=${g.key}`;
        const barras: BarraDato[] = g.puntos.map((p, i) => {
          // El último es el mes EN CURSO (`category_trend` acaba en el mes de
          // hoy). Compararlo con la media de meses enteros solo es honesto si
          // ya la ha pasado: el día 7, «40 € bajo la media» suena a buena
          // noticia y no lo es todavía. Por debajo, se dice la media y ya.
          const enCurso = i === g.puntos.length - 1;
          const conMedia = media !== null && media > 0;
          const frente =
            !conMedia
              ? null
              : enCurso && p.net_cents <= media
                ? { texto: `De media, ${formatCents(media)}`, tono: "neutro" as const }
                : contraMedia(p.net_cents, media);
          const largo = MES_LARGO.format(fecha(p.period_month));
          // El en curso, sin el año: el rótulo de la fila comparte renglón con
          // el nombre de la categoría y no debe comérselo.
          const rotulo = enCurso ? `${MES_SOLO.format(fecha(p.period_month))}, en curso` : largo;
          return {
            clave: p.period_month,
            valores: [p.net_cents],
            // «sep» y no el «sept» de Intl: el mismo rótulo que el resto de
            // gráficos de meses, y un carácter menos en una celda estrecha.
            eje: monthShortLabel(p.period_month).split(" ")[0],
            href: `/movimientos?mes=${p.period_month}&${filtro}`,
            lectura: {
              rotulo,
              cifra: formatCents(p.net_cents),
              detalle: frente?.texto,
              tono: frente?.tono,
            },
          };
        });

        // El color de la categoría se queda en el medallón, que es donde la
        // identifica. Las barras van en el acento, con el mes en curso marcado:
        // una sola voz por gráfico.
        const inicio = (
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <span
              className="flex size-[30px] shrink-0 items-center justify-center rounded-full"
              style={{
                background: `color-mix(in srgb, ${g.color} 16%, transparent)`,
                color: g.color,
              }}
            >
              <Icon name={g.icon} size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{g.name}</span>
          </span>
        );

        return (
          <li
            key={g.key}
            className="flex flex-col gap-3 hair-t border-separator px-4 py-4 lg:px-0 lg:py-5"
          >
            {mesesConGasto > 1 ? (
              <BarrasInteractivas
                tamano="fila"
                inicio={inicio}
                claseAlto="h-[64px] lg:h-[72px]"
                marcada={barras.length - 1}
                media={media !== null && media > 0 ? { valor: media } : null}
                barras={barras}
                etiquetaAccesible={`Gasto en ${g.name}, mes a mes. Recórrelo con las flechas.`}
              >
                <span className={CIFRA_LECTURA.fila}>{formatCents(ultimo?.net_cents ?? 0)}</span>
                <span className="block text-[13px] leading-[18px] text-muted">Este mes</span>
              </BarrasInteractivas>
            ) : (
              <div className="flex items-center gap-3">
                {inicio}
                <span className={CIFRA_LECTURA.fila}>{formatCents(ultimo?.net_cents ?? 0)}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
