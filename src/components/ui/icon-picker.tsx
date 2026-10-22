"use client";

import { cn } from "@/lib/cn";
import { CATEGORY_ICONS, Icon, nombreIcono } from "./icon";

/** Rejilla de 7 iconos por fila, como en el editor de categorías. */
export function IconPicker({
  value,
  onChange,
  name,
  color,
}: {
  value: string;
  onChange: (icon: string) => void;
  name?: string;
  /** El icono elegido se tiñe con el color de la categoría. */
  color: string;
}) {
  return (
    <>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <div
        role="group"
        aria-label="Icono"
        // El relleno de 4 px (con su margen negativo) deja sitio al anillo de
        // foco: esta rejilla hace scroll y recortaría el de los bordes.
        className="-m-1 grid max-h-64 grid-cols-7 gap-[6px] overflow-y-auto overscroll-contain p-1"
      >
        {CATEGORY_ICONS.map((icon) => {
          const selected = icon === value;
          return (
            <button
              key={icon}
              type="button"
              aria-pressed={selected}
              aria-label={nombreIcono(icon)}
              onClick={() => onChange(icon)}
              className={cn(
                "flex h-11 items-center justify-center rounded-sm",
                "transition-colors duration-150 ease-ui",
                selected ? "" : "bg-surface-2 text-muted",
              )}
              style={
                selected
                  ? {
                      background: `color-mix(in srgb, ${color} 16%, transparent)`,
                      color,
                    }
                  : undefined
              }
            >
              <Icon name={icon} size={20} />
            </button>
          );
        })}
      </div>
    </>
  );
}
