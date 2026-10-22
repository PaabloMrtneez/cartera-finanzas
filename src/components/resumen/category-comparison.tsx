"use client";

import { useState } from "react";
import { BarrasRanking, type FilaRanking } from "@/components/ui/barras-ranking";
import { Segmented } from "@/components/ui/segmented";
import { COLOR_OTROS, ESPECTRO_AURORA } from "@/lib/aurora";
import { formatCents, formatSignedDelta } from "@/lib/money";

export type Comparada = {
  category_id: string | null;
  name: string;
  color: string;
  icon: string;
  actual_cents: number;
  previo_cents: number;
  delta_cents: number;
};

type Orden = "gasto" | "cambio";

/** Cuántas filas se ven antes de «Ver todas»: lo que cabe en una pantalla. */
const VISIBLES = 6;

/**
 * Las categorías del mes, contra el anterior, en el RANKING de barras de
 * «Dónde está».
 *
 * Antes eran barras divergentes del cambio; ahora cada categoría es su gasto
 * del mes en una barra grande, con una MUESCA donde se quedó el mes anterior:
 * si la barra rebasa la muesca, gastas más que entonces. Así se leen a la vez
 * las dos preguntas —en qué gastas y qué se ha movido— sin una tarjeta para
 * cada una. La cifra del cambio sigue al lado, con su tono: en gasto, subir es
 * lo malo.
 *
 * Convive con la banda de arriba, que es la FIRMA del reparto y no compara.
 * Para que las dos hablen el mismo idioma, cada categoría lleva el color de su
 * puesto en el espectro, como en la banda: la tercera que más gasta es del
 * mismo tono en las dos.
 *
 * SE ORDENA por gasto o por cuánto se mueve, y cada fila lleva a los
 * movimientos de esa categoría en el mes. Con muchas categorías se ven las
 * primeras y un botón despliega el resto.
 */
export function CategoryComparison({
  filas,
  mes,
  mesPrevio,
  mesIso,
}: {
  filas: Comparada[];
  mes: string;
  mesPrevio: string;
  /** «2026-09-01», para el enlace de cada fila. */
  mesIso: string;
}) {
  const [orden, setOrden] = useState<Orden>("gasto");
  const [todas, setTodas] = useState(false);
  const conAlgo = filas.filter((f) => f.actual_cents !== 0 || f.previo_cents !== 0);
  if (conAlgo.length === 0) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        Ni en {mes} ni en {mesPrevio} hay gasto con categoría que comparar.
      </p>
    );
  }

  // El color de la banda: por puesto de gasto del mes, no por el orden elegido.
  const porGasto = [...conAlgo].sort((a, b) => b.actual_cents - a.actual_cents);
  const colorDe = new Map(
    porGasto.map((f, i) => [f.category_id ?? "sin", i < 6 ? ESPECTRO_AURORA[i] : COLOR_OTROS]),
  );

  const ordenadas =
    orden === "gasto"
      ? porGasto
      : [...conAlgo].sort((a, b) => Math.abs(b.delta_cents) - Math.abs(a.delta_cents));
  const vistas = todas ? ordenadas : ordenadas.slice(0, VISIBLES);

  const ranking: FilaRanking[] = vistas.map((f) => ({
    id: f.category_id ?? "sin",
    nombre: f.name,
    icono: f.icon,
    color: colorDe.get(f.category_id ?? "sin") ?? COLOR_OTROS,
    valor: f.actual_cents,
    texto: formatCents(f.actual_cents),
    negativo: f.actual_cents < 0,
    previo: f.previo_cents > 0 ? f.previo_cents : null,
    // Solo el cambio, corto: el mes con el que se compara ya lo dicen el
    // título y el pie, y un texto largo aquí trunca el nombre de la categoría.
    variacion:
      f.delta_cents === 0
        ? { texto: "Sin cambio", tono: "neutro" }
        : {
            texto: formatSignedDelta(f.delta_cents),
            tono: f.delta_cents > 0 ? "mal" : "bien",
          },
    href: `/movimientos?mes=${mesIso}&categoria=${f.category_id ?? "sin"}`,
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="px-4 pb-1 lg:max-w-[320px] lg:px-5">
        <Segmented
          label="Ordenar por"
          value={orden}
          onChange={setOrden}
          options={[
            { value: "gasto", label: "Más gasto" },
            { value: "cambio", label: "Más cambio" },
          ]}
        />
      </div>

      <BarrasRanking
        filas={ranking}
        escala="maximo"
        etiquetaAccesible={`Categorías de ${mes}, con la muesca de ${mesPrevio}`}
      />

      <div className="flex items-center justify-between gap-3 hair-t border-separator px-4 py-3 lg:px-5">
        <p className="text-[13px] leading-[18px] text-muted">
          El cambio y la muesca, frente a {mesPrevio}.
        </p>
        {ordenadas.length > VISIBLES ? (
          <button
            type="button"
            onClick={() => setTodas((t) => !t)}
            className="pulsable shrink-0 text-[13px] leading-[18px] font-semibold text-accent-text"
            aria-expanded={todas}
          >
            {todas ? "Ver menos" : `Ver las ${ordenadas.length}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
