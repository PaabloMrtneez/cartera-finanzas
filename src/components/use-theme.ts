"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_THEME,
  THEME_KEY,
  isTheme,
  pintarColorDeSistema,
  resolveTheme,
  type ThemePreference,
} from "@/lib/theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * La preferencia vive en localStorage, que es estado externo a React. Leerlo
 * con useSyncExternalStore en vez de con useState + useEffect evita el renderizado
 * en cascada y deja que React gestione la hidratación: pinta el valor por
 * defecto en el servidor y salta al real en cuanto hidrata, sin avisos.
 */
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // 'storage' salta cuando el cambio viene de otra pestaña.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readTheme() {
  return localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME;
}

export function useTheme() {
  const storedTheme = useSyncExternalStore(subscribe, readTheme, () => DEFAULT_THEME);

  const theme: ThemePreference = isTheme(storedTheme) ? storedTheme : DEFAULT_THEME;

  // En modo auto hay que seguir al sistema si cambia con la app abierta, por
  // ejemplo al anochecer. Esto solo toca el DOM, no el estado de React.
  useEffect(() => {
    if (theme !== "auto") return;
    const media = window.matchMedia(DARK_QUERY);
    const apply = () => {
      const resuelto = media.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", resuelto);
      pintarColorDeSistema(resuelto);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    localStorage.setItem(THEME_KEY, next);
    const prefersDark = window.matchMedia(DARK_QUERY).matches;
    const resuelto = resolveTheme(next, prefersDark);
    document.documentElement.setAttribute("data-theme", resuelto);
    pintarColorDeSistema(resuelto);
    emit();
  }, []);

  return { theme, setTheme };
}
