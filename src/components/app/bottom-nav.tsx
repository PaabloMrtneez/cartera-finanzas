"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { fabClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { TABS, isActive } from "@/lib/nav";

/**
 * Barra inferior de móvil: cuatro pestañas y el botón de añadir en el centro.
 *
 * Solo caben cuatro, de ahí que Patrimonio e Inversiones se agrupen bajo
 * Cuentas, y Categorías y Fijos bajo Ajustes. El relleno inferior es
 * para el área segura del iPhone, la franja del indicador de inicio, y va
 * DENTRO del elemento con el cristal: el fondo llega hasta el borde.
 *
 * El FALDÓN (`before:`) es una prolongación del mismo fondo por debajo del
 * borde de la pantalla, invisible en reposo. Si un iOS antiguo, sin
 * `overscroll-behavior` (ver «Sin rebote elástico» en globals.css), aún rebota
 * y aparta la barra de su sitio, lo que asoma debajo es más barra y no un hueco.
 */
export function BottomNav({ pendingCount = 0 }: { pendingCount?: number }) {
  const pathname = usePathname();
  const [izquierda, derecha] = [TABS.slice(0, 2), TABS.slice(2)];

  return (
    <nav
      aria-label="Secciones"
      className={cn(
        "glass fixed inset-x-0 bottom-0 z-30 hair-t border-hairline lg:hidden",
        "pb-[env(safe-area-inset-bottom)]",
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-full before:h-24",
        "before:bg-[var(--chrome)]",
      )}
      /*
        Nombre propio en las transiciones de pantalla: así la barra no viaja
        dentro de la instantánea de la página ni la tapa la pantalla que entra.
        En globals.css su grupo va quieto y por encima (ver «Transiciones de
        pantalla»).
      */
      style={{ viewTransitionName: "barra-pestanas" }}
    >
      {/*
        Las pestañas se reparten el ancho según lo que miden (`flex-auto`, no
        `flex-1`): con los rótulos a 13 px, «Movimientos» no cabe en una quinta
        parte de 320 px, pero los cuatro rótulos y el «+» juntos sí caben, y así
        cada uno toma lo suyo más una parte igual del sobrante.
      */}
      <ul className="mx-auto flex max-w-lg items-center gap-px px-1">
        {izquierda.map((tab) => (
          <Tab
            key={tab.href}
            tab={tab}
            pathname={pathname}
            badge={tab.href === "/movimientos" ? pendingCount : 0}
          />
        ))}

        <li className="flex flex-auto justify-center">
          {/* El propio enlace lleva el aspecto del botón: nada de <button>
              anidado dentro del <a>, que dejaba al icono sin nombre accesible. */}
          <Link href="/movimientos/nuevo" aria-label="Añadir movimiento" className={fabClasses}>
            <Icon name="plus" size={26} />
          </Link>
        </li>

        {derecha.map((tab) => (
          <Tab key={tab.href} tab={tab} pathname={pathname} badge={0} />
        ))}
      </ul>
    </nav>
  );
}

function Tab({
  tab,
  pathname,
  badge,
}: {
  tab: (typeof TABS)[number];
  pathname: string;
  badge: number;
}) {
  const active = isActive(tab, pathname);

  return (
    <li className="min-w-0 flex-auto">
      <Link
        href={tab.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          // 13 px, el mínimo de la app (antes 11: hallazgo M-4). Para que quepa
          // sin crecer la barra, el icono pasa a 22 px y el hueco a 2.
          "flex h-[52px] flex-col items-center justify-center gap-[2px] whitespace-nowrap",
          "text-[13px] leading-4 font-medium tracking-[-0.01em]",
          // `text-chrome-muted`, no `text-muted`: esta etiqueta se apoya sobre
          // el cristal translúcido de la barra, y cuando detrás pasa algo de color
          // el fondo efectivo cambia y `--muted` no llega a 4,5:1. Ver el token.
          active ? "text-accent-text" : "text-chrome-muted",
        )}
      >
        <span className="relative">
          <Icon name={tab.icon} size={22} />
          {badge > 0 ? (
            <span
              aria-hidden
              className={cn(
                "absolute -top-[6px] -right-[11px] flex h-[19px] min-w-[19px] items-center justify-center",
                // El color de gasto del tema y su tinta: AA en claro y en oscuro.
                "rounded-full bg-expense px-1 text-[13px] leading-none font-bold text-bg tabular-nums",
              )}
            >
              {badge}
            </span>
          ) : null}
        </span>
        {tab.label}
        {badge > 0 ? (
          <span className="sr-only">
            , {badge} {badge === 1 ? "pendiente" : "pendientes"}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
