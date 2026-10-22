"use client";

import { useEffect, useState } from "react";
import { CabeceraLectura } from "@/components/ui/lectura";
import { useLectura } from "@/components/ui/use-lectura";
import { cn } from "@/lib/cn";
import {
  CIFRA_LECTURA,
  OPACIDAD_CALOR,
  agruparFranjas,
  nivelCalor,
  type Casilla,
  type CeldaCalor,
  type LecturaPunto,
} from "@/lib/graficos";
import { formatCents, formatShare } from "@/lib/money";

const DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const DIAS_CORTOS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const INICIALES = ["L", "M", "X", "J", "V", "S", "D"];
const HUECO = 3;

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const cargos = (n: number) => `${n} ${n === 1 ? "cargo" : "cargos"}`;

/** «de 18 a 21 h», «a las 18 h», «sin hora». */
function franjaTexto(col: number, horas: number, franjas: number): string {
  if (col === franjas) return "sin hora";
  if (horas === 1) return `a las ${col} h`;
  return `de ${col * horas} a ${(col + 1) * horas} h`;
}

function lecturaDe(
  c: Casilla,
  dia: number,
  col: number,
  horas: number,
  franjas: number,
  total: number,
): LecturaPunto {
  return {
    rotulo: `${capital(DIAS[dia])}, ${franjaTexto(col, horas, franjas)}`,
    cifra: formatCents(c.net_cents),
    detalle:
      c.cargos === 0 && c.net_cents === 0
        ? "Nada en este periodo"
        : `${cargos(c.cargos)}${total > 0 && c.net_cents > 0 ? ` · ${formatShare((c.net_cents / total) * 100)} del gasto` : ""}`,
    tono: "neutro",
  };
}

/**
 * MAPA DE CALOR: cuándo gastas, por día de la semana y hora.
 *
 * Dos formas, porque la estructura cambia de verdad con la anchura:
 *
 *  · En escritorio, la rejilla entera: los siete días en filas y las 24 horas
 *    en columnas, más una columna aparte «sin hora».
 *  · En un móvil, 24 columnas serían casillas de 9 px. Ahí los días van en
 *    COLUMNAS (como un calendario) y las horas se juntan en ocho franjas de
 *    tres, más la fila «sin hora»: casillas grandes y ejes que se leen.
 *
 * Las dos salen de las mismas 175 celdas (`agruparFranjas`) y comparten UNA
 * cabecera: la cifra no se escribe dos veces. En reposo da tu franja más cara
 * (de tres horas, en las dos anchuras, para que diga lo mismo); al tocar una
 * casilla, la suya. «Sin hora» son los apuntes a mano y las suscripciones, que
 * no traen hora: no son un pico de medianoche.
 */
