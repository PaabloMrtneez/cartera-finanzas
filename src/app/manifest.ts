import type { MetadataRoute } from "next";
import { THEME_COLOR } from "@/lib/theme";

/**
 * Manifiesto de la app instalable.
 *
 * En el iPhone hay que instalarla desde Safari («Compartir» → «Añadir a
 * pantalla de inicio»); desde Chrome en iOS no se puede. Una vez instalada se
 * abre sin barra de navegador y con su propio icono.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cartera",
    short_name: "Cartera",
    description: "Tus finanzas personales, privadas y en un solo sitio.",
    // La identidad de la app instalada, explícita (hallazgo B-5). Sin `id`, el
    // navegador usa `start_url`; se fija ESE mismo valor para que las
    // instalaciones que ya existen sigan siendo la misma app y no una nueva.
    id: "/resumen",
    start_url: "/resumen",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "es-ES",
    dir: "ltr",
    // El oscuro, que es el tema por defecto: el fondo de la pantalla de arranque.
    background_color: THEME_COLOR.dark,
    theme_color: THEME_COLOR.dark,
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icono-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icono-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icono-mascara-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Añadir movimiento",
        short_name: "Añadir",
        url: "/movimientos/nuevo",
      },
      {
        name: "Movimientos",
        short_name: "Movimientos",
        url: "/movimientos",
      },
    ],
  };
}
