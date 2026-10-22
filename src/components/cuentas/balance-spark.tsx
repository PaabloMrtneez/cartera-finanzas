import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { cn } from "@/lib/cn";
import { monthShortLabel } from "@/lib/dates";
import { CIFRA_LECTURA, lecturasNivel } from "@/lib/graficos";
import { formatSignedDelta } from "@/lib/money";

export type PuntoSaldo = { period_month: string; cents: number };

const MES_LARGO = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
const largo = (iso: string) => MES_LARGO.format(new Date(`${iso}T00:00:00Z`));

/**
 * Cómo ha ido el total de las cuentas activas los últimos seis meses.
 *
 * Suma lo mismo que la cifra grande de la cabecera: el VALOR de cada cuenta
 * (saldo en las de dinero; efectivo más fondos en las de inversión), al cierre
 * de cada mes (`account_balance_monthly`). Antes sumaba solo saldos, y una
 * cuenta de inversión cuyo dinero está entero en fondos contaba 0. Con las
 * archivadas sumadas sería la curva de Patrimonio. Es una curva de NIVEL, así
 * que lleva escala y las anotaciones de máximo, mínimo y hoy, y su eje no
 * arranca en cero (aplastaría la pendiente, que es lo que se quiere ver).
 *
 * La cabecera dice lo que solo sabe esta curva —cuánto ha cambiado en el
 * periodo; el total ya está en grande arriba— y al recorrerla lee cada mes.
 */
export function BalanceSpark({
  puntos,
  className,
}: {
  puntos: PuntoSaldo[];
  /** Para ajustar el relleno del envoltorio según dónde se pinte (en tarjeta
      lleva el suyo; suelta bajo el total, se alinea sin relleno lateral). */
  className?: string;
}) {
  if (puntos.length < 2) return null;

  const valores = puntos.map((p) => p.cents);
  const cambio = valores[valores.length - 1] - valores[0];
  const rotulos = puntos.map((p) => largo(p.period_month));

  return (
    <div className={cn("flex flex-col gap-2 px-4 pb-4 lg:px-5", className)}>
      <LineaInteractiva
        anotaciones
        tamano="compacto"
        altoBase={120}
        claseAlto="h-[120px] lg:h-[200px]"
        ejeX={puntos.map((p) => monthShortLabel(p.period_month).split(" ")[0])}
        lecturas={lecturasNivel(valores, rotulos, { desdeRotulo: largo(puntos[0].period_month) })}
        etiquetaAccesible={`Total en cuentas activas de los últimos ${puntos.length} meses. Recórrelo con las flechas.`}
        series={[
          {
            id: "saldo",
            nombre: "En cuentas",
            valores,
            textos: [],
          },
        ]}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            Últimos {puntos.length} meses
          </span>
          <span className={CIFRA_LECTURA.compacto}>{formatSignedDelta(cambio)}</span>
          {/* Con los fondos dentro, bajar ya no significa solo gastar más de lo
              que entra: también puede ser el mercado. No se adivina la causa. */}
          <span className="text-[14px] leading-5 text-muted">
            En cuentas activas, con lo que valen tus fondos.
          </span>
        </div>
      </LineaInteractiva>
    </div>
  );
}
