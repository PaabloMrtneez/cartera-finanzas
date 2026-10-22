"use client";

import { useId } from "react";
import { CabeceraLectura } from "@/components/ui/lectura";
import { useLectura } from "@/components/ui/use-lectura";
import { cn } from "@/lib/cn";
import {
  apilar,
  escalaBonita,
  indiceLinea,
  rotuloEje,
  rutaRecta,
  type LecturaPunto,
  type Pt,
  type TamanoLectura,
} from "@/lib/graficos";

export type CapaArea = {
  id: string;
  nombre: string;
  /** Un token del espectro (`var(--aurora-3)`…). Sólido: nada de color-mix con var(). */
  color: string;
  /** Céntimos por índice. Pueden ser negativos (una tarjeta en descubierto). */
  valores: number[];
  /** Los mismos valores ya formateados, para la leyenda al leer. */
  textos: string[];
  /** Lo que dice su leyenda en reposo: «58 %». */
  reposo?: string;
};

/** Aire a la izquierda; el canal de la escala va a la derecha, como en la curva. */
const MX = 6;
const CANAL_ESCALA = 46;
const MT = 10;
const MB = 8;
const CIFRA_SVG = {
  fontFamily: "var(--font-cifra)",
  fontVariantNumeric: "tabular-nums",
} as const;

/**
 * ÁREA APILADA: de qué está hecho un total a lo largo del tiempo (caja,
 * invertido, sin desplegar), con la gramática de Bolsa y Salud.
 *
 *  · Las capas se apilan desde el cero, lo positivo hacia arriba y lo negativo
 *    hacia abajo (`apilar`): una tarjeta en rojo no se come lo invertido. El
 *    borde de arriba de cada capa es un trazo fino de su color; el relleno, el
 *    mismo color muy apagado, para que se lean las fronteras y no un bloque.
 *  · LA CABECERA ES LA LECTURA: al recorrerla, la cifra de arriba pasa a ser la
 *    del punto y la leyenda de debajo da cada capa en ese punto. En reposo, la
 *    leyenda da lo que cada capa quiere decir (su peso de hoy).
 *  · El tramo tras el dedo se apaga, como en la curva: «hasta aquí».
 *  · Escala a la derecha, en su canal. El cero, marcado si hay negativos.
 *
 * El alto va en clases (`claseAlto`); `altoBase` es el de móvil para el primer
 * fotograma.
 */
