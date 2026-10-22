"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { startTransition, useOptimistic } from "react";
import { Segmented } from "@/components/ui/segmented";
import { VISTAS_FIJOS, type VistaFijos } from "@/lib/fijos";

/**
 * «Gastos fijos / Ingresos fijos»: qué grupo de Fijos se ve.
 *
 * Un segmentado y no las dos secciones seguidas porque en un móvil, una debajo
 * de otra, eran dos pantallas enteras (lista, gráfico, próximos y pausados de
 * cada una) y el segundo grupo quedaba a varios pulgares de distancia, sin que
 * nada dijera que estaba ahí. Los dos totales siguen arriba, a la vista, en la
 * tira de la cabecera: lo que se elige aquí es solo el detalle.
 *
 * El grupo vive en la dirección (`?ver=`), como el rango de Patrimonio: un
 * enlace o un marcador abren el grupo que toca y el botón de atrás vuelve al
 * anterior. La pastilla se desliza al momento aunque el servidor tarde.
 */
export function VistaFijosToggle({ vista }: { vista: VistaFijos }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [visible, setVisible] = useOptimistic(vista);

  return (
    <Segmented
      label="Grupo de fijos"
      value={visible}
      className="lg:max-w-[360px]"
      onChange={(siguiente) => {
        if (siguiente === visible) return;
        const query = new URLSearchParams(params.toString());
        query.set("ver", siguiente);
        startTransition(() => {
          setVisible(siguiente);
          router.push(`${pathname}?${query}`, { scroll: false });
        });
      }}
      options={VISTAS_FIJOS}
    />
  );
}
