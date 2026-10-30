"use client";

import { useTheme } from "@/components/use-theme";
import { SeccionAjustes } from "@/components/ajustes/seccion";
import { Segmented } from "@/components/ui/segmented";
import { THEMES, THEME_LABELS } from "@/lib/theme";

/**
 * Solo el tema. El selector de acento se quitó con el rediseño editorial:
 * seis acentos conmutables diluyen la identidad, porque la app no tiene un
 * color, tiene seis a medias.
 */
export function ThemeSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <SeccionAjustes
      titulo="Apariencia"
      descripcion="En automático sigue al sistema, y cambia solo al anochecer."
      claseTarjeta="flex flex-col gap-2 p-4 lg:flex-row lg:items-center lg:justify-between lg:px-[18px] lg:py-3"
    >
      <span className="hidden text-[15px] font-semibold lg:block">Tema</span>
      <Segmented
        label="Tema"
        value={theme}
        onChange={setTheme}
        options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
        className="lg:w-[320px]"
      />
    </SeccionAjustes>
  );
}
