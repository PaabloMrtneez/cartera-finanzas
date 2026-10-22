"use client";

import { useState } from "react";
import { Segmented } from "@/components/ui/segmented";

type Vista = "importe" | "tasa";

/**
 * Lo que sumas cada mes, en euros o en TASA DE AHORRO (lo sumado entre lo que
 * entró). Son la misma pregunta vista de dos formas —cuánto y qué parte—, así
 * que van en la misma tarjeta con un conmutador, no en dos tarjetas que
 * repetirían los mismos meses.
 *
 * Las dos vistas llegan del servidor como HIJOS marcados con `data-panel`, y
 * aquí solo se decide cuál se ve, con CSS. No se pasan como props ni se eligen
 * con un condicional: un elemento que cruza la frontera como prop puede llegar
 * «perezoso» y React avisa de claves que no faltan.
 */
export function AhorroConmutable({ children }: { children: React.ReactNode }) {
  const [vista, setVista] = useState<Vista>("importe");
  return (
    <div
      data-vista={vista}
      className="flex flex-col gap-4 [&[data-vista=importe]_[data-panel=tasa]]:hidden [&[data-vista=tasa]_[data-panel=importe]]:hidden"
    >
      <div className="flex px-4 lg:px-5">
        <Segmented
          label="Ver lo sumado en"
          value={vista}
          onChange={setVista}
          options={[
            { value: "importe", label: "Euros" },
            { value: "tasa", label: "Tasa" },
          ]}
        />
      </div>
      {children}
    </div>
  );
}