export function AreaApilada({
  capas,
  lecturas,
  ejeX,
  marcasX,
  altoBase,
  claseAlto,
  tamano = "compacto",
  presente,
  etiquetaAccesible,
  className,
  children,
}: {
  capas: CapaArea[];
  lecturas: LecturaPunto[];
  ejeX: string[];
  marcasX?: number[];
  altoBase: number;
  claseAlto: string;
  tamano?: TamanoLectura;
  /**
   * El índice del presente, cuando la serie sigue más allá de hoy (el cuadro
   * de un préstamo). En reposo, lo que viene detrás se apaga como el tramo
   * tras el dedo: se lee «hasta aquí ha pasado».
   */
  presente?: number;
  etiquetaAccesible: string;
  className?: string;
  /** La cabecera en reposo, con las medidas de `CIFRA_LECTURA[tamano]`. */
  children: React.ReactNode;
}) {
  const total = ejeX.length;
  const MR = CANAL_ESCALA;
  const { caja, ancho, alto, activo, manejadores } = useLectura({
    total,
    altoBase,
    indice: (x, w) => indiceLinea(x, w, total, MX, MR),
  });
  const id = useId();
  const act = activo === null ? null : Math.min(activo, total - 1);

  const pilas = apilar(capas.map((c) => c.valores));
  const extremosTodos = [0, ...pilas.flat().flatMap((p) => [p.base, p.techo])];
  const e = escalaBonita(
    Math.min(...extremosTodos),
    Math.max(...extremosTodos),
    alto < 140 ? 2 : 4,
    100,
  );
  const derecha = ancho - MR;
  const x = (i: number) => MX + (i * (derecha - MX)) / Math.max(total - 1, 1);
  const y = (v: number) =>
    MT + (1 - (v - e.desde) / Math.max(e.hasta - e.desde, 1)) * (alto - MT - MB);

  const corte =
    act !== null ? x(act) : presente !== undefined && presente < total - 1 ? x(presente) : ancho + 20;
  const firma = `${total}-${ejeX[0]}-${ejeX[total - 1]}`;
  const marcas = marcasX ?? [0, Math.floor((total - 1) / 2), total - 1];
  const hayNegativos = Math.min(...extremosTodos) < 0;

  const area = (k: number) => {
    const arriba: Pt[] = pilas[k].map((p, i) => ({ x: x(i), y: y(p.techo) }));
    const abajo: Pt[] = pilas[k].map((p, i) => ({ x: x(i), y: y(p.base) })).reverse();
    return {
      d: `${rutaRecta(arriba)}${rutaRecta(abajo).replace(/^M/, "L")}Z`,
      borde: rutaRecta(arriba),
    };
  };

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <CabeceraLectura lectura={act === null ? null : (lecturas[act] ?? null)} tamano={tamano}>
        {children}
      </CabeceraLectura>

      <div className="flex flex-col gap-[6px]">
        <div
          ref={caja}
          className={cn(
            "relative w-full cursor-crosshair touch-pan-y outline-none",
            "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
            "focus-visible:ring-offset-surface",
            claseAlto,
          )}
          role="group"
          aria-label={`${etiquetaAccesible} Recórrelo con las flechas.`}
          tabIndex={0}
          {...manejadores}
        >
          <svg
            viewBox={`0 0 ${ancho} ${alto}`}
            width={ancho}
            height={alto}
            className="block animate-chart-in overflow-visible"
            aria-hidden
          >
            <defs>
              <clipPath id={`${id}-izq`}>
                <rect x={-10} y={-30} width={Math.max(corte + 10, 0)} height={alto + 60} />
              </clipPath>
              <clipPath id={`${id}-der`}>
                <rect
                  x={corte}
                  y={-30}
                  width={Math.max(ancho - corte + 10, 0)}
                  height={alto + 60}
                />
              </clipPath>
            </defs>

            {e.ticks.map((t, k) => (
              <g key={t}>
                <line
                  x1={0}
                  x2={derecha}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={
                    k === 0 || (hayNegativos && t === 0) ? "var(--hairline)" : "var(--separator)"
                  }
                />
                <text
                  x={ancho}
                  y={y(t)}
                  dominantBaseline="middle"
                  textAnchor="end"
                  fontSize={11}
                  fill="var(--muted)"
                  style={CIFRA_SVG}
                >
                  {rotuloEje(t)}
                </text>
              </g>
            ))}

            <g key={firma}>
              {(["izq", "der"] as const).map((lado) => (
                <g key={lado} clipPath={`url(#${id}-${lado})`} opacity={lado === "izq" ? 1 : 0.35}>
                  {capas.map((c, k) => {
                    const { d, borde } = area(k);
                    return (
                      <g key={c.id}>
                        <path d={d} fill={c.color} fillOpacity={0.22} />
                        <path
                          d={borde}
                          fill="none"
                          stroke={c.color}
                          strokeWidth={1.75}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      </g>
                    );
                  })}
                </g>
              ))}
            </g>

            {act !== null ? (
              <g>
                <line
                  x1={x(act)}
                  x2={x(act)}
                  y1={0}
                  y2={alto}
                  stroke="var(--fg)"
                  strokeOpacity={0.32}
                  strokeWidth={1}
                />
                {capas.map((c, k) => (
                  <circle
                    key={c.id}
                    cx={x(act)}
                    cy={y(pilas[k][act].techo)}
                    r={4}
                    fill={c.color}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                ))}
              </g>
            ) : null}
          </svg>
        </div>

        <div
          className="relative h-[14px] text-[11px] leading-[14px] text-muted tabular-nums"
          aria-hidden
        >
          {marcas
            .filter((i, k, a) => i >= 0 && i < total && a.indexOf(i) === k)
            .map((i) => (
              <span
                key={i}
                className="absolute top-0 whitespace-nowrap first-letter:uppercase"
                style={{
                  left: x(i),
                  transform:
                    i === 0
                      ? `translateX(-${MX}px)`
                      : i === total - 1
                        ? "translateX(-100%)"
                        : "translateX(-50%)",
                }}
              >
                {ejeX[i]}
              </span>
            ))}
        </div>
      </div>

      {/* La leyenda: cada capa con su valor en el punto leído; en reposo, lo
          que la capa pesa hoy. */}
      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        {capas.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-2 text-[13px] leading-[18px] tabular-nums"
          >
            <span
              className="h-[4px] w-[18px] shrink-0 rounded-full"
              style={{ background: c.color }}
              aria-hidden
            />
            <span className="text-muted">{c.nombre}</span>
            <span className="font-semibold text-fg">{act === null ? c.reposo : c.textos[act]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
