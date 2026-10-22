import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { monthShortLabel, monthStart, shiftMonth } from "@/lib/dates";
import { CIFRA_LECTURA, proyeccionLineal, type LecturaPunto } from "@/lib/graficos";
import { formatCents, formatShare } from "@/lib/money";
import { mesesEntre } from "@/lib/rangos";

export type Proyeccion = {
  target_cents: number;
  saved_cents: number;
  deadline: string | null;
  ritmo_cents: number;
  meses_para_meta: number | null;
  fecha_estimada: string | null;
  necesario_mensual_cents: number | null;
};

export type ValorMes = { period_month: string; worth_cents: number };

/** Más allá de esto la recta no se dibuja entera: tres años son ya una línea casi plana. */
const HORIZONTE = 36;

const MES_LARGO = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const largo = (iso: string) => MES_LARGO.format(new Date(`${iso}T00:00:00Z`));
const corto = (iso: string) => monthShortLabel(iso).replace(/ \d\d(\d\d)$/, " $1");

/**
 * HACIA LA META: lo que ha valido la cuenta estos meses (el trazo) y, de hoy
 * en adelante, una discontinua en el cian del acento hasta el objetivo, al
 * ritmo de los últimos meses (`savings_goal_projection`). El objetivo es una
 * guía de oro; donde la discontinua la toca es cuándo llegarías.
 *
 * Es una recta entre dos cifras de la base —lo que tienes hoy y el objetivo en
 * la fecha estimada—, no una predicción inventada mes a mes. Si la cuenta no
 * crece, no hay recta: la cabecera lo dice.
 */
export function ProyeccionMeta({
  historia,
  proyeccion: p,
  hoy,
}: {
  historia: ValorMes[];
  proyeccion: Proyeccion;
  hoy: string;
}) {
  const mesHoy = monthStart(hoy);
  // El pasado, sin el mes en curso: su punto es lo que hay HOY (la barra).
  const pasado = historia
    .filter((h) => h.period_month < mesHoy)
    .sort((a, b) => a.period_month.localeCompare(b.period_month));
  const llega = p.meses_para_meta !== null && p.fecha_estimada !== null && p.ritmo_cents > 0;
  const mesesHasta = llega
    ? Math.max(mesesEntre(mesHoy, monthStart(p.fecha_estimada as string)) - 1, 1)
    : 0;
  const mesesLimite = p.deadline ? Math.max(mesesEntre(mesHoy, monthStart(p.deadline)) - 1, 0) : 0;
  const adelante = Math.min(Math.max(llega ? mesesHasta : 0, mesesLimite, 3), HORIZONTE);

  const meses = [
    ...pasado.map((h) => h.period_month),
    mesHoy,
    ...Array.from({ length: adelante }, (_, k) => shiftMonth(mesHoy, k + 1)),
  ];
  if (meses.length < 2) return null;
  const iHoy = pasado.length;

  const real: (number | null)[] = [
    ...pasado.map((h) => h.worth_cents),
    p.saved_cents,
    ...Array(adelante).fill(null),
  ];
  // La recta de hoy al objetivo; si cae más allá del horizonte, se corta en él.
  const recta = llega ? proyeccionLineal(p.saved_cents, p.target_cents, mesesHasta) : [];
  const proyectada: (number | null)[] | null = llega
    ? meses.map((_, i) => (i < iHoy ? null : (recta[i - iHoy] ?? null)))
    : null;

  const pct = (v: number) =>
    p.target_cents > 0 ? formatShare(Math.max((v / p.target_cents) * 100, 0)) : "—";
  const lecturas: LecturaPunto[] = meses.map((m, i) => {
    const v = real[i];
    if (v !== null) {
      return {
        rotulo: i === iHoy ? `Hoy, ${largo(m)}` : largo(m),
        cifra: formatCents(v),
        detalle: `${pct(v)} de la meta`,
        tono: "neutro",
      };
    }
    const f = proyectada?.[i] ?? null;
    return f === null
      ? {
          rotulo: largo(m),
          cifra: "—",
          detalle: "A este ritmo, aún no",
          tono: "neutro",
        }
      : {
          rotulo: largo(m),
          cifra: `≈ ${formatCents(f)}`,
          detalle:
            f >= p.target_cents
              ? "Meta alcanzada, a este ritmo"
              : `${pct(f)} de la meta, a este ritmo`,
          tono: f >= p.target_cents ? "bien" : "neutro",
        };
  });

  const n = meses.length;
  const metaCorta = new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: 0,
  }).format(Math.round(p.target_cents / 100));

  return (
    <LineaInteractiva
      tamano="compacto"
      altoBase={120}
      claseAlto="h-[120px] lg:h-[140px]"
      ejeX={meses.map(corto)}
      marcasX={[0, iHoy, n - 1].filter((v, k, a) => a.indexOf(v) === k)}
      guias={[{ valor: p.target_cents, rotulo: `META ${metaCorta}` }]}
      lecturas={lecturas}
      leyendaProyeccion={
        llega ? `A tu ritmo, unos ${formatCents(p.ritmo_cents)} al mes` : undefined
      }
      etiquetaAccesible="Lo ahorrado en la cuenta de la meta y hacia dónde va. Recórrelo con las flechas."
      series={[
        {
          id: "valor",
          nombre: "En la cuenta",
          valores: real,
          textos: real.map((v) => (v === null ? "—" : formatCents(v))),
        },
        ...(proyectada
          ? [
              {
                id: "proyeccion",
                nombre: "A este ritmo",
                proyeccion: true,
                valores: proyectada,
                textos: proyectada.map((v) => (v === null ? "—" : formatCents(v))),
              },
            ]
          : []),
      ]}
    >
      <div className="flex flex-col gap-1">
        <span className="text-[13px] leading-[18px] font-semibold text-muted">
          A este ritmo, llegas en
        </span>
        <span className={CIFRA_LECTURA.compacto}>
          {llega ? `${p.meses_para_meta} ${p.meses_para_meta === 1 ? "mes" : "meses"}` : "No llega"}
        </span>
        <span className="text-[14px] leading-5 text-muted tabular-nums first-letter:uppercase">
          {llega
            ? `${largo(p.fecha_estimada as string)}${
                p.deadline
                  ? (p.fecha_estimada as string) <= p.deadline
                    ? ", antes de tu fecha"
                    : `, después de tu fecha (${largo(p.deadline)})`
                  : ""
              }`
            : p.ritmo_cents < 0
              ? `la cuenta ha bajado unos ${formatCents(-p.ritmo_cents)} al mes`
              : "la cuenta no ha crecido estos meses"}
        </span>
      </div>
    </LineaInteractiva>
  );
}
