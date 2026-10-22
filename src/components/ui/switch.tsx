"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import type * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Medidas exactas del interruptor de iOS, que es lo que replica el prototipo:
 * pista de 51 × 31 y pomo de 27 con 2 px de margen.
 */
export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative h-[31px] w-[51px] shrink-0 rounded-full",
        "transition-colors duration-200 ease-ui",
        "data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-2",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block size-[27px] rounded-full bg-white",
          "shadow-[0_1px_3px_rgba(0,0,0,0.2)]",
          "transition-transform duration-200 ease-sheet",
          "translate-x-[2px] data-[state=checked]:translate-x-[22px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

/** Fila de ajuste: etiqueta, explicación opcional e interruptor a la derecha. */
export function SwitchRow({
  label,
  hint,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { label: string; hint?: string }) {
  return (
    <label className="flex min-h-[52px] items-center gap-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[17px] leading-[22px] font-semibold lg:text-[15px]">{label}</span>
        {hint ? (
          <span className="text-[13px] leading-[18px] text-muted">{hint}</span>
        ) : null}
      </span>
      <Switch {...props} />
    </label>
  );
}
