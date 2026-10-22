import type { NextConfig } from "next";

/**
 * Cabeceras de seguridad para toda respuesta.
 *
 * Vercel no las pone solas, y esto es una PWA que maneja dinero real. Estas son
 * estáticas y valen para TODA ruta, incluidas las que no pasan por el proxy (la
 * página sin conexión, los estáticos):
 *
 * - `X-Frame-Options: DENY` cierra el clickjacking en cualquier respuesta,
 *   incluso donde no llega la CSP.
 * - `nosniff`, `Referrer-Policy` y `Permissions-Policy` son endurecimiento de
 *   base; HSTS fuerza HTTPS (en localhost el navegador lo ignora, así que no
 *   estorba en desarrollo).
 *
 * La Content-Security-Policy NO vive aquí: la emite `src/proxy.ts` por petición,
 * porque `script-src` va con un `nonce` fresco cada vez (con `'strict-dynamic'`,
 * la única forma de frenar un XSS sin `'unsafe-inline'`) y una cabecera estática
 * no puede llevar nonce. `frame-ancestors 'none'` viaja en esa CSP dinámica; el
 * `X-Frame-Options: DENY` de aquí cubre además las rutas sin proxy.
 */
const nextConfig: NextConfig = {
  /**
   * El cuerpo de una server action: 1 MB por defecto. Importar acepta
   * extractos de hasta 2 MB (2 millones de caracteres, comprobado en la
   * acción), que con acentos y el escapado del JSON pasan de 2 MB: con el
   * límite por defecto, un fichero que la pantalla aceptaba fallaba con un
   * error genérico (M-12). 4 MB queda por debajo de los 4,5 MB de Vercel.
   */
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  /**
   * Suscripciones e Ingresos recurrentes son ahora los dos grupos de Fijos.
   * Redirección PERMANENTE (308) y aquí, no en una página: corre antes que el
   * proxy y que el render, así que un marcador, un enlace viejo o la app
   * instalada llegan al grupo que les toca sin pintar nada por el camino. La
   * consulta que traiga la dirección vieja se conserva y se suma a `ver`.
   */
  async redirects() {
    return [
      { source: "/suscripciones", destination: "/fijos?ver=gastos", permanent: true },
      { source: "/ingresos", destination: "/fijos?ver=ingresos", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
