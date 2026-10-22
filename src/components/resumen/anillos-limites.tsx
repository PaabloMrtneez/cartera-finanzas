import {
  AnillosProgreso,
  type AnilloProgreso,
  type FilaProgreso,
} from "@/components/ui/anillos-progreso";
import { ESPECTRO_AURORA } from "@/lib/aurora";
import { CIFRA_LECTURA } from "@/lib/graficos";
import { formatCents, formatShare } from "@/lib/money";

export type Limite = {
  budget_id: string;
  category_id: string;
  name: string;
  spent_cents: number;
  effective_cap_cents: number;
};

/** Cuántos límites caben en anillos; el resto va solo en la lista. */
const ANILLOS = 4;

/** Lo gastado entre el tope, para el orden y la geometría (dos enteros, un cociente). */
const fraccion = (l: Limite) =>
  l.effective_cap_cents > 0 ? l.spent_cents / l.effective_cap_cents : 0;

/**
 * Los límites del mes en ANILLOS, como los de Actividad: uno por límite, que
 * se cierra según gastas y, si te pasas, sigue dando la vuelta.
 *
 * Con muchos límites no caben todos: los cuatro MÁS CERCA de su tope (o más
 * pasados) van en anillos, que es lo que hay que mirar; el resto, en la lista
 * de debajo con una barra fina. La lista los tiene a todos, de más a menos
 * apurado, y cada fila lleva a los movimientos de su categoría en el mes.
 *
 * Los colores salen del espectro por POSICIÓN, como en la banda: son anillos,
 * no categorías, y el color solo los casa con su fila.
 */
export function AnillosLimites({
  limites,
  mes,
  mesIso,
}: {
  limites: Limite[];
  /** «octubre», para los textos. */
  mes: string;
  /** «2026-10-01», para los enlaces. */
  mesIso: string;
}) {
  if (limites.length === 0) return null;

  const orden = [...limites].sort(
    (a, b) => fraccion(b) - fraccion(a) || b.spent_cents - a.spent_cents,
  );
  const href = (l: Limite) => `/movimientos?mes=${mesIso}&categoria=${l.category_id}`;

  const describir = (l: Limite) => {
    const exceso = l.spent_cents - l.effective_cap_cents;
    return {
      detalle: `${formatCents(l.spent_cents)} de ${formatCents(l.effective_cap_cents)}`,
      cifra: formatShare(fraccion(l) * 100),
      estado: exceso > 0 ? `${formatCents(exceso)} de más` : `quedan ${formatCents(-exceso)}`,
      excedido: exceso > 0,
    };
  };

  const anillos: AnilloProgreso[] = orden.slice(0, ANILLOS).map((l, k) => {
    const d = describir(l);
    return {
      id: l.budget_id,
      nombre: l.name,
      color: ESPECTRO_AURORA[k],
      fraccion: fraccion(l),
      href: href(l),
      lectura: {
        rotulo: l.name,
        cifra: formatShare(fraccion(l) * 100),
        detalle: `${d.detalle} · ${d.estado}`,
        tono: d.excedido ? "mal" : "neutro",
      },
    };
  });

  const filas: FilaProgreso[] = orden.map((l, i) => {
    const d = describir(l);
    return {
      id: l.budget_id,
      nombre: l.name,
      ...d,
      fraccion: fraccion(l),
      color: i < ANILLOS ? ESPECTRO_AURORA[i] : undefined,
      anillo: i < ANILLOS ? i : undefined,
      href: href(l),
    };
  });

  const gastado = limites.reduce((s, l) => s + l.spent_cents, 0);
  const tope = limites.reduce((s, l) => s + l.effective_cap_cents, 0);
  const pasados = limites.filter((l) => l.spent_cents > l.effective_cap_cents).length;

  return (
    <AnillosProgreso
      anillos={anillos}
      filas={filas}
      etiquetaAccesible={`Límites de ${mes}, del más apurado al que más margen tiene.`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-[13px] leading-[18px] font-semibold text-muted">
          {limites.length === 1 ? "Del límite" : `De los ${limites.length} límites, juntos`}
        </span>
        <span className={CIFRA_LECTURA.compacto}>
          {tope > 0 ? formatShare((gastado / tope) * 100) : "—"}
        </span>
        <span
          className={
            pasados > 0
              ? "text-[14px] leading-5 text-expense tabular-nums"
              : "text-[14px] leading-5 text-muted tabular-nums"
          }
        >
          {pasados === 0
            ? `${formatCents(gastado)} de ${formatCents(tope)}, ninguno pasado`
            : pasados === 1
              ? `${formatCents(gastado)} de ${formatCents(tope)} · uno pasado`
              : `${formatCents(gastado)} de ${formatCents(tope)} · ${pasados} pasados`}
        </span>
      </div>
    </AnillosProgreso>
  );
}
