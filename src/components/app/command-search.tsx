"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

/** Evento propio para abrirla desde cualquier sitio sin compartir estado. */
export const ABRIR_BUSQUEDA = "cartera:buscar";

export function abrirBusqueda() {
  window.dispatchEvent(new Event(ABRIR_BUSQUEDA));
}

/*
 * El cuerpo de la búsqueda —Radix y `@supabase/supabase-js`— se carga a demanda.
 *
 * Este armazón vive en el layout, así que se pinta en TODAS las pantallas. Si
 * arrastrara el diálogo, cargaría el cliente de Supabase (~65 KB comprimidos) y
 * Radix en cada una, para algo que solo se usa con ⌘K en escritorio. Difiriendo
 * el cuerpo, esos kilobytes no entran en el paquete inicial de ninguna pantalla:
 * llegan la primera vez que se pulsa el atajo.
 *
 * `ssr: false` porque no hay nada que pre-renderizar en el servidor: el diálogo
 * no existe hasta que el usuario lo abre.
 */
const Dialogo = dynamic(() => import("./command-search-dialog"), { ssr: false });

/**
 * Búsqueda global. Se abre con ⌘K o Ctrl+K, y busca en todo el histórico: en la
 * descripción, en el comercio que manda el Atajo, y en los nombres de categorías
 * y cuentas.
 *
 * El prototipo la sitúa solo en escritorio, y tiene sentido: en móvil el
 * buscador de Movimientos está a un toque y no hay teclado con atajos.
 *
 * Aquí solo queda lo imprescindible para saber CUÁNDO abrirla: el atajo de
 * teclado y el evento propio. El resto se carga con el primer abrir.
 */
export function CommandSearch() {
  const [open, setOpen] = useState(false);
  // Una vez montado, se mantiene: reabrir es instantáneo y no recarga el chunk.
  const [montado, setMontado] = useState(false);

  // El atajo se registra siempre. Y se escucha además un evento propio, para
  // que el botón de la barra lateral pueda abrirla sin compartir estado.
  useEffect(() => {
    const alPulsar = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMontado(true);
        setOpen((previo) => !previo);
      }
    };
    const alPedir = () => {
      setMontado(true);
      setOpen(true);
    };

    window.addEventListener("keydown", alPulsar);
    window.addEventListener(ABRIR_BUSQUEDA, alPedir);
    return () => {
      window.removeEventListener("keydown", alPulsar);
      window.removeEventListener(ABRIR_BUSQUEDA, alPedir);
    };
  }, []);

  if (!montado) return null;
  return <Dialogo open={open} onOpenChange={setOpen} />;
}
