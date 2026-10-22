import { DesglosePrevision } from "@/components/resumen/desglose-prevision";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { formatCents, formatShare } from "@/lib/money";

/**
 * La previsión de fin de mes: la única pieza de Resumen que mira ADELANTE.
 *
 * Todo lo demás cuenta lo que ya pasó; esto dice hacia dónde va: «si mantienes
 * el ritmo, acabarás en X». El número no es una regla de tres —lo calcula
 * `month_forecast` sumando lo gastado, las suscripciones que faltan por cargar y
 * el discrecional restante— así que aquí solo se presenta.
 *
 * Es la tarjeta de CRISTAL de la pantalla (lo que de verdad flota, con su anillo
 * de progreso): cuánto del total previsto llevas ya gastado. Es humilde: los
 * primeros días del mes extrapolar es ruido, así que no se enseña número duro ni
 * anillo hasta que hay base (`dias_transcurridos`).
 *
 * Solo se pinta en el mes en curso: la decisión la toma quien la coloca, porque
 * la previsión de un mes cerrado es su total y no aporta nada.
 */

export type PrevisionMesData = {
  dias_transcurridos: number;
  dias_totales: number;
  dias_restantes: number;
  gasto_real_cents: number;
  suscripciones_cents: number;
  extrapolado_cents: number;
  prevision_cents: number;
  ingresos_real_cents: number;
};

export type CategoriaPrevision = {
  category_id: string;
  name: string;
  color: string;
  icon: string;
  cap_cents: number;
  gastado_cents: number;
  prevision_cents: number;
  rebasa: boolean;
};

// Por debajo de esto, un día flojo o fuerte deforma la proyección entera. Mejor
// callar el número que dar uno que mañana cambia de la mitad al doble. Lo lee
// también Resumen para decidir si pone la previsión en la tira de totales.
export const DIAS_MINIMOS = 4;

/** Anillo de progreso: cuánto del total previsto se lleva ya gastado. */
function Anillo({ fraccion }: { fraccion: number }) {
  const r = 18;
  const circ = 2 * Math.PI * r;
  const f = Math.min(1, Math.max(0, fraccion));
  return (
    <svg viewBox="0 0 44 44" className="size-11 shrink-0 -rotate-90" aria-hidden>
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--separator)" strokeWidth="4" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        stroke="var(--warning)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - f)}
        className="[transition:stroke-dashoffset_600ms_var(--ease-out)]"
      />
    </svg>
  );
}

