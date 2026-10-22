"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { cn } from "@/lib/cn";

/**
 * Ningún campo del prototipo tiene borde: se distinguen por la superficie
 * secundaria. El foco visible lo aporta la regla global de globals.css.
 */
const field = cn(
  "w-full border-0 bg-surface-2 text-fg placeholder:text-muted",
  "h-11 rounded-md px-3 text-[17px] lg:h-[38px] lg:rounded-sm lg:text-[14px]",
  "transition-colors duration-150 ease-ui",
  "disabled:opacity-40",
);

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(field, className)} {...props} />;
}

/** Campo de contraseña con el ojo de mostrar y ocultar del prototipo. */
export function PasswordInput({ className, ...props }: ComponentProps<"input">) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        className={cn(field, "pr-12", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Ocultar la contraseña" : "Mostrar la contraseña"}
        className="absolute top-1/2 right-2 flex size-11 -translate-y-1/2 items-center justify-center rounded-sm text-muted lg:size-9"
      >
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cn("text-[13px] leading-[18px] font-semibold text-muted", className)}
      {...props}
    />
  );
}

/** Aviso de error de formulario, con el color semántico de gasto. */
export function FieldError({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-[13px] leading-[18px] font-semibold text-expense">
      {children}
    </p>
  );
}
