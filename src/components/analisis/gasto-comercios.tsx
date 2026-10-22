import { BarrasRanking, type FilaRanking } from "@/components/ui/barras-ranking";
import { COLOR_OTROS } from "@/lib/aurora";
import { CIFRA_LECTURA } from "@/lib/graficos";
import { formatCents, formatShare } from "@/lib/money";

export type FilaComercio = {
  grupo: "COMERCIO" | "OTROS" | "SIN_COMERCIO";
  puesto: number | null;
  merchant: string | null;
  net_cents: number;
  reimbursed_cents: number;
  cargos: number;
  comercios: number;
  share: number | null;
};

const cargosTexto = (n: number) => `${n} ${n === 1 ? "cargo" : "cargos"}`;

/**
 * GASTO POR COMERCIO: dónde se va el dinero, con nombre propio.
 *
 * El ranking de barras de «Dónde está», con los comercios del mes de más a
 * menos gasto NETO (un reembolso resta del comercio del gasto que devuelve).
 * Al final, dos filas de cierre, discretas —en gris, sin icono—: «Otros
 * comercios», que junta la cola, y «Sin comercio», lo apuntado a mano y las
 * suscripciones, que no traen comercio. Con ellas la suma cuadra con el gasto
 * neto del mes al céntimo, y las barras son su proporción de verdad.
 *
 * La cifra de la cabecera no repite el gasto del mes (ya lo da el héroe): da
 * cuánto de él se concentra en los comercios del top, que es lo que esta lista
 * sabe. Cada comercio lleva a sus movimientos del mes.
 */
export function GastoComercios({
  filas,
  mes,
  mesIso,
}: {
  filas: FilaComercio[];
  mes: string;
  mesIso: string;
}) {
  const top = filas.filter((f) => f.grupo === "COMERCIO" && f.net_cents > 0);
  const total = filas.reduce((s, f) => s + f.net_cents, 0);
  if (top.length === 0 || total <= 0) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        En {mes} todavía no hay gastos con comercio. Llegan solos con el Atajo al pagar con Apple
        Pay; lo apuntado a mano no trae comercio.
      </p>
    );
  }

  const enTop = top.reduce((s, f) => s + f.net_cents, 0);
  const parte = (v: number) => (total > 0 && v > 0 ? formatShare((v / total) * 100) : undefined);

  const ranking: FilaRanking[] = filas
    .filter((f) => f.net_cents !== 0 || f.cargos > 0)
    .map((f) => {
      const cierre = f.grupo !== "COMERCIO";
      const nombre =
        f.grupo === "OTROS"
          ? `Otros comercios · ${f.comercios}`
          : f.grupo === "SIN_COMERCIO"
            ? "Sin comercio"
            : (f.merchant ?? "Comercio");
      const devuelto =
        f.reimbursed_cents > 0 ? ` · ${formatCents(f.reimbursed_cents)} devueltos` : "";
      return {
        id: f.grupo === "COMERCIO" ? `c-${f.puesto}` : f.grupo,
        nombre,
        subtitulo:
          f.grupo === "SIN_COMERCIO"
            ? "Apuntados a mano y gastos fijos"
            : `${cargosTexto(f.cargos)}${devuelto}`,
        icono: cierre ? undefined : "shopping-bag",
        color: cierre ? COLOR_OTROS : "var(--accent)",
        valor: f.net_cents,
        texto: formatCents(f.net_cents),
        share: parte(f.net_cents),
        negativo: f.net_cents < 0,
        href:
          f.grupo === "COMERCIO" && f.merchant
            ? `/movimientos?mes=${mesIso}&q=${encodeURIComponent(f.merchant)}`
            : undefined,
        lectura: {
          rotulo: nombre,
          cifra: formatCents(f.net_cents),
          detalle: `${parte(f.net_cents) ?? "—"} del gasto · ${cargosTexto(f.cargos)}${devuelto}`,
          tono: "neutro",
        },
      };
    });

  return (
    <BarrasRanking filas={ranking} etiquetaAccesible={`Gasto de ${mes} por comercio`}>
      <div className="flex flex-col gap-1">
        <span className="text-[13px] leading-[18px] font-semibold text-muted">
          En{" "}
          {top.length === 1 ? "tu comercio principal" : `tus ${top.length} comercios principales`}
        </span>
        <span className={CIFRA_LECTURA.compacto}>{formatShare((enTop / total) * 100)}</span>
        <span className="text-[14px] leading-5 text-muted tabular-nums">
          del gasto de {mes}, {formatCents(enTop)}
        </span>
      </div>
    </BarrasRanking>
  );
}
