"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { startTransition, useOptimistic } from "react";
import { Segmented } from "@/components/ui/segmented";
import { RANGOS, type ClaveRangoPatrimonio } from "@/lib/rangos";

/**
 * El rango de la curva del patrimonio: 6M · 1A · Todo, con el segmentado de la
 * app, debajo de la curva como en Bolsa.
 *
 * El rango vive en la dirección, como el mes en las demás pantallas: se puede
 * compartir un enlace a «Todo» y el botón de atrás vuelve. La pastilla se
 * desliza al momento, aunque los datos nuevos tarden lo que tarde el servidor.
 */
export function RangeToggle({ rango }: { rango: ClaveRangoPatrimonio }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // El valor optimista: la pastilla va adonde la mandas sin esperar a la
  // respuesta del servidor, y vuelve sola si la navegación no llega.
  const [visible, setVisible] = useOptimistic(rango);

  return (
    <Segmented
      label="Rango de la evolución"
      value={visible}
      onChange={(siguiente) => {
        const query = new URLSearchParams(params.toString());
        query.set("rango", siguiente);
        startTransition(() => {
          setVisible(siguiente);
          router.push(`${pathname}?${query}`, { scroll: false });
        });
      }}
      options={RANGOS.map((r) => ({ value: r.clave, label: r.etiqueta }))}
    />
  );
}