export function MapaCalor({ celdas, periodo }: { celdas: CeldaCalor[]; periodo: string }) {
  const [lectura, setLectura] = useState<LecturaPunto | null>(null);
  const porFranjas = agruparFranjas(celdas, 3);
  const porHoras = agruparFranjas(celdas, 1);
  const total = celdas.reduce((s, c) => s + Math.max(c.net_cents, 0), 0);

  if (total <= 0) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        En {periodo} no hay gasto que repartir por horas.
      </p>
    );
  }

  // La franja más cara, sin contar «sin hora» (no es un momento del día).
  let mejor = { dia: 0, col: 0, net: -1 };
  porFranjas.forEach((fila, dia) =>
    fila.slice(0, 8).forEach((c, col) => {
      if (c.net_cents > mejor.net) mejor = { dia, col, net: c.net_cents };
    }),
  );
  const casillaMejor = porFranjas[mejor.dia][mejor.col];

  return (
    <div className="flex flex-col gap-4 px-4 pb-4 lg:px-5">
      <CabeceraLectura lectura={lectura} tamano="compacto">
        <div className="flex flex-col gap-1">
          {/* Sin nada con hora, la franja más cara sería «0,00 €»: se dice lo
              que hay, todo sin hora. */}
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            {mejor.net > 0 ? "Tu franja más cara" : "Todo, sin hora"}
          </span>
          <span className={CIFRA_LECTURA.compacto}>
            {formatCents(mejor.net > 0 ? mejor.net : total)}
          </span>
          <span className="text-[14px] leading-5 text-muted tabular-nums">
            {mejor.net > 0
              ? `${capital(DIAS[mejor.dia])}, ${franjaTexto(mejor.col, 3, 8)} · ${cargos(casillaMejor.cargos)}`
              : "Ningún gasto de este periodo trae hora."}
          </span>
        </div>
      </CabeceraLectura>

      {/* Móvil: días en columnas, ocho franjas de tres horas y «sin hora». */}
      <div className="lg:hidden">
        <Rejilla
          filas={9}
          columnas={7}
          altoFila={30}
          rotulosColumnas={INICIALES}
          rotulosFilas={["0–3", "3–6", "6–9", "9–12", "12–15", "15–18", "18–21", "21–24", "Sin h."]}
          anchoRotulo={46}
          casilla={(f, c) => porFranjas[c][f]}
          lectura={(f, c) => lecturaDe(porFranjas[c][f], c, f, 3, 8, total)}
          separarUltima="fila"
          onLeer={setLectura}
          etiquetaAccesible={`Gasto por día de la semana y franja horaria, ${periodo}.`}
        />
      </div>

      {/* Escritorio: días en filas y las 24 horas en columnas, más «sin hora». */}
      <div className="hidden lg:block">
        <Rejilla
          filas={7}
          columnas={25}
          altoFila={28}
          rotulosColumnas={Array.from({ length: 25 }, (_, h) =>
            h === 24 ? "s/h" : h % 3 === 0 ? String(h) : "",
          )}
          rotulosFilas={DIAS_CORTOS}
          anchoRotulo={44}
          casilla={(f, c) => porHoras[f][c]}
          lectura={(f, c) => lecturaDe(porHoras[f][c], f, c, 1, 24, total)}
          separarUltima="columna"
          onLeer={setLectura}
          etiquetaAccesible={`Gasto por día de la semana y hora, ${periodo}.`}
        />
      </div>

      <div className="flex flex-col gap-2 text-[13px] leading-[18px] text-muted">
        <div className="flex items-center gap-2" aria-hidden>
          <span>Menos</span>
          {OPACIDAD_CALOR.map((o, n) => (
            <span
              key={n}
              className="relative size-[14px] overflow-hidden rounded-xs bg-surface-2"
            >
              {n > 0 ? (
                <span className="absolute inset-0 bg-accent" style={{ opacity: o }} />
              ) : null}
            </span>
          ))}
          <span>Más</span>
        </div>
        <p>«Sin hora» son los apuntes a mano y los gastos fijos, que no traen hora.</p>
      </div>
    </div>
  );
}

