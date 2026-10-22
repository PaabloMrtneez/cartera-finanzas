"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * Un `<Link>` que precarga cuando hay INTENCIÓN —el puntero encima, el foco del
 * teclado o el dedo apoyado—, no al asomar en pantalla.
 *
 * Por qué: la barra lateral de escritorio tiene trece enlaces y todos están
 * siempre a la vista, así que cada pantalla disparaba trece precargas (más las
 * de la página) contra el servidor, cada una con su paso por el proxy. En
 * escritorio hay ratón: lo que se va a pulsar se sobrevuela antes, y eso basta
 * para tener el esqueleto (`loading.tsx`) listo al hacer clic.
 *
 * La barra de pestañas de móvil NO lo usa: son cuatro destinos, sin «encima»
 * con el dedo, y ahí la precarga al verse es lo que hace que el cambio de
 * pestaña responda al instante.
 *
 * `prefetch={null}` devuelve el comportamiento por defecto de Next en cuanto se
 * activa (patrón de la guía de precarga de Next).
 */
export function EnlaceIntencion(props: React.ComponentProps<typeof Link>) {
  const [activo, setActivo] = useState(false);
  const activar = () => setActivo(true);
  const { onMouseEnter, onFocus, onTouchStart, ...resto } = props;

  return (
    <Link
      {...resto}
      prefetch={activo ? null : false}
      onMouseEnter={(e) => {
        activar();
        onMouseEnter?.(e);
      }}
      onFocus={(e) => {
        activar();
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        activar();
        onTouchStart?.(e);
      }}
    />
  );
}
