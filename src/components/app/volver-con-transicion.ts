/**
 * Volver atrás (`router.back()`) CON la transición de iOS: la hoja que baja al
 * cancelar «Nuevo movimiento», el pop al cancelar la edición de un movimiento.
 *
 * POR QUÉ HACE FALTA. Lo que llega por `popstate` React lo aplica en síncrono
 * —para restaurar el scroll— y no pasa por el `<ViewTransition>` de
 * `PageTransition`: la pantalla cambiaba en seco. Aquí se abre la transición de
 * vista a mano y se le dan a las dos pantallas los MISMOS
 * `view-transition-class` que les pone React (`pantalla-sale` /
 * `pantalla-entra`), así que el CSS de globals.css las mueve igual que en una
 * navegación normal. La dirección (`hoja-baja`, `pop`) la escribe en `data-nav`
 * el efecto de layout de `PageTransition`, que corre durante ese render síncrono,
 * dentro de la actualización: llega antes de que se creen los pseudoelementos.
 *
 * Solo en móvil, como el resto de transiciones de pantalla. Sin la API (Safari <
 * 18) o en escritorio, es un `router.back()` sin más.
 */
export function volverConTransicion(router: { back: () => void }) {
  const sale = document.querySelector<HTMLElement>("[data-pantalla]");
  if (
    !sale ||
    typeof document.startViewTransition !== "function" ||
    !window.matchMedia("(width < 1024px)").matches
  ) {
    router.back();
    return;
  }

  nombrar(sale, "pantalla-atras-sale", "pantalla-sale");

  const transicion = document.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        // La pantalla nueva está montada cuando la vieja ha salido del DOM.
        // Un observador y no un temporizador: si el destino tarda en pintar,
        // la instantánea nueva no se hace sobre la pantalla vieja.
        const listo = () => {
          if (sale.isConnected) return;
          observador.disconnect();
          clearTimeout(tope);
          const entra = document.querySelector<HTMLElement>("[data-pantalla]");
          if (entra) nombrar(entra, "pantalla-atras-entra", "pantalla-entra");
          resolve();
        };
        const observador = new MutationObserver(listo);
        observador.observe(document.body, { childList: true, subtree: true });
        // Red de seguridad: la API aborta la transición si la actualización
        // tarda demasiado; mejor soltarla a tiempo y que cambie en seco.
        const tope = setTimeout(() => {
          observador.disconnect();
          resolve();
        }, 1500);
        router.back();
      }),
  );

  transicion.finished.finally(() => {
    document.querySelectorAll<HTMLElement>("[data-pantalla]").forEach(desnombrar);
    desnombrar(sale);
  });
}

function nombrar(el: HTMLElement, nombre: string, clase: string) {
  el.style.viewTransitionName = nombre;
  el.style.setProperty("view-transition-class", clase);
}

function desnombrar(el: HTMLElement) {
  el.style.removeProperty("view-transition-name");
  el.style.removeProperty("view-transition-class");
}
