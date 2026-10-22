import { unstable_rethrow } from "next/navigation";

/**
 * Llamar a una server action desde el cliente sin que un fallo de red tire la
 * pantalla.
 *
 * El problema (hallazgo C-1 de `docs/pruebas/informe-front.md`): una server
 * action es un `fetch` por debajo. Sin conexión —el metro, el ascensor— la
 * promesa RECHAZA con `TypeError: Failed to fetch`; dentro de un
 * `startTransition(async …)` React sube ese rechazo al error boundary más
 * cercano, y `(app)/error.tsx` sustituía el formulario entero: lo escrito se
 * perdía.
 *
 * Aquí el rechazo se convierte en un resultado más, con la MISMA forma que ya
 * devuelven las acciones (`{ ok: false, error }`), así que quien llama no
 * cambia su manera de leerlo: enseña el error, deja el formulario intacto y el
 * botón listo para reintentar. La forma de respuesta de las acciones no se toca.
 *
 * Lo que NO se traga: los errores de control de Next (`redirect()`,
 * `notFound()`…), que deben seguir su camino (`unstable_rethrow`).
 *
 * Si el navegador ya sabe que no hay red (`navigator.onLine === false`), ni se
 * intenta: así no hay ninguna petición a medias que pudiera llegar al servidor
 * y perder su respuesta (reintentar duplicaría).
 */

export type FalloLlamada = { ok: false; error: string; sinConexion: boolean };

/**
 * El participio de lo que no ha llegado a hacerse: «guardado», «borrado»,
 * «revocado»… Va en masculino singular: «no se ha ___».
 */
export type Participio = string;

export function mensajeSinConexion(participio: Participio = "guardado") {
  return `Sin conexión: no se ha ${participio}. Revisa la red y vuelve a intentarlo.`;
}

export function mensajeFallo(participio: Participio = "guardado") {
  return `No se ha ${participio}: algo ha fallado por el camino. Vuelve a intentarlo en un momento.`;
}

/**
 * ¿El rechazo es de la red y no del servidor? `fetch` rechaza con un `TypeError`
 * cuando no llega respuesta («Failed to fetch» en Chrome, «Load failed» en
 * Safari, «NetworkError…» en Firefox). Si el navegador dice que está sin red,
 * también lo es, sea cual sea el mensaje.
 */
export function esFalloDeRed(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (!(error instanceof TypeError)) return false;
  return /fetch|network|load failed|conexi/i.test(error.message);
}

export async function llamarAccion<T>(
  accion: () => Promise<T>,
  participio: Participio = "guardado",
): Promise<T | FalloLlamada> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, error: mensajeSinConexion(participio), sinConexion: true };
  }
  try {
    return await accion();
  } catch (error) {
    unstable_rethrow(error);
    const sinConexion = esFalloDeRed(error);
    // Queda rastro en la consola para depurar, pero el usuario ve un mensaje.
    console.error("La acción no ha llegado a completarse:", error);
    return {
      ok: false,
      error: sinConexion ? mensajeSinConexion(participio) : mensajeFallo(participio),
      sinConexion,
    };
  }
}

/**
 * Lo mismo para una LECTURA hecha desde el cliente (un buscador, el cierre de
 * mes): supabase-js no lanza sin red, devuelve un `error`. Sin esto, la lista
 * vacía se leía como «no hay resultados» cuando lo que no había era conexión
 * (hallazgo B-4). `que` es lo que no se ha podido traer: «los gastos».
 */
export function mensajeErrorLectura(error: { message?: string } | null | undefined, que: string) {
  const sinRed =
    (typeof navigator !== "undefined" && navigator.onLine === false) ||
    /fetch|network|load failed/i.test(error?.message ?? "");
  return sinRed
    ? `Sin conexión: no se han podido cargar ${que}. Revisa la red y vuelve a intentarlo.`
    : `No se han podido cargar ${que}. Vuelve a intentarlo en un momento.`;
}
