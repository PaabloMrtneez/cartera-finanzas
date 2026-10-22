"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

export type ParteDesglose = {
  id: string;
  rotulo: string;
  /** Céntimos, para el largo de su tramo. */
  valor: number;
  /** El importe ya formateado. */
  texto: string;
  color: string;
};

/**
 * El desglose de la previsión de fin de mes, al tocarla.
 *
 * El número de la previsión no es una regla de tres: `month_forecast` suma lo
 * GASTADO, las SUSCRIPCIONES que faltan por cargar y lo EXTRAPOLADO del gasto
 * discrecional. Al tocar la cabecera de la tarjeta se abre esa suma: una barra
 * apilada con los tres tramos —cuánto es cierto y cuánto es estimación se ve
 * de un vistazo— y las tres cifras con su total.
 *
 * Es un botón de verdad (`aria-expanded`), y el desglose entra con un fundido:
 * no empuja con una animación de alto, que no se puede hacer solo con
 * `transform` y `opacity`.
 */
export function DesglosePrevision({
  partes,
  total,
  children,
}: {
  partes: ParteDesglose[];
  /** La previsión ya formateada, para la fila del total. */
  total: string;
  /** La cabecera de la tarjeta, que hace de botón. */
  children: React.ReactNode;
}) {
  const [abierto, setAbierto] = useState(false);
  const id = useId();
  const suma = Math.max(
    partes.reduce((s, p) => s + Math.max(p.valor, 0), 0),
    1,
  );

  return (
    <>
      <button
        type="button"
        aria-expanded={abierto}
        aria-controls={id}
        onClick={() => setAbierto((a) => !a)}
        className="pulsable -m-2 flex w-[calc(100%+16px)] items-center gap-4 rounded-md p-2 text-left text-fg"
      >
        {children}
        <span
          className={cn(
            "shrink-0 text-muted transition-transform duration-200 ease-out",
            abierto && "rotate-180",
          )}
          aria-hidden
        >
          <Icon name="chevron-down" size={16} />
        </span>
      </button>

      {abierto ? (
        <div id={id} className="mt-3 flex animate-fade-in flex-col gap-3 hair-t border-hairline pt-3">
          {/* La suma, apilada: cada tramo crece desde su origen, escalonado. */}
          <div className="flex h-[10px] w-full gap-[3px] overflow-hidden rounded-full" aria-hidden>
            {partes
              .filter((p) => p.valor > 0)
              .map((p, i) => (
                <span
                  key={p.id}
                  className="h-full origin-left animate-bar-fill rounded-full"
                  style={{
                    flexGrow: p.valor / suma,
                    flexBasis: 0,
                    background: p.color,
                    animationDelay: `${i * 60}ms`,
                  }}
                />
              ))}
          </div>
          <ul className="flex flex-col gap-1">
            {partes.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-[13px] leading-[18px] lg:text-[14px]">
                <span className="size-[8px] shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
                <span className="min-w-0 flex-1 text-muted">{p.rotulo}</span>
                <span className="tabular-nums">{p.texto}</span>
              </li>
            ))}
            <li className="mt-1 flex items-center gap-2 hair-t border-hairline pt-2 text-[13px] leading-[18px] font-semibold lg:text-[14px]">
              <span className="min-w-0 flex-1">Previsión</span>
              <span className="tabular-nums">{total}</span>
            </li>
          </ul>
        </div>
      ) : null}
    </>
  );
}
