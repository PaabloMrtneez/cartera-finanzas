import { Cascada, type PasoVisible } from "@/components/ui/cascada";
import { COLOR_OTROS, ESPECTRO_AURORA } from "@/lib/aurora";
import { CIFRA_LECTURA, cascada, tasaAhorro, textoTasa } from "@/lib/graficos";
import { formatCents, formatSignedDelta } from "@/lib/money";

export type TrozoGasto = {
  category_id: string | null;
  name: string;
  net_cents: number;
};

/** Categorías con paso propio; el resto se junta en «Otras». */
const PASOS = 6;

/**
 * DEL INGRESO AL AHORRO, en cascada: lo que entró este mes, lo que se ha ido
 * en cada categoría y lo que queda.
 *
 * Las categorías van de más a menos gasto, con el color de su puesto en el
 * espectro —el mismo que en la banda de Resumen—; las pequeñas se juntan en
 * «Otras». Una categoría que las devoluciones dejan en negativo no resta:
 * SUMA, y va aparte como «Devoluciones de más». Los traspasos no aparecen:
 * mueven dinero, no lo gastan.
 *
 * Todo en enteros (`cascada`): lo que queda es exactamente el ingreso menos el
 * gasto neto del mes, el mismo balance que da Resumen.
 */
export function CascadaMes({
  ingreso,
  trozos,
  mes,
  mesIso,
}: {
  ingreso: number;
  trozos: TrozoGasto[];
  mes: string;
  mesIso: string;
}) {
  const gastos = [...trozos.filter((t) => t.net_cents > 0)].sort(
    (a, b) => b.net_cents - a.net_cents,
  );
  const devueltas = trozos.filter((t) => t.net_cents < 0);
  if (ingreso === 0 && gastos.length === 0) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        En {mes} todavía no ha entrado ni salido nada. La cascada aparece con el primer movimiento.
      </p>
    );
  }

  const visibles = gastos.length <= PASOS + 1 ? gastos : gastos.slice(0, PASOS);
  const resto = gastos.length <= PASOS + 1 ? [] : gastos.slice(PASOS);
  type Bruto = {
    id: string;
    nombre: string;
    delta: number;
    color: string;
    href?: string;
  };
  const brutos: Bruto[] = visibles.map((t, i) => ({
    id: t.category_id ?? "sin",
    nombre: t.name,
    delta: -t.net_cents,
    color: ESPECTRO_AURORA[i],
    href: `/movimientos?mes=${mesIso}&categoria=${t.category_id ?? "sin"}`,
  }));
  if (resto.length > 0) {
    brutos.push({
      id: "otras",
      nombre: `Otras · ${resto.length}`,
      delta: -resto.reduce((s, t) => s + t.net_cents, 0),
      color: COLOR_OTROS,
    });
  }
  if (devueltas.length > 0) {
    brutos.push({
      id: "devoluciones",
      nombre: "Devoluciones de más",
      delta: -devueltas.reduce((s, t) => s + t.net_cents, 0),
      color: "var(--income)",
    });
  }

  const c = cascada(
    ingreso,
    brutos.map((b) => b.delta),
  );
  const tasa = tasaAhorro(c.final, ingreso);

  const pasos: PasoVisible[] = [
    {
      id: "ingreso",
      nombre: `Ingresos de ${mes}`,
      desde: 0,
      hasta: ingreso,
      texto: formatCents(ingreso),
      color: "var(--income)",
      extremo: true,
      href: `/movimientos?mes=${mesIso}&tipo=INCOME`,
      lectura: {
        rotulo: `Ingresos de ${mes}`,
        cifra: formatCents(ingreso),
        detalle: "Lo que entró, sin reembolsos ni traspasos",
        tono: "neutro",
      },
    },
    ...brutos.map((b, i): PasoVisible => {
      const p = c.pasos[i + 1];
      return {
        id: b.id,
        nombre: b.nombre,
        desde: p.desde,
        hasta: p.hasta,
        texto: formatSignedDelta(b.delta),
        color: b.color,
        href: b.href,
        lectura: {
          rotulo: b.nombre,
          cifra: formatSignedDelta(b.delta),
          detalle: `Quedaban ${formatCents(p.desde)}; quedan ${formatCents(p.hasta)}`,
          tono: b.delta < 0 ? "neutro" : "bien",
        },
      };
    }),
    {
      id: "queda",
      nombre: c.final >= 0 ? "Lo que queda" : "Lo que falta",
      desde: 0,
      hasta: c.final,
      texto: formatSignedDelta(c.final),
      color: c.final >= 0 ? "var(--income)" : "var(--expense)",
      extremo: true,
      lectura: {
        rotulo: c.final >= 0 ? "Lo que queda" : "Lo que falta",
        cifra: formatSignedDelta(c.final),
        detalle: tasa === null ? "Sin ingresos este mes" : `${textoTasa(tasa)} de lo que entró`,
        tono: c.final >= 0 ? "bien" : "mal",
      },
    },
  ];

  return (
    <Cascada
      pasos={pasos}
      min={c.min}
      max={c.max}
      etiquetaAccesible={`De los ingresos de ${mes} a lo que queda, categoría a categoría.`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-[13px] leading-[18px] font-semibold text-muted">
          {c.final >= 0 ? "Te queda, de momento" : "Te falta, de momento"}
        </span>
        <span className={CIFRA_LECTURA.compacto}>{formatSignedDelta(c.final)}</span>
        <span className="text-[14px] leading-5 text-muted tabular-nums">
          {ingreso === 0
            ? `Aún no ha entrado nada en ${mes}.`
            : tasa !== null && tasa >= 0
              ? `${textoTasa(tasa)} de lo que entró`
              : "Has gastado más de lo que ha entrado"}
        </span>
      </div>
    </Cascada>
  );
}
