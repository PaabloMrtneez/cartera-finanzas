"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { RANGOS_INVERSION, type ClaveRango } from "@/lib/rangos-inversion";

/**
 * «1 M / 3 M / 6 M / Año / Todo» sobre las curvas de inversión.
 *
 * El rango vive en la dirección, como el mes en las demás pantallas, así que se
 * puede compartir un enlace a un periodo y el botón de atrás vuelve al anterior.
 *
 * Manda sobre TODA la pantalla, no solo sobre una gráfica: las curvas, los
 * porcentajes de cada activo y el combinado miran el mismo periodo. Que un
 * porcentaje sea del año y la curva de tres meses sería una trampa.
 */
export function RangoInversion({ rango }: { rango: ClaveRango }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function ir(siguiente: ClaveRango) {
    const query = new URLSearchParams(params.toString());
    query.set("rango", siguiente);
    router.push(`${pathname}?${query}`, { scroll: false });
  }

  return (
    <div role="group" aria-label="Periodo" className="flex gap-1 rounded-sm bg-surface-2 p-[2px]">
      {RANGOS_INVERSION.map((r) => (
        <button
          key={r.clave}
          type="button"
          onClick={() => ir(r.clave)}
          aria-pressed={rango === r.clave}
          className={cn(
            "pulsable toque relative h-7 rounded-xs px-[10px] text-[13px] font-semibold whitespace-nowrap",
            "transition-[opacity,color,background-color] duration-150 ease-ui",
            rango === r.clave ? "bg-surface text-fg shadow-card" : "text-muted",
          )}
        >
          {r.etiqueta}
        </button>
      ))}
    </div>
  );
}
