import { BarrasRanking, type FilaRanking } from "@/components/ui/barras-ranking";
import { Card, CardHeader } from "@/components/ui/card";
import { CIFRA_LECTURA, type Tono } from "@/lib/graficos";
import { formatCents, formatPercent, formatShare, percentChange } from "@/lib/money";
import type { AccountType } from "@/lib/supabase/database.types";
import { ACCOUNT_TYPE_ICONS } from "@/lib/types";

/** Una fila de `account_card_spend`: una cuenta y una de sus tarjetas (o «sin tarjeta»). */
export type GastoTarjeta = {
  account_id: string;
  account_name: string;
  account_color: string;
  account_type: AccountType;
  card_id: string | null;
  last4: string | null;
  nickname: string | null;
  net_cents: number;
  cargos: number;
  account_net_cents: number;
};

const MES = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  timeZone: "UTC",
});
const mes = (iso: string) => MES.format(new Date(`${iso}T00:00:00Z`));

/** «Visa ···4242» o «Tarjeta ···4242». */
function nombreTarjeta(f: GastoTarjeta): string {
  if (f.card_id === null) return "Sin tarjeta";
  const final = f.last4 ? `···${f.last4}` : "";
  return f.nickname ? `${f.nickname} ${final}`.trim() : `Tarjeta ${final}`.trim();
}

/**
 * Gasto por cuenta y, dentro, POR TARJETA: cuánto has gastado este mes con
 * cada una, en el ranking de barras de «Dónde está».
 *
 * Es GASTO NETO, como el resto de la app (`account_card_spend`): una devolución
 * resta de la cuenta y la tarjeta del cargo que devuelve, no de donde se
 * cobró. Así la suma de las cuentas es el gasto neto del mes, y la de las
 * tarjetas de una cuenta, el de esa cuenta.
 *
 * Cada cuenta lleva debajo sus tarjetas, sangradas y con un carril más fino
 * —y «Sin tarjeta» para lo apuntado a mano o las suscripciones—, solo si tiene
 * alguna tarjeta con gasto: una cuenta sin tarjetas no necesita desglose. La
 * MUESCA marca el mes anterior, en la cuenta y en cada tarjeta.
 *
 * Cada cuenta lleva a sus gastos del mes. La cabecera, al pasar por una fila,
 * la lee.
 */
export function AccountSpend({
  actual,
  previo,
  mesIso,
  mesPrevioIso,
}: {
  actual: GastoTarjeta[];
  previo: GastoTarjeta[];
  mesIso: string;
  mesPrevioIso: string;
}) {
  if (actual.length === 0 && previo.length === 0) return null;

  type Grupo = {
    cuenta: GastoTarjeta;
    ahora: number;
    antes: number;
    tarjetas: GastoTarjeta[];
  };
  const grupos = new Map<string, Grupo>();
  for (const f of actual) {
    const g = grupos.get(f.account_id) ?? {
      cuenta: f,
      ahora: f.account_net_cents,
      antes: 0,
      tarjetas: [],
    };
    g.tarjetas.push(f);
    grupos.set(f.account_id, g);
  }
  for (const f of previo) {
    const g = grupos.get(f.account_id) ?? {
      cuenta: f,
      ahora: 0,
      antes: 0,
      tarjetas: [],
    };
    g.antes = f.account_net_cents;
    grupos.set(f.account_id, g);
  }
  const previoTarjeta = new Map(
    previo.map((f) => [`${f.account_id}:${f.card_id ?? "sin"}`, f.net_cents]),
  );

  const filas = [...grupos.values()].sort((a, b) => b.ahora - a.ahora || b.antes - a.antes);
  const totalMes = filas.reduce((s, g) => s + g.ahora, 0);
  const hayPrevio = previo.length > 0;
  const nombrePrevio = mes(mesPrevioIso);

  const ranking: FilaRanking[] = filas.map(({ cuenta, ahora, antes, tarjetas }) => {
    const cambio = hayPrevio ? percentChange(ahora, antes) : null;
    const variacion =
      cambio === null
        ? undefined
        : {
            texto: `${formatPercent(cambio, 0)} frente a ${nombrePrevio}`,
            // En gasto, subir es lo malo.
            tono: (cambio > 0 ? "mal" : cambio < 0 ? "bien" : "neutro") as Tono,
          };
    const share = totalMes > 0 && ahora > 0 ? formatShare((ahora / totalMes) * 100) : undefined;
    // El desglose, solo si alguna tarjeta de verdad tiene gasto este mes.
    const conTarjeta = tarjetas.some((t) => t.card_id !== null);
    const hijos: FilaRanking[] | undefined = conTarjeta
      ? [...tarjetas]
          .sort((a, b) =>
            a.card_id === null ? 1 : b.card_id === null ? -1 : b.net_cents - a.net_cents,
          )
          .map((t) => {
            const antesTarjeta = previoTarjeta.get(`${t.account_id}:${t.card_id ?? "sin"}`);
            return {
              id: `${t.account_id}:${t.card_id ?? "sin"}`,
              nombre: nombreTarjeta(t),
              color: t.card_id === null ? "var(--aurora-otros)" : cuenta.account_color,
              valor: t.net_cents,
              texto: formatCents(t.net_cents),
              negativo: t.net_cents < 0,
              previo: antesTarjeta !== undefined && antesTarjeta > 0 ? antesTarjeta : null,
            };
          })
      : undefined;
    return {
      id: cuenta.account_id,
      nombre: cuenta.account_name,
      icono: ACCOUNT_TYPE_ICONS[cuenta.account_type],
      color: cuenta.account_color,
      valor: ahora,
      texto: formatCents(ahora),
      share,
      negativo: ahora < 0,
      previo: hayPrevio && antes > 0 ? antes : null,
      variacion,
      hijos,
      href: `/movimientos?mes=${mesIso}&cuenta=${cuenta.account_id}&tipo=EXPENSE`,
      lectura: {
        rotulo: cuenta.account_name,
        cifra: formatCents(ahora),
        detalle: hayPrevio
          ? `${formatCents(antes)} en ${nombrePrevio}${share ? ` · ${share} del mes` : ""}`
          : share
            ? `${share} del gasto del mes`
            : "Sin gasto este mes",
        tono: "neutro",
      },
    };
  });

  return (
    <Card>
      <CardHeader title="Gasto por cuenta y tarjeta" />
      <BarrasRanking
        filas={ranking}
        etiquetaAccesible={`Gasto de ${mes(mesIso)} por cuenta y tarjeta`}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted first-letter:uppercase">
            {mes(mesIso)}, en {filas.length} {filas.length === 1 ? "cuenta" : "cuentas"}
          </span>
          <span className={CIFRA_LECTURA.compacto}>{formatCents(totalMes)}</span>
          <span className="text-[14px] leading-5 text-muted">
            {hayPrevio
              ? `Gasto neto. La muesca marca ${nombrePrevio}.`
              : "Gasto neto: las devoluciones restan."}
          </span>
        </div>
      </BarrasRanking>
    </Card>
  );
}