function Rejilla({
  filas,
  columnas,
  altoFila,
  rotulosColumnas,
  rotulosFilas,
  anchoRotulo,
  casilla,
  lectura,
  separarUltima,
  onLeer,
  etiquetaAccesible,
}: {
  filas: number;
  columnas: number;
  altoFila: number;
  rotulosColumnas: string[];
  rotulosFilas: string[];
  anchoRotulo: number;
  casilla: (fila: number, col: number) => Casilla;
  lectura: (fila: number, col: number) => LecturaPunto;
  /** «Sin hora» va un poco aparte: no es la hora siguiente. */
  separarUltima: "fila" | "columna";
  onLeer: (l: LecturaPunto | null) => void;
  etiquetaAccesible: string;
}) {
  const extra = 6;
  const altoTotal = filas * altoFila + (filas - 1) * HUECO + (separarUltima === "fila" ? extra : 0);
  const { caja, ancho, activo, manejadores } = useLectura({
    total: filas * columnas,
    altoBase: altoTotal,
    pasoVertical: columnas,
    inicio: 0,
    indice: (x, w, y) => {
      const anchoUtil = w - (separarUltima === "columna" ? extra : 0);
      const ladoX = (anchoUtil - HUECO * (columnas - 1)) / columnas;
      let col = Math.floor(x / (ladoX + HUECO));
      if (separarUltima === "columna" && x > (ladoX + HUECO) * (columnas - 1)) col = columnas - 1;
      let fila = Math.floor(y / (altoFila + HUECO));
      if (separarUltima === "fila" && y > (altoFila + HUECO) * (filas - 1)) fila = filas - 1;
      return (
        Math.min(Math.max(fila, 0), filas - 1) * columnas + Math.min(Math.max(col, 0), columnas - 1)
      );
    },
  });

  const anchoUtil = ancho - (separarUltima === "columna" ? extra : 0);
  const lado = Math.max((anchoUtil - HUECO * (columnas - 1)) / columnas, 0);
  const xDe = (c: number) =>
    c * (lado + HUECO) + (separarUltima === "columna" && c === columnas - 1 ? extra : 0);
  const yDe = (f: number) =>
    f * (altoFila + HUECO) + (separarUltima === "fila" && f === filas - 1 ? extra : 0);

  let maximo = 0;
  for (let f = 0; f < filas; f++)
    for (let c = 0; c < columnas; c++) maximo = Math.max(maximo, casilla(f, c).net_cents);

  const fila = activo === null ? null : Math.floor(activo / columnas);
  const col = activo === null ? null : activo % columnas;

  useEffect(() => {
    onLeer(fila === null || col === null ? null : lectura(fila, col));
    // `lectura` y `onLeer` cambian en cada render; lo que importa es la casilla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fila, col]);

  return (
    <div className="flex gap-2">
      <div className="flex shrink-0 flex-col" style={{ width: anchoRotulo }} aria-hidden>
        <span className="h-[18px]" />
        <span className="relative" style={{ height: altoTotal }}>
          {rotulosFilas.map((r, f) => (
            <span
              key={r}
              className="absolute right-0 left-0 flex items-center text-[11px] leading-[14px] text-muted tabular-nums"
              style={{ top: yDe(f), height: altoFila }}
            >
              {r}
            </span>
          ))}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative h-[18px]" aria-hidden>
          {rotulosColumnas.map((r, c) =>
            r ? (
              <span
                key={c}
                className={cn(
                  "absolute top-0 -translate-x-1/2 whitespace-nowrap text-muted tabular-nums",
                  rotulosColumnas.length > 7
                    ? "text-[11px] leading-[14px]"
                    : "text-[13px] leading-[18px]",
                )}
                style={{ left: xDe(c) + lado / 2 }}
              >
                {r}
              </span>
            ) : null,
          )}
        </div>
        <div
          ref={caja}
          role="group"
          aria-label={`${etiquetaAccesible} Recórrelo con las flechas.`}
          tabIndex={0}
          className={cn(
            "relative w-full cursor-pointer touch-pan-y rounded-sm outline-none",
            "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
            "focus-visible:ring-offset-surface",
          )}
          style={{ height: altoTotal }}
          {...manejadores}
        >
          <svg
            viewBox={`0 0 ${ancho} ${altoTotal}`}
            width={ancho}
            height={altoTotal}
            className="block animate-fade-in"
            aria-hidden
          >
            {Array.from({ length: filas }, (_, f) =>
              Array.from({ length: columnas }, (_, c) => {
                const v = casilla(f, c);
                const nivel = nivelCalor(v.net_cents, maximo);
                const activa = fila === f && col === c;
                return (
                  <g key={`${f}-${c}`}>
                    <rect
                      x={xDe(c)}
                      y={yDe(f)}
                      width={lado}
                      height={altoFila}
                      rx={6}
                      fill="var(--surface-2)"
                    />
                    {nivel > 0 ? (
                      <rect
                        x={xDe(c)}
                        y={yDe(f)}
                        width={lado}
                        height={altoFila}
                        rx={6}
                        fill="var(--accent)"
                        fillOpacity={OPACIDAD_CALOR[nivel]}
                      />
                    ) : null}
                    {activa ? (
                      <rect
                        x={xDe(c) + 1}
                        y={yDe(f) + 1}
                        width={Math.max(lado - 2, 0)}
                        height={altoFila - 2}
                        rx={5}
                        fill="none"
                        stroke="var(--fg)"
                        strokeWidth={2}
                      />
                    ) : null}
                  </g>
                );
              }),
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}
