"use client";

import { useMemo, useState, useTransition } from "react";
import { cargarMasMovimientos } from "@/app/(app)/movimientos/cargar-mas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { conCatalogo, PASO, type Catalogo, type FilaLigera } from "@/lib/consulta-movimientos";
import {
  agruparPorDia,
  ANCHO_IMPORTE,
  CabeceraDia,
  FilaMovimiento,
  LI_FILA_TABLA,
} from "./fila-movimiento";

/**
 * La lista de Movimientos: agrupada por día en móvil y tabla de cinco columnas
 * en escritorio, con UN SOLO marcado (la fila se abre en columnas con `lg:`).
 *
 * Es de cliente porque crece: «Cargar más» pide a `cargarMasMovimientos` solo
 * las filas que faltan y las añade aquí, sin volver a pintar ni a mandar las
 * que ya había. La primera tanda llega del servidor como datos ligeros (ver
 * `FilaLigera`) y se pinta ya en el HTML, así que no hay que esperar a
 * JavaScript para verla.
 *
 * La página la monta con `key` = la dirección completa (filtros, mes y nº de
 * filas): si el servidor vuelve a pintar —otro filtro, un refresco tras
 * guardar—, la lista empieza de nuevo desde lo que él manda en lugar de mezclar
 * su tanda con la que se había añadido aquí.
 */
export function ListaMovimientos({
  inicial,
  catalogo,
  hoy,
  total,
  consulta,
}: {
  inicial: FilaLigera[];
  catalogo: Catalogo;
  /** La fecha de hoy según el servidor, para que «Hoy» y «Ayer» no cambien al hidratar. */
  hoy: string;
  /** Cuántos movimientos casan con la consulta, cargados o no. */
  total: number;
  /** La consulta de la dirección (`mes=…&q=…`), tal cual la leyó la página. */
  consulta: string;
}) {
  const [extra, setExtra] = useState<FilaLigera[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, startTransition] = useTransition();

  const filas = useMemo(() => {
    if (extra.length === 0) return inicial;
    // Si entre tanda y tanda ha entrado un movimiento nuevo, la consulta se
    // corre una fila y la última de antes vuelve a venir: fuera duplicados.
    const vistos = new Set(inicial.map((tx) => tx.id));
    return [...inicial, ...extra.filter((tx) => !vistos.has(tx.id))];
  }, [inicial, extra]);

  const dias = useMemo(
    () => agruparPorDia(filas.map((tx) => conCatalogo(tx, catalogo))),
    [filas, catalogo],
  );

  const quedan = Math.max(total - filas.length, 0);

  function cargarMas() {
    setError(null);
    startTransition(async () => {
      try {
        // Lo que hace falta para no repetir ni saltarse nada (ver la acción):
        // el último día cargado y qué movimientos de ese día ya están.
        const ultimoDia = filas[filas.length - 1].occurred_on;
        const idsUltimoDia = filas.filter((tx) => tx.occurred_on === ultimoDia).map((tx) => tx.id);
        const r = await cargarMasMovimientos(consulta, filas.length, ultimoDia, idsUltimoDia);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        const yaCargadas = new Set(filas.map((tx) => tx.id));
        const nuevas = r.filas.filter((tx) => !yaCargadas.has(tx.id));
        setExtra((previas) => [...previas, ...nuevas]);
        // El número de filas sigue viviendo en la dirección: recargar o volver
        // a esta pantalla enseña lo mismo que había. Se REEMPLAZA la entrada
        // del historial (no se apila otra), y Next la sincroniza sin pedir nada
        // al servidor.
        const query = new URLSearchParams(window.location.search);
        query.set("filas", String(filas.length + nuevas.length));
        window.history.replaceState(window.history.state, "", `?${query}`);
      } catch {
        // Sin conexión (o la respuesta se perdió): lo cargado sigue ahí.
        setError("Sin conexión: no se han podido cargar más. Vuelve a intentarlo.");
      }
    });
  }

  return (
    <>
      <Card>
        {/* La cabecera de la tabla, solo en escritorio. */}
        <div className="hidden h-8 items-center gap-3 px-[18px] text-[13px] font-semibold tracking-[0.03em] text-muted uppercase lg:flex">
          <span className="flex-1">Descripción</span>
          <span className="w-40">Categoría</span>
          <span className="w-36">Cuenta</span>
          <span className="w-24">Fecha</span>
          <span className={`text-right ${ANCHO_IMPORTE}`}>Importe</span>
        </div>

        {dias.map(([dia, items]) => (
          <section
            key={dia}
            className="max-lg:hair-t max-lg:border-hairline max-lg:first-of-type:border-t-0"
            style={{
              // Lo que no está en pantalla no se maqueta ni se pinta hasta que
              // se acerca; el alto estimado (cabecera + filas de móvil) evita
              // que la barra de desplazamiento salte, y `auto` recuerda el real.
              contentVisibility: "auto",
              containIntrinsicBlockSize: `auto ${32 + items.length * 60}px`,
            }}
          >
            {/* En escritorio la fecha va en su columna: la cabecera de día sobra. */}
            <CabeceraDia dia={dia} items={items} hoy={hoy} className="lg:hidden" />
            <ul>
              {items.map((tx) => (
                <li key={tx.id} className={LI_FILA_TABLA}>
                  <FilaMovimiento tx={tx} hoy={hoy} columnas />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Card>

      {/*
        «Cargar más», con la cuenta de lo que queda: «cargar más» a secas no
        responde a la única pregunta que importa, si merece la pena seguir
        pulsando o conviene filtrar.
      */}
      {quedan > 0 || error ? (
        <div className="flex flex-col items-center gap-2 py-2">
          {quedan > 0 ? (
            <Button variant="secondary" onClick={cargarMas} disabled={pendiente}>
              {pendiente ? "Cargando…" : `Cargar ${Math.min(PASO, quedan)} más`}
            </Button>
          ) : null}
          <p role="status" className="text-[13px] leading-[18px] text-muted tabular-nums">
            {error ??
              (quedan === 1 ? "Queda 1 movimiento" : `Quedan ${quedan} movimientos`)}
          </p>
        </div>
      ) : null}
    </>
  );
}
