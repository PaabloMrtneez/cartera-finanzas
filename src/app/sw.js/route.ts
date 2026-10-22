import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `/sw.js`: el service worker, con la versión del despliegue delante.
 *
 * El código vive en `src/sw/service-worker.js`; aquí solo se le antepone
 * `const VERSION = "cartera-<despliegue>";`. Que los bytes cambien en cada
 * despliegue es lo que hace que el navegador vea un service worker NUEVO
 * (compara byte a byte al buscar actualizaciones), y con él:
 *
 *  · la app puede avisar «Hay una versión nueva · Actualizar»;
 *  · la caché del despliegue anterior se vacía al activarse el nuevo, en vez de
 *    crecer para siempre con estáticos de builds viejos.
 *
 * Estática (`force-static`): se genera UNA vez en el build, así que la versión
 * es la de ese build y todas las peticiones reciben los mismos bytes. En Vercel
 * se usa el id del despliegue (o el del commit); en local, la hora del build.
 *
 * El proxy no la toca (está fuera de su `matcher`): un service worker tiene que
 * servirse desde la raíz, sin redirecciones a /entrar ni CSP de página.
 */
export const dynamic = "force-static";

const DESPLIEGUE =
  process.env.VERCEL_DEPLOYMENT_ID ??
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
  `build-${Date.now().toString(36)}`;

export function GET() {
  const codigo = readFileSync(join(process.cwd(), "src/sw/service-worker.js"), "utf8");
  return new Response(`const VERSION = ${JSON.stringify(`cartera-${DESPLIEGUE}`)};\n${codigo}`, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      // Que ninguna caché HTTP se interponga al buscar la versión nueva.
      "Cache-Control": "no-cache",
    },
  });
}
