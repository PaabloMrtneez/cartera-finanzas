"use client";

import { usePathname } from "next/navigation";
import { ViewTransition, useEffect, useLayoutEffect, useRef } from "react";
import { direccionNavegacion } from "@/lib/transicion";

/**
 * La transición entre pantallas, con la gramática de iOS: cambio de pestaña
 * seco, push/pop lateral al bajar o subir un nivel, y hoja que sube desde abajo
 * para «Nuevo movimiento». Qué toca en cada salto lo decide
 * `direccionNavegacion` (src/lib/transicion.ts); cómo se mueve, el CSS de
 * `::view-transition-*` en globals.css.
 *
 * POR QUÉ VIEW TRANSITIONS, Y POR QUÉ AHORA SÍ. Un push de iOS necesita las DOS
 * pantallas a la vez —la vieja se aparta un 30 % mientras la nueva entra—, y
 * React ya ha desmontado la vieja cuando la nueva se pinta. Solo la API de
 * transiciones de vista conserva una instantánea de la saliente. Un intento
 * anterior la quitó porque la barra inferior desaparecía y las pantallas lentas
 * «se reiniciaban». Las dos causas están cerradas:
 *
 *  1. La barra inferior y la lateral llevan su propio `view-transition-name`
 *     con la animación apagada y un `z-index` por encima: ya no viajan dentro de
 *     la instantánea de la página ni quedan tapadas por la pantalla que entra.
 *  2. Antes el `<ViewTransition>` animaba TAMBIÉN las actualizaciones (cada
 *     bloque que llegaba por streaming disparaba un fundido de la pantalla
 *     entera). Ahora `default="none"`: solo animan la entrada y la salida de
 *     una pantalla, que es cuando cambia la `key`.
 *
 * LA DIRECCIÓN, EN EL <html>. La instantánea saliente lleva la clase que tenía
 * en su último render, cuando aún no se sabía adónde se iba. Por eso las clases
 * son fijas (`pantalla-sale` / `pantalla-entra`) y la dirección viaja en
 * `data-nav` del <html>. Se escribe en un efecto de layout, que React ejecuta
 * DENTRO del callback de `startViewTransition`, antes de que el navegador cree
 * los pseudoelementos y resuelva sus animaciones: llega a tiempo. Comprobado en
 * el navegador, no supuesto.
 *
 * Lo que NO anima: el atrás del navegador. React aplica en síncrono lo que
 * llega por `popstate` —para restaurar el scroll— y eso no pasa por una
 * transición de vista: cambia en seco. El «Cancelar» de la hoja, que también
 * vuelve por el historial, sí anima: abre la transición a mano con
 * `volverConTransicion` (volver-con-transicion.ts), que se apoya en el
 * `data-pantalla` de la caja de abajo. La flecha de volver de la cabecera es
 * un enlace normal y sí hace el pop. Sin soporte de la API (Safari < 18), la
 * navegación es simplemente instantánea.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const anterior = useRef(pathname);
  /** La última navegación vino del historial (atrás/adelante). */
  const historial = useRef<{ gestoDelSistema: boolean } | null>(null);

  useEffect(() => {
    const alRecorrerHistorial = (evento: PopStateEvent) => {
      historial.current = {
        // Safari y Chrome ya animan el gesto de deslizar para volver. Si encima
        // animamos nosotros, la pantalla se mueve dos veces.
        gestoDelSistema: Boolean(
          (evento as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition,
        ),
      };
    };
    window.addEventListener("popstate", alRecorrerHistorial);
    return () => window.removeEventListener("popstate", alRecorrerHistorial);
  }, []);

  useLayoutEffect(() => {
    if (anterior.current === pathname) return;
    const viaje = historial.current;
    historial.current = null;
    document.documentElement.dataset.nav = viaje?.gestoDelSistema
      ? "ninguna"
      : direccionNavegacion(anterior.current, pathname, { historial: viaje !== null });
    anterior.current = pathname;
  }, [pathname]);

  return (
    <ViewTransition key={pathname} enter="pantalla-entra" exit="pantalla-sale" default="none">
      {/*
        La caja que se fotografía. Sin fondo propio a propósito: el fondo
        espacio (con sus resplandores) es del <body>; a la instantánea se le
        pone durante la transición, en el CSS, para que una pantalla tape a la
        otra mientras se cruzan.
      */}
      <div data-pantalla className="flex flex-1 flex-col">
        {children}
      </div>
    </ViewTransition>
  );
}
