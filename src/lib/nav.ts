/**
 * La navegación de la app, en un solo sitio.
 *
 * En móvil solo caben cuatro pestañas más el botón de añadir, así que
 * Patrimonio, Inversiones y Metas cuelgan de Cuentas, y Fijos, Préstamos y
 * Categorías de Ajustes. En escritorio, donde la barra lateral tiene sitio, las
 * once secciones son entradas de primer nivel.
 *
 * `covers` es lo que hace que la pestaña de Cuentas siga iluminada mientras
 * estás dentro de Patrimonio.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** Rutas que también marcan esta entrada como activa. */
  covers?: string[];
  /** Una línea de qué hay dentro, para los accesos de móvil. */
  hint?: string;
};

/** Las once secciones, en el orden de la barra lateral de escritorio. */
export const SECTIONS: NavItem[] = [
  { href: "/resumen", label: "Resumen", icon: "chart-pie" },
  { href: "/movimientos", label: "Movimientos", icon: "list" },
  { href: "/cuentas", label: "Cuentas", icon: "wallet" },
  { href: "/patrimonio", label: "Patrimonio", icon: "trending-up" },
  { href: "/inversiones", label: "Inversiones", icon: "chart-line" },
  { href: "/metas", label: "Metas", icon: "piggy-bank" },
  { href: "/analisis", label: "Análisis", icon: "lightbulb" },
  // Antes eran dos entradas, Suscripciones e Ingresos recurrentes: ahora son
  // los dos grupos de esta pantalla (y las direcciones viejas redirigen aquí).
  { href: "/fijos", label: "Fijos", icon: "calendar-sync" },
  { href: "/prestamos", label: "Préstamos", icon: "hand-coins" },
  { href: "/categorias", label: "Categorías", icon: "tags" },
  { href: "/ajustes", label: "Ajustes", icon: "settings" },
];

/** Las cuatro pestañas de la barra inferior de móvil. */
const TAB_HREFS = ["/resumen", "/movimientos", "/cuentas", "/ajustes"] as const;

/**
 * Qué cuelga de cada pestaña en móvil.
 *
 * Esta es la ÚNICA definición: de aquí salen tanto los enlaces que pinta la
 * pantalla madre como el resaltado de la pestaña mientras estás dentro. Cuando
 * eran dos listas separadas, se declaró el resaltado y se olvidaron los
 * enlaces: Inversiones, Análisis y Suscripciones quedaron sin una sola forma de
 * llegar a ellas desde un móvil, porque la barra lateral es solo de escritorio.
 *
 * En escritorio esto no se pinta: allí las once secciones son entradas de
 * primer nivel en la barra lateral y repetirlas sería ruido.
 */
export const SUBSECTIONS: Record<string, NavItem[]> = {
  "/resumen": [
    {
      href: "/analisis",
      label: "Análisis",
      icon: "lightbulb",
      hint: "Límites, hallazgos y comparativa con tu media",
    },
  ],
  "/cuentas": [
    {
      href: "/patrimonio",
      label: "Patrimonio",
      icon: "trending-up",
      hint: "Cuánto tienes en total y cómo evoluciona",
    },
    {
      href: "/inversiones",
      label: "Inversiones",
      icon: "chart-line",
      hint: "Posiciones, valoraciones y rendimiento real",
    },
    {
      href: "/metas",
      label: "Metas",
      icon: "piggy-bank",
      hint: "Objetivos de ahorro y cuánto llevas de cada uno",
    },
  ],
  "/ajustes": [
    {
      href: "/fijos",
      label: "Fijos",
      icon: "calendar-sync",
      hint: "Gastos e ingresos que se repiten: suscripciones, la nómina",
    },
    {
      href: "/prestamos",
      label: "Préstamos",
      icon: "hand-coins",
      hint: "Lo que debes, la cuota de cada mes y lo que pagas en intereses",
    },
    { href: "/categorias", label: "Categorías", icon: "tags" },
    { href: "/reglas", label: "Reglas de comercio", icon: "repeat" },
    { href: "/atajo", label: "El Atajo del iPhone", icon: "smartphone" },
  ],
};

export const TABS: NavItem[] = TAB_HREFS.map((href) => {
  const seccion = SECTIONS.find((s) => s.href === href)!;
  const hijas = SUBSECTIONS[href]?.map((s) => s.href) ?? [];
  return hijas.length > 0 ? { ...seccion, covers: hijas } : seccion;
});

export function isActive(item: NavItem, pathname: string): boolean {
  const matches = (route: string) => pathname === route || pathname.startsWith(`${route}/`);
  return matches(item.href) || (item.covers?.some(matches) ?? false);
}

/**
 * Secundarias que NO cuelgan de la barra de accesos de móvil (`SubNav`) pero que
 * a efectos de la flecha de volver sí tienen una pestaña madre. Importar se
 * alcanza desde Ajustes (Exportar) y desde la guía del Atajo, así que vuelve a
 * Ajustes. Se lleva aquí y no a `SUBSECTIONS` para no meterla en el `SubNav`,
 * donde no pinta nada.
 */
const EXTRA_PARENTS: Record<string, string> = {
  "/importar": "/ajustes",
};

/**
 * La pestaña de la que cuelga una ruta secundaria de móvil, o `null` si es una
 * pestaña principal (o una ruta que no cuelga de ninguna). Es lo que decide si
 * la cabecera de móvil enseña una flecha de volver, y a dónde apunta.
 *
 * Se prefiere un enlace a la pestaña madre —determinista— antes que un
 * `history.back()`: funciona igual llegando por un enlace profundo o tecleando
 * la URL, sin el caso sin historial que dejaría la flecha muerta.
 */
export function parentTab(pathname: string): NavItem | null {
  const seccion = (href: string) => SECTIONS.find((s) => s.href === href) ?? null;

  // Una pestaña principal, tal cual, nunca lleva flecha.
  if (TAB_HREFS.some((href) => href === pathname)) return null;

  // Crear un movimiento es una hoja que se abre encima y se cierra con su propio
  // gesto: no es un sitio que cuelgue de una pestaña, así que no lleva flecha.
  if (pathname === "/movimientos/nuevo") return null;

  // Las secundarias declaradas en SUBSECTIONS (y sus subrutas) vuelven a su madre.
  for (const href of TAB_HREFS) {
    const hijas = SUBSECTIONS[href] ?? [];
    if (hijas.some((h) => pathname === h.href || pathname.startsWith(`${h.href}/`))) {
      return seccion(href);
    }
  }

  // Las secundarias sueltas (p. ej. Importar), por su mapa propio.
  for (const [ruta, madre] of Object.entries(EXTRA_PARENTS)) {
    if (pathname === ruta || pathname.startsWith(`${ruta}/`)) return seccion(madre);
  }

  // El detalle que cuelga directamente de una pestaña, como un movimiento.
  for (const href of TAB_HREFS) {
    if (pathname.startsWith(`${href}/`)) return seccion(href);
  }

  return null;
}

/** Título de la barra superior de escritorio para una ruta. */
export function sectionTitle(pathname: string): string {
  return SECTIONS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))?.label ?? "Cartera";
}
