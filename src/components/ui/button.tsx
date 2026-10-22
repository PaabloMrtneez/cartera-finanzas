"use client";

import Link from "next/link";
import type * as React from "react";
import { cn } from "@/lib/cn";

/**
 * El prototipo no define ningún estado interactivo: no tiene una sola
 * `transition`, ni hover, ni active, ni disabled. Todo eso se diseña aquí desde
 * cero, apoyándose en la curva y las duraciones que sí establece.
 */
const base = cn(
  // `relative` para que el área de toque (`toque`, abajo) se centre en el botón.
  "relative inline-flex items-center justify-center gap-2 font-semibold",
  /*
    Al pulsar se RESALTA, como en iOS: los botones de UIKit no encogen, bajan
    su opacidad al instante y la recuperan al soltar.

    Hubo un `scale(0.97)` aquí, con la idea de que la opacidad se lee como
    «deshabilitado». La diferencia la marca el TIEMPO: deshabilitado es un
    estado quieto (0,4), y pulsado es un destello que llega en 0 ms con el dedo
    y se va en `--dur-soltar` (200 ms) al levantarlo. Ese ritmo es el de iOS y
    es lo que el ojo reconoce como «lo he tocado».

    El encogido queda para lo que tiene cuerpo de objeto: el botón redondo de
    añadir (ver `fabClasses`).
  */
  /* `pulsable` lleva también el hover (0,9, solo con ratón): van juntos para
     que el pulsado gane al hover cuando se hace clic con el puntero encima. */
  "pulsable",
  "disabled:pointer-events-none disabled:opacity-40",
);

const VARIANTS = {
  /** La acción principal: el botón de calidad, cuerpo negro con el canto del
      espectro Aurora (`boton-aurora`, en globals.css). Negro también en claro:
      es un material, no un modo. Antes era un relleno cian, y el cian se queda
      para lo que pide un color sólido: foco, enlaces, estados activos. */
  primary: "boton-aurora",
  secondary: "bg-surface-2 text-fg",
  /** Para borrados. El prototipo tiñe el botón principal con el color de gasto.
      La tinta es la del fondo (`text-bg`), no blanco: en oscuro el gasto es un
      coral claro y el blanco encima se quedaba en 2,6:1. Así pasa AA en los dos.

      NO es negro con canto coral, a propósito: el negro con canto es «lo que
      toca hacer aquí», y el peligro no puede vestirse igual que la acción
      principal. La gramática es la de iOS: lo reversible, o lo que aún pide un
      segundo toque, va en secundario con el texto en coral («Archivar»,
      `BotonConfirmar` en reposo); el relleno coral queda para lo que no tiene
      vuelta atrás —la confirmación que actúa, y la puerta de «Eliminar
      cuenta»—, que así no se confunde con nada. */
  destructive: "bg-expense text-bg",
  ghost: "bg-transparent text-muted hover:bg-surface-2 hover:opacity-100",
} as const;

const SIZES = {
  /** Alto en móvil y recogido en escritorio, como el pie de los diálogos. */
  default: "h-[50px] rounded-md px-4 text-[17px] lg:h-[38px] lg:rounded-sm lg:text-[14px]",
  /** Siempre compacto: barras de herramientas y acciones de fila. Se dibuja de
      34 px, pero el dedo recibe 44 (`toque`). */
  compact: "toque h-[34px] rounded-sm px-3 text-[14px]",
  /** Cuadrado, para acciones de solo icono. Igual: 34 a la vista, 44 al tacto. */
  icon: "toque size-[34px] rounded-sm",
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

export function buttonClasses({
  variant = "primary",
  size = "default",
  block = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
} = {}) {
  return cn(base, VARIANTS[variant], SIZES[size], block && "flex-1 lg:flex-none", className);
}

export function Button({
  variant = "primary",
  size = "default",
  block = false,
  className,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** En móvil los botones de un diálogo se reparten el ancho a partes iguales. */
  block?: boolean;
}) {
  return <button type={type} className={buttonClasses({ variant, size, block, className })} {...props} />;
}

/**
 * Un enlace con aspecto de botón. Existe para no anidar un <button> dentro de
 * un <a>, que es HTML inválido y rompe la navegación por teclado.
 */
export function ButtonLink({
  variant,
  size,
  block,
  className,
  ...props
}: React.ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}) {
  return <Link className={buttonClasses({ variant, size, block, className })} {...props} />;
}

/*
   Las clases del botón redondo, aparte del componente.

   El «+» de la barra de pestañas es un ENLACE, no un botón: navega a
   /movimientos/nuevo. Antes se pintaba metiendo un <Fab> (un <button>) dentro de
   un <Link>, y un <button> dentro de un <a> es HTML inválido: el lector de
   pantalla no le encontraba nombre al botón interior (axe: `button-name`) y es
   justo el anidamiento que `ButtonLink` existe para evitar. Con las clases
   sueltas, el propio Link lleva el aspecto y es el único elemento interactivo. */
export const fabClasses = cn(
  /* El mismo material que la acción principal —negro con canto Aurora—, más
     el halo tenue del espectro: es lo único de ese material que FLOTA (sobre
     el cristal de la barra), y la sombra es para lo que flota. */
  "relative flex size-[52px] items-center justify-center rounded-full boton-aurora",
  "[--boton-halo:var(--btn-halo)]",
  /* El único que ENCOGE al pulsar. Los botones y las filas se resaltan, como
     en iOS; este es un objeto redondo que flota sobre la barra, con cuerpo, y
     hundirse es lo que dice que lo has apretado. 0,97 y no 0,95, y
     asimétrico: hundirse en 120 ms acompaña al dedo, recuperarse en 180 es el
     sistema respondiendo. Se transiciona `scale` porque Tailwind 4 genera la
     propiedad independiente, no un `transform`. */
  "transition-[scale] duration-[180ms] ease-ui active:duration-[120ms] active:scale-[0.97]",
  "[-webkit-tap-highlight-color:transparent]",
);

/** El botón redondo del centro de la barra de pestañas. */
export function Fab({ className, type = "button", ...props }: React.ComponentProps<"button">) {
  return <button type={type} className={cn(fabClasses, className)} {...props} />;
}
