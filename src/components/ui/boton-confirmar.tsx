"use client";

import { useEffect, useState } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";

/**
 * Un botón destructivo que pide un SEGUNDO toque.
 *
 * Eliminar una meta, una suscripción, una categoría o revocar el token del
 * Atajo se hacía al primer toque, sin vuelta atrás. Un diálogo de confirmación
 * encima de otro diálogo (casi todos estos botones viven ya en uno) es pesado;
 * el patrón de iOS para esto es el botón que se «arma»: el primer toque lo
 * vuelve rojo y cambia su texto a la confirmación, y solo el segundo actúa. Si
 * no llega en unos segundos, o el foco se va a otra parte, se desarma solo.
 *
 * El cambio se anuncia al lector de pantalla con una región viva propia.
 */
export function BotonConfirmar({
  children,
  confirmar,
  onConfirm,
  variant = "secondary",
  size = "default",
  disabled,
  className,
  block,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  /** Lo que dice el botón ya armado: «Sí, eliminar». */
  confirmar: string;
  onConfirm: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  className?: string;
  block?: boolean;
  "aria-label"?: string;
}) {
  const [armado, setArmado] = useState(false);

  // Se desarma solo: un toque olvidado no debe dejar el botón cargado.
  useEffect(() => {
    if (!armado) return;
    const t = setTimeout(() => setArmado(false), 4000);
    return () => clearTimeout(t);
  }, [armado]);

  return (
    <>
      <Button
        type="button"
        variant={armado ? "destructive" : variant}
        // Un botón de solo icono no tiene sitio para el texto de confirmación:
        // al armarse pasa a compacto, con texto.
        size={armado && size === "icon" ? "compact" : size}
        disabled={disabled}
        block={block}
        // Armado manda el rojo del destructivo: un `text-expense` de reposo
        // dejaría el texto del mismo color que el fondo.
        className={armado ? `${className ?? ""} text-bg` : className}
        aria-label={armado ? confirmar : ariaLabel}
        onBlur={() => setArmado(false)}
        onClick={() => {
          if (armado) {
            setArmado(false);
            onConfirm();
          } else {
            setArmado(true);
          }
        }}
      >
        {armado ? confirmar : children}
      </Button>
      <span aria-live="polite" className="sr-only">
        {armado ? "Pulsa otra vez para confirmar." : ""}
      </span>
    </>
  );
}
