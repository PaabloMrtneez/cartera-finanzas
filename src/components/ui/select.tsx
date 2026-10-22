"use client";

import * as RadixSelect from "@radix-ui/react-select";
import type { ComponentProps, ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

/**
 * El desplegable de la app. UNO solo para todas las pantallas.
 *
 * Antes cada hoja montaba su propio `<select>` nativo, y el menú que abría era el
 * del sistema operativo: gris, cuadrado y ajeno a la identidad (el que se ve con
 * «1 abr 2027» resaltado en gris). Este, sobre Radix Select, abre un panel
 * PROPIO —superficie elevada, filete, sombra honda y el acento de la app para lo
 * elegido—, con teclado completo (flechas, teclear para buscar, inicio/fin) y
 * lectores de pantalla, y envía el valor en formularios por su `name` como un
 * select de toda la vida.
 *
 * El disparador imita a un campo de texto de la app: alto, superficie secundaria
 * y su flecha. Se le puede pasar `className` para afinarlo (ancho, `tabular-nums`).
 */
export function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  name,
  required,
  disabled,
  placeholder,
  id,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedby,
}: {
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <RadixSelect.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      name={name}
      required={required}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-2 rounded-md bg-surface-2 pr-2.5 pl-3 text-left text-[17px] text-fg",
          "outline-none transition-[box-shadow] duration-150 ease-ui",
          "focus-visible:ring-[1.5px] focus-visible:ring-accent",
          "data-[placeholder]:text-muted data-[disabled]:opacity-50",
          "lg:h-[38px] lg:rounded-sm lg:text-[14px]",
          className,
        )}
      >
        {/* La línea seleccionada puede ser larga (una fecha, un nombre de cuenta):
            se trunca en vez de empujar la flecha fuera. */}
        <span className="min-w-0 flex-1 truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon className="shrink-0 text-muted">
          <Icon name="chevron-down" size={16} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          className={cn(
            "z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)]",
            "overflow-hidden rounded-md bg-surface-2 hair border-hairline shadow-overlay",
            "origin-(--radix-select-content-transform-origin) animate-fade-in",
          )}
        >
          <RadixSelect.ScrollUpButton className="flex h-6 items-center justify-center text-muted">
            <Icon name="chevron-up" size={15} />
          </RadixSelect.ScrollUpButton>

          <RadixSelect.Viewport className="p-1">{children}</RadixSelect.Viewport>

          <RadixSelect.ScrollDownButton className="flex h-6 items-center justify-center text-muted">
            <Icon name="chevron-down" size={15} />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

/** Una opción del desplegable. El `value` es lo que viaja; el texto, lo visible. */
export function SelectItem({
  value,
  children,
  disabled,
}: {
  value: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <RadixSelect.Item
      value={value}
      disabled={disabled}
      className={cn(
        "relative flex min-h-10 cursor-pointer items-center rounded-sm py-2 pr-9 pl-3 text-[16px] text-fg select-none",
        "outline-none lg:min-h-9 lg:text-[14px]",
        "data-[highlighted]:bg-accent-soft data-[highlighted]:text-fg",
        "data-[state=checked]:font-semibold data-[state=checked]:text-accent-text",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
      )}
    >
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
      <RadixSelect.ItemIndicator className="absolute right-2.5 flex items-center text-accent-text">
        <Icon name="check" size={16} />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}

/** Reexport del separador de Radix por si alguna hoja agrupa opciones. */
export function SelectSeparator({ className }: ComponentProps<"div">) {
  return <RadixSelect.Separator className={cn("my-1 h-px bg-hairline", className)} />;
}
