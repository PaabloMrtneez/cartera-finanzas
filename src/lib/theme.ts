/**
 * El tema: claro, oscuro o automático. El acento NO se elige.
 *
 * Hubo seis acentos conmutables y se quitaron: seis acentos diluyen la
 * identidad, porque la app no tiene un color, tiene seis a medias. Con Aurora el
 * acento es el espectro iridiscente (y el cian `--accent` para lo sólido), uno
 * solo.
 */
export const THEME_KEY = "cartera:theme";

export const THEMES = ["light", "dark", "auto"] as const;
export type ThemePreference = (typeof THEMES)[number];

/*
 * El OSCURO es la identidad principal de Aurora, así que es el tema por defecto:
 * quien no ha elegido nada entra en oscuro, no en «lo que diga el sistema». El
 * usuario sigue pudiendo cambiar a claro o a auto desde Ajustes.
 */
export const DEFAULT_THEME: ThemePreference = "dark";

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: "Claro",
  dark: "Oscuro",
  auto: "Auto",
};

export function isTheme(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Traduce la preferencia a lo que acaba en el atributo data-theme. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): "light" | "dark" {
  if (preference === "auto") return prefersDark ? "dark" : "light";
  return preference;
}

/**
 * El color de la barra del sistema (`<meta name="theme-color">`) en cada tema.
 * Es el `--bg` de `globals.css`; vive aquí porque lo leen el layout, el
 * manifiesto y el script que pinta el tema antes del primer fotograma, y
 * ninguno de los tres puede leer una variable CSS.
 */
export const THEME_COLOR: Record<"light" | "dark", string> = {
  light: "#eef1f7",
  dark: "#06080f",
};

/**
 * Pone la barra del sistema del color del tema que se VE, no del que prefiere
 * el sistema operativo. Las etiquetas `theme-color` salen del layout con su
 * `media` (claro/oscuro del sistema), pero el tema de Cartera lo elige la
 * persona y por defecto es oscuro: con el sistema en claro, la barra quedaba
 * porcelana sobre una app negra. Solo en el cliente.
 */
export function pintarColorDeSistema(resuelto: "light" | "dark") {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", THEME_COLOR[resuelto]);
  }
}
