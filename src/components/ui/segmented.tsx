"use client";

import { useRef } from "react";
import { cn } from "@/lib/cn";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /**
   * Color del segmento activo. En el selector Gasto/Ingreso/Traspaso cada
   * opción se tiñe con su color semántico; en el resto se hereda el del texto.
   */
  color?: string;
};

/** El hueco entre segmentos y el borde interior, en píxeles. */
const HUECO = 3;

/**
 * Control segmentado: rejilla de columnas iguales sobre superficie secundaria,
 * con el segmento activo elevado sobre la superficie principal.
 *
 * La pastilla del activo es UN solo elemento que se desliza, no un fondo que
 * aparece y desaparece en cada botón. Antes era lo segundo, y un fundido
 * cruzado no dice nada: se ve un fondo apagándose aquí y otro encendiéndose
 * allá, sin relación entre los dos. Deslizándose, el movimiento cuenta que has
 * pasado de esta opción A ESTA otra.
 *
 * Se desliza con el muelle de iOS (`--ease-ios`, 300 ms), el mismo del
 * UISegmentedControl: sale disparada con el toque y asienta sin rebote.
 *
 * Los segmentos llevan relleno horizontal propio. Sin él, la columna medía
 * exactamente lo que el rótulo más largo —55,09 px de columna para 55,1 px de
 * «Traspaso»—, así que las palabras se tocaban.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Nombre del grupo para lectores de pantalla. */
  label: string;
  className?: string;
}) {
  const indice = Math.max(
    options.findIndex((o) => o.value === value),
    0,
  );
  const grupo = useRef<HTMLDivElement>(null);

  /*
   * El teclado de un grupo de radios (patrón ARIA): una sola parada de
   * tabulador —la opción elegida— y las flechas mueven la elección. Antes cada
   * opción era una parada y las flechas no hacían nada, que no es lo que un
   * lector de pantalla anuncia al decir «grupo de radio».
   */
  function alTeclear(event: React.KeyboardEvent<HTMLDivElement>) {
    const paso =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    const destino =
      event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
    if (paso === 0 && destino === null) return;
    event.preventDefault();
    const siguiente = destino ?? (indice + paso + options.length) % options.length;
    onChange(options[siguiente].value);
    grupo.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[siguiente]?.focus();
  }

  return (
    <div
      ref={grupo}
      role="radiogroup"
      aria-label={label}
      onKeyDown={alTeclear}
      className={cn("relative grid rounded-sm bg-surface-2", className)}
      style={{
        padding: HUECO,
        gap: HUECO,
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {/*
        La pastilla. Va detrás de los botones y se posiciona con un `transform`
        puesto directamente aquí, no con una variable en el padre: cambiar una
        variable en el contenedor recalcularía el estilo de todos los hijos.

        El desplazamiento se mide en porcentaje del propio ancho de la pastilla,
        que es exactamente el de una columna, más el hueco. Así funciona con dos,
        tres o cuatro opciones sin números a medida.
      */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-[3px] bottom-[3px] left-[3px] z-0",
          "rounded-[calc(var(--r-sm)-3px)] bg-surface shadow-card",
          // El muelle de iOS (`--ease-ios`), 300 ms: arranca con el dedo y
          // asienta largo, como el UISegmentedControl.
          "transition-transform duration-(--dur-segmento) ease-(--ease-ios)",
        )}
        style={{
          width: `calc((100% - ${HUECO * 2}px - ${(options.length - 1) * HUECO}px) / ${options.length})`,
          transform: `translateX(calc(${indice} * (100% + ${HUECO}px)))`,
        }}
      />

      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative z-10 grid h-10 place-items-center rounded-[calc(var(--r-sm)-3px)] px-3 text-[14px] lg:h-[34px]",
              // Solo el color cambia por botón; el fondo lo pone la pastilla.
              "transition-colors duration-150 ease-ui",
              "[-webkit-tap-highlight-color:transparent]",
              active ? "font-semibold" : "font-medium text-muted",
            )}
            style={active && option.color ? { color: option.color } : undefined}
          >
            {/*
              El gemelo invisible, siempre en negrita y siempre en su sitio.

              Cuando la rejilla se dimensiona por su contenido —que es lo que
              pasa con `w-auto`, en la barra de filtros de escritorio— el ancho
              de columna lo fija el rótulo más largo. Y el rótulo activo pasa de
              medium a semibold, así que al elegir «Traspaso» la columna crecía,
              crecía el control entero y se movía todo lo que venía detrás en la
              fila. Reservando SIEMPRE el ancho en negrita, elegir una opción u
              otra deja de cambiar la medida de nada.
            */}
            <span aria-hidden className="invisible col-start-1 row-start-1 font-semibold">
              {option.label}
            </span>
            <span className="col-start-1 row-start-1">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
