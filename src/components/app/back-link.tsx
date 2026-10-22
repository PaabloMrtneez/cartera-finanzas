"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { parentTab } from "@/lib/nav";

/**
 * La flecha de volver de la cabecera, SOLO en móvil.
 *
 * En móvil las pantallas secundarias cuelgan de una pestaña de la barra inferior
 * y no había forma de subir un nivel desde la cabecera; en escritorio esas mismas
 * pantallas son entradas de primer nivel de la barra lateral, así que aquí sobra
 * (`lg:hidden`).
 *
 * Apunta a la pestaña madre calculada en `parentTab`, no a `history.back()`: es
 * determinista y funciona igual llegando por un enlace profundo. En las cuatro
 * pestañas principales `parentTab` devuelve `null` y esto no pinta nada.
 */
export function BackLink() {
  const pathname = usePathname();
  const madre = parentTab(pathname);
  if (!madre) return null;

  return (
    <Link
      href={madre.href}
      aria-label={`Volver a ${madre.label}`}
      className="pulsable toque relative -ml-2 flex size-10 shrink-0 items-center justify-center rounded-full text-accent-text lg:hidden"
    >
      <Icon name="chevron-left" size={26} />
    </Link>
  );
}
