import { parentTab } from "@/lib/nav";

/**
 * Qué transición le toca a un cambio de pantalla, imitando la navegación de iOS.
 *
 * iOS tiene tres gramáticas y Cartera usa las tres:
 *
 *  · CAMBIO DE PESTAÑA: instantáneo. Tocar Resumen, Movimientos, Cuentas o
 *    Ajustes en la barra no anima nada, igual que un UITabBarController. Es lo
 *    que más se toca al día, y a esa frecuencia cualquier movimiento es peaje.
 *  · PUSH / POP: bajar un nivel (Cuentas → Patrimonio, Movimientos → un
 *    movimiento) desliza la pantalla nueva desde la derecha; subir es lo inverso.
 *  · HOJA: una TAREA que se abre encima y se cierra («Nuevo movimiento») sube
 *    desde abajo y, al acabar, baja.
 *
 * La dirección sale de la JERARQUÍA de la app (`parentTab`, la misma que pinta
 * la flecha de volver), no de la URL a ciegas. Cuando no se puede decidir con
 * certeza —dos pantallas del mismo nivel, un salto lateral—, la respuesta es
 * `ninguna`: mejor un cambio seco que un deslizamiento en la dirección
 * equivocada, que desorienta más que no animar.
 *
 * Es una función pura y vive en `src/lib` a propósito: la usa un componente de
 * cliente, pero la regla se prueba sin navegador.
 */
export type Direccion = "push" | "pop" | "hoja-sube" | "hoja-baja" | "ninguna";

/**
 * Rutas que se presentan como hoja. Es una lista y no una comprobación suelta
 * porque la regla es del tipo de pantalla: se presenta como hoja lo que es una
 * TAREA —se abre encima de lo que estabas haciendo, se termina y se cierra—, no
 * lo que es un SITIO al que vas.
 */
export const HOJAS = ["/movimientos/nuevo"] as const;

export function esHoja(pathname: string): boolean {
  return (HOJAS as readonly string[]).includes(pathname);
}

/** Las cuatro raíces de la barra inferior: nivel 0 de la jerarquía. */
function pestañaDe(pathname: string): string {
  return parentTab(pathname)?.href ?? pathname;
}

/**
 * Profundidad en la pila de navegación de móvil: 0 en una pestaña, 1 en lo que
 * cuelga de ella (Patrimonio, un movimiento concreto…). Hoy no hay un tercer
 * nivel; si llega, la regla del prefijo de abajo ya lo ordena.
 */
function nivel(pathname: string): number {
  return parentTab(pathname) ? 1 : 0;
}

export function direccionNavegacion(
  desde: string,
  hacia: string,
  {
    historial = false,
  }: {
    /**
     * La navegación viene del historial (atrás/adelante del navegador). Cambia
     * una cosa: volver desde un detalle a OTRA pestaña es un pop —deshaces lo
     * que hiciste—, mientras que tocar esa pestaña en la barra es un cambio de
     * pestaña y no anima.
     */
    historial?: boolean;
  } = {},
): Direccion {
  if (desde === hacia) return "ninguna";

  // La hoja manda sobre todo lo demás: sube al abrirla y baja al cerrarla, vaya
  // a donde vaya después (guardar lleva a Movimientos, cancelar vuelve atrás).
  if (esHoja(hacia)) return esHoja(desde) ? "ninguna" : "hoja-sube";
  if (esHoja(desde)) return "hoja-baja";

  // Subrutas literales (un tercer nivel futuro): la URL más larga es la de dentro.
  if (hacia.startsWith(`${desde}/`)) return "push";
  if (desde.startsWith(`${hacia}/`)) return "pop";

  const nDesde = nivel(desde);
  const nHacia = nivel(hacia);
  if (nDesde === nHacia) return "ninguna";

  // Ir a la raíz de OTRA pestaña desde dentro de una es tocar la barra: cambio
  // de pestaña, sin animación. Salvo que venga del historial, que es deshacer.
  if (nHacia === 0 && pestañaDe(desde) !== hacia && !historial) return "ninguna";

  return nHacia > nDesde ? "push" : "pop";
}
