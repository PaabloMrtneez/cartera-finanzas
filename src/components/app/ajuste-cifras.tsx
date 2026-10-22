"use client";

import { useEffect } from "react";

/** Por debajo de esto una cifra grande deja de serlo: no se encoge más. */
const MINIMO_PX = 24;

/**
 * Encoge la cifra héroe —y las lecturas grandes de los gráficos, marcadas con
 * `cifra-ajustable`— que no cabe en su línea (hallazgo M-1).
 *
 * `cifra-hero` ya baja de cuerpo con la ventana (globals.css), pero CSS no sabe
 * cuánto mide un texto: con siete u ocho cifras («−10.064.903,79 €») la cifra
 * seguía sacando la pantalla entera de la ventana a 320 o 375 px. Esto la mide
 * ya pintada y, si su contenido es más ancho que su caja, le pone el cuerpo
 * justo para caber. Una sola vez por cambio, no por fotograma: escucha el
 * tamaño de la ventana y los cambios de texto (la cifra que «cuenta» al llegar,
 * la lectura de un gráfico al pasar el dedo).
 *
 * Va una vez en el armazón de la app y se ocupa de todas: ninguna pantalla
 * tiene que acordarse.
 */
export function AjusteCifras() {
  useEffect(() => {
    // En tres pasadas —quitar, medir, poner— para que todas las cifras de la
    // pantalla cuesten UN cálculo de maquetación, no uno por cifra.
    const ajustarTodas = () => {
      const cifras = [
        ...document.querySelectorAll<HTMLElement>("main .cifra-hero, main .cifra-ajustable"),
      ];
      // Se mide desde el cuerpo del CSS, sin el ajuste anterior.
      for (const el of cifras) el.style.fontSize = "";
      const medidas = cifras.map((el) => ({
        el,
        caja: el.clientWidth,
        contenido: el.scrollWidth,
        base: parseFloat(getComputedStyle(el).fontSize),
      }));
      for (const { el, caja, contenido, base } of medidas) {
        if (!caja || contenido <= caja) continue;
        const justo = Math.max(MINIMO_PX, Math.floor(((base * caja) / contenido) * 2) / 2);
        el.style.fontSize = `${justo}px`;
      }
    };

    let pendiente = 0;
    const programar = () => {
      if (pendiente) return;
      pendiente = requestAnimationFrame(() => {
        pendiente = 0;
        ajustarTodas();
      });
    };

    ajustarTodas();
    // El texto cambia (cuenta, lectura, navegación): se reajusta en el siguiente
    // fotograma, agrupando todos los cambios de ese fotograma en una medida.
    const observador = new MutationObserver(programar);
    const main = document.querySelector("main");
    if (main) observador.observe(main, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", programar);
    return () => {
      observador.disconnect();
      window.removeEventListener("resize", programar);
      cancelAnimationFrame(pendiente);
    };
  }, []);

  return null;
}