export function PrevisionMes({
  prevision,
  categorias,
  ingresoPendiente = 0,
}: {
  prevision: PrevisionMesData;
  categorias: CategoriaPrevision[];
  /** Ingresos recurrentes que faltan por entrar este mes. Cierra el balance. */
  ingresoPendiente?: number;
}) {
  const enRiesgo = categorias.filter((c) => c.rebasa);
  const hayLimites = categorias.length > 0;
  // Balance previsto = (ingresos reales + recurrentes que faltan) − gasto previsto.
  const ingresosPrevistos = prevision.ingresos_real_cents + ingresoPendiente;
  const balancePrevisto = ingresosPrevistos - prevision.prevision_cents;

  // Humildad temprana: sin base para extrapolar, no se inventa un total ni se
  // dibuja el anillo. Si hay suscripciones por llegar, eso sí es un dato cierto.
  if (prevision.dias_transcurridos < DIAS_MINIMOS) {
    return (
      <section className="glass-card flex flex-col rounded-lg p-4 lg:p-5">
        <span className="text-[13px] leading-[18px] font-semibold tracking-[0.03em] text-muted uppercase">
          Previsión de fin de mes
        </span>
        <p className="mt-2 text-[15px] leading-5 text-muted">
          Aún es pronto para afinarla.
          {prevision.suscripciones_cents > 0
            ? ` Quedan ${formatCents(prevision.suscripciones_cents)} de gastos fijos por cargar este mes.`
            : ""}
        </p>
      </section>
    );
  }

  const porGastar = prevision.prevision_cents - prevision.gasto_real_cents;
  // Qué parte del total previsto ya está gastada, para el anillo y el porcentaje.
  const fraccion =
    prevision.prevision_cents > 0 ? prevision.gasto_real_cents / prevision.prevision_cents : 0;
  const pct = Math.round(Math.min(1, Math.max(0, fraccion)) * 100);

  const titulo =
    enRiesgo.length > 0
      ? "Atención a tus límites"
      : balancePrevisto < 0
        ? "Mes ajustado"
        : "Vas por buen ritmo";

  return (
    <section className="glass-card flex flex-col rounded-lg p-4 lg:p-5">
      {/* La cabecera de la tarjeta es un botón: al tocarla se abre el
          desglose de la suma (gastado + suscripciones + extrapolado). */}
      <DesglosePrevision
        total={`≈ ${formatCents(prevision.prevision_cents)}`}
        partes={[
          {
            id: "gastado",
            rotulo: "Ya gastado",
            valor: prevision.gasto_real_cents,
            texto: formatCents(prevision.gasto_real_cents),
            color: "var(--warning)",
          },
          {
            id: "suscripciones",
            rotulo: "Gastos fijos por cargar",
            valor: prevision.suscripciones_cents,
            texto: formatCents(prevision.suscripciones_cents),
            color: "var(--aurora-1)",
          },
          {
            id: "extrapolado",
            rotulo:
              prevision.dias_restantes === 1
                ? "Estimado para el día que queda"
                : `Estimado para los ${prevision.dias_restantes} días que quedan`,
            valor: prevision.extrapolado_cents,
            texto: formatCents(prevision.extrapolado_cents),
            color: "var(--aurora-3)",
          },
        ]}
      >
        <Anillo fraccion={fraccion} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] leading-5 font-semibold">{titulo}</span>
          <span className="mt-0.5 text-[13px] leading-[18px] text-muted tabular-nums lg:text-[14px]">
            A este paso cerrarás en{" "}
            {/* Sin partir: «≈» al final de una línea y la cifra en la siguiente se
                leían como dos cosas en una columna estrecha (hallazgo B-8). */}
            <span className="cifra whitespace-nowrap text-fg">
              ≈ {formatCents(prevision.prevision_cents)}
            </span>
            {porGastar > 0 ? (
              <>
                {" · unos "}
                <span className="whitespace-nowrap">{formatCents(porGastar)}</span>
                {" más que ahora"}
              </>
            ) : null}
          </span>
        </span>
        <span className="cifra shrink-0 text-[22px] leading-none text-warning tabular-nums lg:text-[26px]">
          {formatShare(pct)}
        </span>
      </DesglosePrevision>

      {prevision.suscripciones_cents > 0 ? (
        <p className="mt-3 hair-t border-hairline pt-3 text-[13px] leading-[18px] text-muted tabular-nums lg:text-[14px]">
          Incluye {formatCents(prevision.suscripciones_cents)} de gastos fijos aún por cargar.
        </p>
      ) : null}

      {/* El balance previsto: la recompensa de modelar los ingresos fijos.
          Solo si hay ingresos previstos —si no, sería «balance −gasto»—. */}
      {ingresosPrevistos > 0 ? (
        <p
          className={cn(
            "text-[13px] leading-[18px] text-muted tabular-nums lg:text-[14px]",
            prevision.suscripciones_cents > 0 ? "mt-1" : "mt-3 hair-t border-hairline pt-3",
          )}
        >
          Balance previsto{" "}
          <span
            className={cn(
              "font-semibold tabular-nums",
              balancePrevisto < 0 ? "text-expense" : "text-income",
            )}
          >
            {balancePrevisto >= 0 ? "+" : ""}
            {formatCents(balancePrevisto)}
          </span>
          {ingresoPendiente > 0 ? ` · faltan ${formatCents(ingresoPendiente)} por entrar` : ""}
        </p>
      ) : null}

      {/* Lo accionable: qué límites vas camino de rebasar. */}
      {enRiesgo.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {enRiesgo.slice(0, 3).map((c) => (
            <li key={c.category_id} className="flex items-center gap-2">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full"
                style={{
                  background: `color-mix(in srgb, ${c.color} 16%, transparent)`,
                  color: c.color,
                }}
              >
                <Icon name={c.icon} size={14} />
              </span>
              <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-warning lg:text-[14px]">
                Vas camino de pasar <span className="font-semibold">{c.name}</span>:{" "}
                <span className="tabular-nums">
                  ≈ {formatCents(c.prevision_cents)} de {formatCents(c.cap_cents)}
                </span>
              </span>
            </li>
          ))}
          {enRiesgo.length > 3 ? (
            <li className="text-[13px] leading-[18px] text-muted">y {enRiesgo.length - 3} más.</li>
          ) : null}
        </ul>
      ) : hayLimites ? (
        <p className="mt-2 text-[13px] leading-[18px] text-muted lg:text-[14px]">
          Ningún límite en riesgo por ahora.
        </p>
      ) : null}
    </section>
  );
}
