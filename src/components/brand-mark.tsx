import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * El icono de la app: los ANILLOS Aurora.
 *
 * Dos arcos concéntricos y finos que forman una «C» (de Cartera): el de fuera
 * va de violeta a cian y el de dentro de cian a oro, el espectro de la banda
 * repartido en dos trazos. Recuerdan a la banda y a los anillos de límites, y
 * son minimalistas a propósito: trazo fino sobre un azulejo de noche.
 *
 * Tiene dos versiones, por tokens (`--marca-*` en globals.css): la de NOCHE,
 * que es la principal y la de los iconos instalables, y la de PORCELANA para la
 * interfaz en tema claro —azulejo blanco con filete y el espectro un punto más
 * hondo—. El componente no sabe en qué tema está: los tokens cambian solos.
 *
 * A tamaño pequeño (la barra lateral, ≤ 32 px) el trazo engorda un poco para
 * no desaparecer: un hilo de 0,9 px se pierde contra el azulejo.
 *
 * Es un SVG con viewBox 0–100, así que escala a cualquier tamaño sin ficheros
 * extra, y comparte geometría con `scripts/generate-icons.mjs`, que dibuja lo
 * mismo para los iconos de la app instalable.
 */
export function BrandMark({ size = 44, className }: { size?: number; className?: string }) {
  // Ids propios por instancia: con dos marcas en la página (la barra lateral,
  // oculta en móvil, y otra visible) un id fijo apuntaba al degradado de la
  // OCULTA, y un degradado dentro de un SVG con `display: none` no pinta.
  const id = useId();
  const azulejo = `${id}-azulejo`;
  const fuera = `${id}-fuera`;
  const dentro = `${id}-dentro`;
  const trazo = size <= 32 ? 4.6 : 3.2;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={cn("block shrink-0", className)}
      aria-hidden
    >
      <defs>
        {/* Azulejo y anillos salen de los tokens `--marca-*`: de noche en el
            tema oscuro, de porcelana en el claro. `stopColor` por `style`: como
            atributo, un `var()` no se resuelve y la parada sale negra. */}
        <linearGradient id={azulejo} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--marca-azulejo-alto)" }} />
          <stop offset="1" style={{ stopColor: "var(--marca-azulejo-bajo)" }} />
        </linearGradient>
        <linearGradient id={fuera} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--marca-v)" }} />
          <stop offset="1" style={{ stopColor: "var(--marca-c)" }} />
        </linearGradient>
        <linearGradient id={dentro} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--marca-c)" }} />
          <stop offset="1" style={{ stopColor: "var(--marca-g)" }} />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="23" fill={`url(#${azulejo})`} />
      <rect
        x="0.75"
        y="0.75"
        width="98.5"
        height="98.5"
        rx="22.25"
        fill="none"
        style={{ stroke: "var(--marca-filete)" }}
        strokeWidth="1.5"
      />
      {/* Los dos arcos abren 52° a cada lado de la horizontal derecha. */}
      <path
        d="M67.24 27.94 A28 28 0 1 0 67.24 72.06"
        fill="none"
        stroke={`url(#${fuera})`}
        strokeWidth={trazo}
        strokeLinecap="round"
      />
      <path
        d="M60.47 36.6 A17 17 0 1 0 60.47 63.4"
        fill="none"
        stroke={`url(#${dentro})`}
        strokeWidth={trazo}
        strokeLinecap="round"
      />
    </svg>
  );
}
