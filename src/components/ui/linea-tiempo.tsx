"use client";

import { CabeceraLectura } from "@/components/ui/lectura";
import { useLectura } from "@/components/ui/use-lectura";
import { cn } from "@/lib/cn";
import type { LecturaPunto, TamanoLectura } from "@/lib/graficos";

export type MarcaTiempo = {
  clave: string;
  /** Días desde el arranque de la línea (0 = hoy). */
  dia: number;
  /** Céntimos: la altura de la marca, proporcional. */
  valor: number;
  lectura: LecturaPunto;
};

/** Un rótulo del eje: el comienzo de cada mes, por ejemplo. */
export type HitoTiempo = { dia: number; texto: string };

const MX = 8;
const MT = 8;
const MB = 4;
const ORO = "var(--aurora-5)";

/**
 * LÍNEA DE TIEMPO: lo que viene, en su sitio en el calendario.
 *
 * Un eje de N días desde hoy y, encima, una MARCA por día con cargos: un
 * palito cuya altura es el importe, rematado por un punto. Se ve de un vistazo
 * cuándo se amontonan los cargos y cuál pesa, que es justo lo que una lista no
 * enseña. Los comienzos de mes, con una guía fina y su nombre.
 *
 * LA CABECERA ES LA LECTURA: al recorrerla —dedo, ratón o flechas— lee la
 * marca más cercana, de una en una; los días vacíos no se leen.
 */
export function LineaTiempo({
  dias,
  marcas,
  hitos = [],
  altoBase,
  claseAlto,
  tamano = "compacto",
  etiquetaAccesible,
  className,
  children,
}: {
  dias: number;
  marcas: MarcaTiempo[];
  hitos?: HitoTiempo[];
  altoBase: number;
  claseAlto: string;
  tamano?: TamanoLectura;
  etiquetaAccesible: string;
  className?: string;
  children: React.ReactNode;
}) {
  const xRel = (dia: number, w: number) => MX + (dia / Math.max(dias, 1)) * (w - 2 * MX);
  const { caja, ancho, alto, activo, manejadores } = useLectura({
    total: marcas.length,
    altoBase,
    inicio: 0,
    indice: (x, w) => {
      let mejor = 0;
      marcas.forEach((m, i) => {
        if (Math.abs(xRel(m.dia, w) - x) < Math.abs(xRel(marcas[mejor].dia, w) - x)) mejor = i;
      });
      return mejor;
    },
  });
  const maximo = Math.max(1, ...marcas.map((m) => m.valor));
  const suelo = alto - MB;
  const altura = (v: number) => Math.max(((suelo - MT - 6) * v) / maximo, 6);
  const leida = activo !== null ? (marcas[activo] ?? null) : null;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <CabeceraLectura lectura={leida?.lectura ?? null} tamano={tamano}>
        {children}
      </CabeceraLectura>

      <div className="flex flex-col gap-[6px]">
        <div
          ref={caja}
          role="group"
          aria-label={`${etiquetaAccesible} Recórrela con las flechas.`}
          tabIndex={0}
          className={cn(
            "relative w-full cursor-crosshair touch-pan-y outline-none",
            "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
            "focus-visible:ring-offset-surface",
            claseAlto,
          )}
          {...manejadores}
        >
          <svg
            viewBox={`0 0 ${ancho} ${alto}`}
            width={ancho}
            height={alto}
            className="block overflow-visible"
            aria-hidden
          >
            {/* El suelo y las guías de mes. */}
            <line x1={0} x2={ancho} y1={suelo + 0.5} y2={suelo + 0.5} stroke="var(--hairline)" />
            {hitos.map((h) => (
              <line
                key={h.dia}
                x1={xRel(h.dia, ancho)}
                x2={xRel(h.dia, ancho)}
                y1={MT}
                y2={suelo}
                stroke="var(--separator)"
              />
            ))}
            {/* Hoy: el arranque, en oro. */}
            <circle
              cx={xRel(0, ancho)}
              cy={suelo}
              r={3.5}
              fill={ORO}
              stroke="var(--surface)"
              strokeWidth={1.5}
            />

            {marcas.map((m, i) => {
              const cx = xRel(m.dia, ancho);
              const h = altura(m.valor);
              const opacidad = activo === null || activo === i ? 1 : 0.3;
              return (
                <g
                  key={m.clave}
                  className="transition-opacity duration-150 ease-out"
                  style={{ opacity: opacidad }}
                >
                  <g
                    className="animate-bar-grow"
                    style={{
                      transformOrigin: `${cx}px ${suelo}px`,
                      transformBox: "view-box",
                      animationDelay: `${i * 35}ms`,
                    }}
                  >
                    <line
                      x1={cx}
                      x2={cx}
                      y1={suelo}
                      y2={suelo - h}
                      stroke="var(--accent)"
                      strokeWidth={2}
                      strokeLinecap="round"
                    />
                    <circle
                      cx={cx}
                      cy={suelo - h}
                      r={activo === i ? 5 : 4}
                      fill={activo === i ? "var(--fg)" : "var(--accent)"}
                      stroke="var(--surface)"
                      strokeWidth={2}
                    />
                  </g>
                </g>
              );
            })}
          </svg>
        </div>

        <div
          className="relative h-[14px] text-[11px] leading-[14px] text-muted tabular-nums"
          aria-hidden
        >
          <span className="absolute top-0 left-0 font-semibold tracking-[0.04em] text-warning uppercase">
            Hoy
          </span>
          {hitos.map((h) => (
            <span
              key={h.dia}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap first-letter:uppercase"
              style={{ left: xRel(h.dia, ancho) }}
            >
              {h.texto}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
