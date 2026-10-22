"use client";

import { usePathname } from "next/navigation";
// Precarga al sobrevolar, no al verse: son trece enlaces siempre a la vista.
import { EnlaceIntencion as Link } from "@/components/app/enlace-intencion";
import { useSyncExternalStore } from "react";
import { abrirBusqueda } from "@/components/app/command-search";
import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { SECTIONS, isActive } from "@/lib/nav";

/**
 * Barra lateral de escritorio. A diferencia de la barra inferior de móvil, aquí
 * no lleva cristal: es una columna opaca, como en el prototipo.
 */
export function Sidebar({ pendingCount = 0 }: { pendingCount?: number }) {
  const pathname = usePathname();
  // El atajo se pinta como lo lee cada teclado: ⌘K en un Mac y Ctrl K en el
  // resto. Antes era siempre ⌘K, y en Windows esa tecla no existe. El servidor
  // no sabe qué teclado hay: pinta ⌘K y el cliente lo corrige al hidratar.
  const esMac = useSyncExternalStore(
    suscribirNada,
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => true,
  );

  return (
    /*
      Anclada a la ventana: antes se desplazaba con la página, y en cuanto
      bajabas por una pantalla larga (Inversiones, Análisis) la navegación y el
      botón de añadir se iban por arriba y quedaba una columna vacía. Mide
      EXACTAMENTE la ventana (`h-dvh`) y, si no le cupiera el contenido, hace
      scroll propio: nunca es un panel anclado más alto que la pantalla.
    */
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain hair-r border-hairline bg-surface px-3 py-4 lg:flex">
      <div className="flex items-center gap-[10px] px-[10px]">
        <BrandMark size={30} />
        <span className="text-[17px] font-semibold tracking-[-0.01em]">Cartera</span>
      </div>

      {/*
        La acción principal de la app. Va al MISMO tamaño que las filas de
        secciones —misma altura, texto e icono—: lo que la distingue no es el
        volumen, sino el material de las acciones principales, el negro con canto
        Aurora.
      */}
      <Link
        href="/movimientos/nuevo"
        className={cn(
          "relative flex min-h-9 items-center justify-center gap-2 rounded-sm px-[10px] whitespace-nowrap",
          "pulsable boton-aurora text-[15px] leading-5 font-semibold",
        )}
      >
        <Icon name="plus" size={18} />
        Añadir movimiento
      </Link>

      {/* Un atajo que nadie sabe que existe no sirve de nada. */}
      <button
        type="button"
        onClick={abrirBusqueda}
        aria-keyshortcuts="Meta+K Control+K"
        className={cn(
          "flex h-9 items-center gap-[10px] rounded-sm bg-surface-2 px-[10px]",
          "text-[14px] font-medium text-muted",
          "transition-colors duration-150 ease-ui hover:text-fg",
        )}
      >
        <Icon name="search" size={16} />
        <span className="flex-1 text-left">Buscar</span>
        {/* Sin opacity: a 0,7 el gris apagado caía a 2,7:1. `muted` a plena
            opacidad ya se lee como pista secundaria y cumple AA. */}
        <kbd className="font-mono text-[13px]">{esMac ? "⌘K" : "Ctrl K"}</kbd>
      </button>

      <nav aria-label="Secciones">
        <ul className="flex flex-col gap-[2px]">
          {SECTIONS.map((section) => {
            const active = isActive(section, pathname);
            const badge = section.href === "/movimientos" ? pendingCount : 0;

            return (
              <li key={section.href}>
                <Link
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-9 items-center gap-[10px] rounded-sm px-[10px] text-[15px]",
                    "transition-colors duration-150 ease-ui",
                    active
                      ? "bg-accent-soft font-semibold text-accent-text"
                      : "font-medium text-muted hover:bg-surface-2",
                  )}
                >
                  <Icon name={section.icon} size={18} />
                  <span className="flex-1">{section.label}</span>
                  {badge > 0 ? (
                    <>
                      {/* El aviso con el color de gasto del tema, no un rojo
                          suelto: pasa AA con su tinta en los dos temas. */}
                      <span
                        aria-hidden
                        className="flex h-[19px] min-w-[19px] items-center justify-center rounded-full bg-expense px-1 text-[13px] leading-none font-bold text-bg tabular-nums"
                      >
                        {badge}
                      </span>
                      <span className="sr-only">
                        , {badge} {badge === 1 ? "pendiente" : "pendientes"}
                      </span>
                    </>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

/** `useSyncExternalStore` pide suscribirse; el teclado no cambia en una sesión. */
function suscribirNada() {
  return () => {};
}
