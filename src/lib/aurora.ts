/**
 * El espectro de la FIRMA, en orden: violeta → cian → oro (con apoyos azul,
 * verde-agua, ámbar y rosa). Son los tokens `--aurora-1..7` de globals.css.
 *
 * La banda de categorías colorea cada segmento por su POSICIÓN con esta escala,
 * NO con el color suelto de cada categoría: así el reparto siempre se lee como el
 * degradado Aurora —la identidad— y no como una mezcla turbia de colores sueltos.
 *
 * Vive en un módulo NEUTRO (sin `"use client"`) a propósito: lo consume el
 * envoltorio `banda-categorias`, que es un componente de SERVIDOR. Un valor
 * exportado desde un módulo `"use client"` e importado desde el servidor llega
 * como referencia de cliente (proxy), no como el array real —y los colores
 * salían `undefined`—. Un módulo neutro lo importan sin problema los dos lados.
 */
export const ESPECTRO_AURORA = [
  "var(--aurora-1)",
  "var(--aurora-2)",
  "var(--aurora-3)",
  "var(--aurora-4)",
  "var(--aurora-5)",
  "var(--aurora-6)",
  "var(--aurora-7)",
];

/** El gris-pizarra del segmento «Otros» (la cola agrupada). Neutro a propósito. */
export const COLOR_OTROS = "var(--aurora-otros)";

/**
 * Cuántos segmentos muestra la banda como mucho, incluido «Otros».
 *
 * Con 15 o 20 categorías no caben: los segmentos se vuelven astillas ilegibles y
 * la leyenda se dispara a diez filas. La banda enseña las MÁS GRANDES —hasta
 * `MAX_SEGMENTOS - 1`— y agrupa el resto en un «Otros». Siete es lo que mantiene
 * la banda legible y la leyenda en pocas filas, y encaja con los peldaños del
 * espectro (seis de color + el neutro).
 */
export const MAX_SEGMENTOS = 7;
