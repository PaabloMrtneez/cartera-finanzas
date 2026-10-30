import { Fragment } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";
import { fechaCuota, type FilaCuadro } from "@/lib/prestamos-vista";

const ESTADO: Record<FilaCuadro["state"], { texto: string; clase: string }> = {
  COBRADA: { texto: "Cobrada", clase: "text-income" },
  PREVIA: { texto: "Antes del alta", clase: "text-muted" },
  PENDIENTE: { texto: "Pendiente", clase: "text-muted" },
  ANULADA: { texto: "No se cobra", clase: "text-muted" },
};

/**
 * EL CUADRO DE AMORTIZACIÓN, desplegable: cada cuota con su fecha, cuánto es
 * interés y cuánto capital, y lo que queda después; las cobradas, marcadas.
 *
 * UN SOLO MARCADO para las dos anchuras. En escritorio cada fila es una fila
 * de tabla (rejilla de siete columnas, con su cabecera); en móvil la misma fila
 * se recoloca en dos líneas —número, fecha, estado y cuota arriba; el reparto
 * debajo— y los rótulos que en escritorio da la cabecera van junto a cada
 * cifra. Cada cifra se escribe UNA vez. Los roles ARIA de tabla se ponen a mano
 * porque la rejilla no es un <table>.
 *
 * Las APORTACIONES EXTRA van en su propia fila, justo después de la cuota tras
 * la que se aplicaron: la cuota enseña lo que quedaba tras ella y la
 * aportación, lo que queda después. Así se ven las dos bajadas por separado.
 */
