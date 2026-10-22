"use client";

import { useTheme } from "@/components/use-theme";
import { Grupo } from "@/components/ui/card";
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
    <Grupo titulo="Apariencia" claseTarjeta="flex flex-col gap-2 p-4 lg:p-5">
      <Segmented
        label="Tema"
        value={theme}
        onChange={setTheme}
        options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
      />
      <p className="text-[13px] leading-[18px] text-muted">
        En automático sigue al sistema, y cambia solo al anochecer.
      </p>
    </Grupo>
  );
}
