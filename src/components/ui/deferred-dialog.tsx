"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Difiere el CONTENIDO de un diálogo.
 *
 * El problema: un diálogo con formulario arrastra Radix (`@radix-ui/react-dialog`
 * y su árbol de dependencias) al paquete inicial de la pantalla, aunque el
 * diálogo empiece cerrado y quizá no se abra nunca. Radix se importa a través de
 * `@/components/ui/dialog`, así que cualquier módulo que lo use, aun para pintar
 * solo el disparador, se lo trae entero.
 *
 * La solución: el disparador —un botón normal— se queda en el paquete inicial;
 * el cuerpo del diálogo (Radix y el formulario) se carga con `next/dynamic` la
 * primera vez que se abre. Aquí no hay ningún import de Radix, así que este
 * módulo es ligero y no lo tira de vuelta al paquete inicial.
 *
 * `children` es una función que recibe el estado de apertura y devuelve el
 * cuerpo del diálogo (normalmente un componente cargado con `next/dynamic`). No
 * se monta hasta el primer abrir, y una vez montado se conserva: reabrir es
 * instantáneo y no vuelve a pedir el chunk.
 *
 * El foco vuelve al disparador a mano al cerrar. Radix restaura el foco al
 * elemento que lo tenía cuando SU trapa se montó, pero aquí el cuerpo llega
 * diferido —en un commit posterior— y para entonces ese elemento ya no es el
 * botón, así que su restauración acaba en `<body>`. Como no hay un `Dialog.Trigger`
 * de Radix que registre el disparador, lo capturamos con un ref callback y le
 * devolvemos el foco al cerrar, que es justo lo que haría el Trigger nativo.
 *
 * El disparador va SIEMPRE envuelto en un `span` transparente (`display:contents`,
 * no pinta caja ni altera la maqueta), sin bifurcar por `isValidElement`. Ese es
 * el detalle que cierra un fallo de hidratación sutil: `trigger` se crea en un
 * componente de servidor y cruza la frontera como prop, y React Flight lo entrega
 * de forma NO determinista —a veces como elemento normal, a veces «externalizado»
 * como un lazy (`$$typeof: react.lazy`)—. Si aquí se ramifica con `isValidElement`,
 * el SSR y la hidratación pueden tomar ramas distintas (uno clona el botón, otro
 * lo envuelve) y el DOM no cuadra: «Hydration failed». Envolviendo siempre igual,
 * los dos lados pintan lo mismo. El botón real —el interactivo, que maneja el
 * teclado— va dentro; el `span` solo recoge el click que sube por burbujeo, y
 * `fijarEnvoltorio` saca el botón para devolverle el foco al cerrar.
 */
export function DeferredDialog({
  trigger,
  children,
}: {
  /** El disparador. El click para abrir se capta por burbujeo en el envoltorio. */
  trigger: ReactNode;
  children: (control: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [montado, setMontado] = useState(false);
  // El botón real del disparador, para devolverle el foco al cerrar. El ref cae
  // en el `span` transparente; el botón real es su hijo. Se captura con un ref
  // callback —no leyendo el ref en el render— y se lee solo dentro de un efecto.
  const disparadorRef = useRef<HTMLElement | null>(null);
  const estabaAbierto = useRef(false);

  const fijarEnvoltorio = useCallback((node: HTMLElement | null) => {
    disparadorRef.current =
      node?.querySelector<HTMLElement>("button, [role='button'], a[href], input") ?? node;
  }, []);

  // Abrir. No se re-invoca el onClick del disparador: al no clonarlo, su onClick
  // nativo (si lo tuviera) se dispara solo, y el click sube hasta aquí por
  // burbujeo. Un botón activado por teclado también emite un click que burbujea.
  const abrir = () => {
    setMontado(true);
    setOpen(true);
  };

  // Al cerrar, el foco vuelve al disparador. Radix lo restauraría solo, pero como
  // el cuerpo llega diferido —en un commit posterior— su trapa acaba devolviendo
  // el foco a `<body>`; sin un `Dialog.Trigger` nativo que registre el botón, lo
  // devolvemos a mano. El rAF lo hace tras el ciclo de cierre de Radix, para
  // ganarle.
  useEffect(() => {
    if (estabaAbierto.current && !open) {
      const disparador = disparadorRef.current;
      requestAnimationFrame(() => disparador?.focus());
    }
    estabaAbierto.current = open;
  }, [open]);

  return (
    <>
      <span key="disparador" ref={fijarEnvoltorio} onClick={abrir} style={{ display: "contents" }}>
        {trigger}
      </span>
      {montado ? children({ open, onOpenChange: setOpen }) : null}
    </>
  );
}
