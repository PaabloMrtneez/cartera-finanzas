"use client";

import { CATEGORY_COLORS, nombreColor } from "./icon";

/**
 * Rejilla de colores. En escritorio, 10 por fila, como en el editor de
 * categorías. En MÓVIL eran también 10, y en una hoja de 390 px cada círculo se
 * quedaba en 29 px: por debajo de los 44 que pide el dedo, y con 8 px entre uno y
 * otro era fácil tocar el vecino. Allí van 7 por fila: la celda (el botón) mide
 * ~48 px y el círculo dibujado dentro, 34; tres filas en vez de dos.
 */
export function ColorPicker({
  value,
  onChange,
  name,
  colors = CATEGORY_COLORS,
}: {
  value: string;
  onChange: (color: string) => void;
  /** Si se indica, se emite un campo oculto con ese nombre para el formulario. */
  name?: string;
  colors?: readonly string[];
}) {
  return (
    <>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <div
        role="group"
        aria-label="Color"
        className="grid grid-cols-7 gap-1 lg:grid-cols-10 lg:gap-2"
      >
        {colors.map((color) => {
          const selected = color.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={color}
              type="button"
              aria-pressed={selected}
              aria-label={nombreColor(color)}
              onClick={() => onChange(color)}
              className="grid aspect-square w-full place-items-center rounded-full border-0"
            >
              <span
                aria-hidden
                className="size-[34px] rounded-full lg:size-full"
                style={{
                  background: color,
                  boxShadow: selected
                    ? `0 0 0 2px var(--surface), 0 0 0 4px ${color}`
                    : "none",
                }}
              />
            </button>
          );
        })}
      </div>
    </>
  );
}