export function CuadroAmortizacion({
  filas,
  nombre,
  proxima,
  principal,
  aportadoAntes = 0,
}: {
  filas: FilaCuadro[];
  nombre: string;
  /** El periodo de la próxima cuota, para resaltarla. */
  proxima: number | null;
  /** El principal, para lo que queda tras una aportación antes de la primera cuota. */
  principal: number;
  /** Lo aportado antes de la primera cuota (no tiene fila de cuota propia). */
  aportadoAntes?: number;
}) {
  const cobradas = filas.filter((f) => f.state === "COBRADA" || f.state === "PREVIA").length;
  const fila = cn(
    "flex flex-wrap items-baseline gap-x-3 gap-y-[2px] px-[18px] py-[10px]",
    "lg:grid lg:grid-cols-[40px_minmax(0,1.1fr)_minmax(0,1fr)_repeat(4,minmax(0,1fr))] lg:items-center lg:gap-x-4 lg:px-5 lg:py-2",
  );

  return (
    <details className="group">
      <summary
        className={cn(
          "fila-pulsable flex min-h-12 cursor-pointer list-none items-center gap-3 px-[18px] py-3 lg:px-5",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] leading-5 font-semibold">Cuadro de amortización</span>
          <span className="text-[13px] leading-[18px] text-muted tabular-nums">
            {filas.length} cuotas · {cobradas} ya {cobradas === 1 ? "pagada" : "pagadas"}
          </span>
        </span>
        <span className="text-muted transition-transform duration-200 ease-out group-open:rotate-180" aria-hidden>
          <Icon name="chevron-down" size={18} />
        </span>
      </summary>

      <div role="table" aria-label={`Cuadro de amortización de ${nombre}`} className="pb-2">
        <div
          role="row"
          className={cn(
            fila,
            "hidden hair-t border-separator text-[13px] leading-[18px] font-semibold text-muted lg:grid",
          )}
        >
          <span role="columnheader">Nº</span>
          <span role="columnheader">Fecha</span>
          <span role="columnheader">Estado</span>
          <span role="columnheader" className="text-right">
            Cuota
          </span>
          <span role="columnheader" className="text-right">
            Intereses
          </span>
          <span role="columnheader" className="text-right">
            Capital
          </span>
          <span role="columnheader" className="text-right">
            Queda
          </span>
        </div>

        {aportadoAntes > 0 ? (
          <FilaAportacion clase={fila} importe={aportadoAntes} queda={principal - aportadoAntes} />
        ) : null}

        {filas.map((f) => {
          const estado = ESTADO[f.state];
          const esProxima = f.period === proxima;
          return (
            <Fragment key={f.period}>
            <div
              role="row"
              className={cn(fila, "hair-t border-separator", esProxima && "bg-surface-2")}
            >
              <span role="cell" className="w-6 shrink-0 text-[13px] leading-[18px] text-muted tabular-nums lg:w-auto">
                {f.period}
              </span>
              <span
                role="cell"
                className="min-w-0 flex-1 text-[15px] leading-5 font-semibold tabular-nums lg:text-[14px] lg:font-normal"
              >
                {fechaCuota(f.due_on)}
              </span>
              <span
                role="cell"
                className={cn(
                  "inline-flex items-center gap-1 text-[13px] leading-[18px]",
                  esProxima ? "font-semibold text-accent-text" : estado.clase,
                )}
              >
                {f.state === "COBRADA" && !esProxima ? <Icon name="check" size={13} /> : null}
                {esProxima ? "Próxima" : estado.texto}
              </span>
              <span
                role="cell"
                className="text-[15px] leading-5 font-semibold tabular-nums lg:text-right lg:text-[14px]"
              >
                {formatCents(f.payment_cents)}
              </span>
              {/* La segunda línea de móvil, sangrada bajo la fecha. En escritorio
                  el envoltorio desaparece (`contents`) y sus celdas son
                  columnas de la fila. */}
              <div className="flex basis-full flex-wrap gap-x-[6px] pl-9 lg:contents">
                <span role="cell" className="text-[13px] leading-[18px] text-muted tabular-nums lg:text-right lg:text-[14px]">
                  <span className="lg:hidden">Intereses </span>
                  {formatCents(f.interest_cents)}
                </span>
                <span role="cell" className="text-[13px] leading-[18px] text-muted tabular-nums lg:text-right lg:text-[14px]">
                  <span className="lg:hidden">· capital </span>
                  {formatCents(f.principal_cents)}
                </span>
                <span role="cell" className="text-[13px] leading-[18px] text-muted tabular-nums lg:text-right lg:text-[14px] lg:text-fg">
                  <span className="lg:hidden">· queda </span>
                  {formatCents(f.balance_after_cents + f.prepaid_cents)}
                </span>
              </div>
            </div>
            {f.prepaid_cents > 0 ? (
              <FilaAportacion clase={fila} importe={f.prepaid_cents} queda={f.balance_after_cents} />
            ) : null}
            </Fragment>
          );
        })}
      </div>
    </details>
  );
}

/** Una aportación extra en el cuadro: cuánto y lo que queda después. */
function FilaAportacion({ clase, importe, queda }: { clase: string; importe: number; queda: number }) {
  return (
    <div role="row" className={cn(clase, "hair-t border-separator")}>
      <span role="cell" className="w-6 shrink-0 text-accent-text lg:w-auto" aria-hidden>
        <Icon name="plus" size={13} />
      </span>
      <span role="cell" className="min-w-0 flex-1 text-[15px] leading-5 font-semibold text-accent-text lg:text-[14px]">
        Aportación extra
      </span>
      <span role="cell" className="hidden lg:block" />
      <span role="cell" className="text-[15px] leading-5 font-semibold tabular-nums text-accent-text lg:text-right lg:text-[14px]">
        {formatCents(importe)}
      </span>
      <div className="flex basis-full flex-wrap gap-x-[6px] pl-9 lg:contents">
        <span role="cell" className="hidden lg:block" />
        <span role="cell" className="hidden lg:block" />
        <span role="cell" className="text-[13px] leading-[18px] text-muted tabular-nums lg:text-right lg:text-[14px] lg:text-fg">
          <span className="lg:hidden">queda </span>
          {formatCents(queda)}
        </span>
      </div>
    </div>
  );
}
