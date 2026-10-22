"use client";

import { useEffect, useRef, useState } from "react";

/**
 * La mecánica de LECTURA que comparten todos los gráficos de la app: mide su
 * caja (para dibujar en píxeles reales) y traduce dedo, ratón y teclado a un
 * índice activo.
 *
 * POR QUÉ MIDE LA CAJA EN VEZ DE ESTIRAR UN viewBox. Con un viewBox estirado
 * (`preserveAspectRatio="none"`) la escala es distinta en cada eje: los
 * círculos salen ovalados y no hay forma de saber a cuántos píxeles cae el día
 * 12, que es justo lo que hace falta para saber qué punto toca el dedo.
 *
 * QUÉ PASA AL TOCAR. Con el ratón basta pasar por encima y la lectura se va al
 * salir. Con el dedo hay que tocar, y la lectura se QUEDA al levantar: un toque
 * rápido tiene que servir de algo. `touch-action: pan-y` (lo pone quien la usa)
 * deja desplazar la página en vertical y se queda el arrastre horizontal.
 *
 * TOCAR OTRA VEZ ES IR. Si el gráfico sabe adónde lleva cada dato (los
 * movimientos de ese mes, por ejemplo), `alConfirmar` se llama al volver a
 * tocar el dato que YA se estaba leyendo —con el ratón, al hacer clic sobre el
 * que se tiene debajo—, o con Intro desde el teclado. El primer toque lee; el
 * segundo va. Así leer nunca te saca de la pantalla por accidente.
 */
export function useLectura({
  total,
  altoBase,
  indice,
  alConfirmar,
  inicio,
  pasoVertical,
}: {
  total: number;
  /** El alto de reserva hasta poder medir; debe casar con la clase de móvil. */
  altoBase: number;
  /**
   * De la posición dentro de la caja al índice de dato. Casi siempre basta la
   * x y el ancho; una REJILLA (el calendario, el mapa de calor) usa también la
   * y y el alto.
   */
  indice: (x: number, ancho: number, y: number, alto: number) => number;
  alConfirmar?: (i: number) => void;
  /**
   * Dónde cae la primera flecha: el presente. Por defecto el último dato; en
   * una curva que acaba antes (el mes en curso, a medias), el último con dato.
   */
  inicio?: number;
  /**
   * En una rejilla, cuánto salta el índice con las flechas arriba y abajo (el
   * número de columnas). Sin él, arriba y abajo no hacen nada y la página se
   * desplaza como siempre.
   */
  pasoVertical?: number;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const pulsando = useRef(false);
  // El índice que ya se leía ANTES de este toque, y si el dedo se ha movido a
  // otro dato durante el arrastre: un arrastre nunca confirma.
  const previo = useRef<number | null>(null);
  const arrastro = useRef(false);
  // Un ancho de arranque cualquiera para el render del servidor; en cuanto
  // monta, la medida de verdad.
  const [ancho, setAncho] = useState(320);
  const [alto, setAlto] = useState(altoBase);
  const [activo, setActivoCrudo] = useState<number | null>(null);
  const activoRef = useRef<number | null>(null);

  const setActivo = (i: number | null | ((a: number | null) => number | null)) => {
    setActivoCrudo((a) => {
      const siguiente = typeof i === "function" ? i(a) : i;
      activoRef.current = siguiente;
      return siguiente;
    });
  };

  useEffect(() => {
    const nodo = caja.current;
    if (!nodo) return;
    // Una medida a mano primero: el observador no notifica hasta que el
    // navegador pinta, y una pestaña en segundo plano no pinta. Un cero es que
    // aún no se ve (dentro de un diálogo cerrado): entonces, al observador.
    const medida = nodo.getBoundingClientRect();
    if (medida.width > 0) setAncho(medida.width);
    if (medida.height > 0) setAlto(medida.height);
    const observador = new ResizeObserver(([entrada]) => {
      const { width, height } = entrada.contentRect;
      if (width > 0) setAncho(width);
      if (height > 0) setAlto(height);
    });
    observador.observe(nodo);
    return () => observador.disconnect();
  }, []);

  // La lectura del puntero, de fotograma en fotograma (ver onPointerMove).
  const fotograma = useRef<number | null>(null);
  const ultimaPosicion = useRef<{ x: number; y: number } | null>(null);
  const cancelarFotograma = () => {
    if (fotograma.current !== null) cancelAnimationFrame(fotograma.current);
    fotograma.current = null;
  };
  useEffect(() => cancelarFotograma, []);

  const acotar = (i: number) => Math.min(Math.max(i, 0), Math.max(total - 1, 0));

  const desde = (clientX: number, clientY: number) => {
    const r = caja.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return acotar(indice(clientX - r.left, r.width, clientY - r.top, r.height));
  };

  const manejadores = {
    onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      pulsando.current = true;
      arrastro.current = false;
      cancelarFotograma();
      previo.current = activoRef.current;
      // Capturar el puntero mantiene el seguimiento aunque el dedo se salga.
      // Si el puntero ya no está activo el navegador protesta, y eso no puede
      // costar el toque.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Sin captura se sigue leyendo; solo que el arrastre acaba al salir.
      }
      setActivo(desde(e.clientX, e.clientY));
    },
    onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
      if (!pulsando.current && e.pointerType !== "mouse") return;
      // Un ratón o un dedo mandan más eventos que fotogramas pinta la
      // pantalla. Se lee como mucho una vez por fotograma (con la ÚLTIMA
      // posición) y solo se vuelve a pintar si cambia el punto leído: barrer
      // una curva de doce puntos son doce renders, no cientos.
      ultimaPosicion.current = { x: e.clientX, y: e.clientY };
      if (fotograma.current !== null) return;
      fotograma.current = requestAnimationFrame(() => {
        fotograma.current = null;
        const p = ultimaPosicion.current;
        if (!p) return;
        const i = desde(p.x, p.y);
        if (i === activoRef.current) return;
        if (pulsando.current) arrastro.current = true;
        setActivo(i);
      });
    },
    onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
      const confirmar =
        pulsando.current &&
        !arrastro.current &&
        alConfirmar !== undefined &&
        previo.current !== null &&
        previo.current === desde(e.clientX, e.clientY);
      pulsando.current = false;
      if (confirmar && previo.current !== null) alConfirmar(previo.current);
    },
    onPointerCancel() {
      pulsando.current = false;
    },
    onPointerLeave(e: React.PointerEvent<HTMLDivElement>) {
      pulsando.current = false;
      cancelarFotograma();
      // Con el dedo, salir es haber levantado: limpiar aquí dejaría el toque
      // sin enseñar nada.
      if (e.pointerType === "mouse") setActivo(null);
    },
    onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
      if (e.key === "Escape") return setActivo(null);
      if (e.key === "Enter" && alConfirmar && activoRef.current !== null) {
        e.preventDefault();
        return alConfirmar(activoRef.current);
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        return setActivo(e.key === "Home" ? 0 : total - 1);
      }
      const vertical = pasoVertical ?? 0;
      const salto =
        e.key === "ArrowRight"
          ? 1
          : e.key === "ArrowLeft"
            ? -1
            : e.key === "ArrowDown"
              ? vertical
              : e.key === "ArrowUp"
                ? -vertical
                : 0;
      if (salto === 0) return;
      // Sin esto, las flechas desplazarían la página en vez de recorrer.
      e.preventDefault();
      // La primera flecha cae en el presente; las siguientes, recorren.
      setActivo((i) => acotar(i === null ? (inicio ?? total - 1) : i + salto));
    },
  };

  return { caja, ancho, alto, activo, setActivo, manejadores };
}
