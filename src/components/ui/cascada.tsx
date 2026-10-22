"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { CabeceraLectura } from "@/components/ui/lectura";
import { cn } from "@/lib/cn";
import type { LecturaPunto, TamanoLectura } from "@/lib/graficos";

export type PasoVisible = {
  id: string;
  nombre: string;
  /** De dónde a dónde va la barra, en céntimos (de `cascada`). */
  desde: number;
  hasta: number;
  /** El importe del paso ya escrito: «2.500,00 €», «−320,40 €». */
  texto: string;
  /** El color de la barra: el ingreso en verde, las categorías del espectro. */
  color: string;
  /** El paso de partida y el de llegada se escriben más fuertes. */
  extremo?: boolean;
  lectura: LecturaPunto;
  href?: string;
};

/**
 * CASCADA: del ingreso del mes a lo que queda, paso a paso.
 *
 * En horizontal y por filas —como el ranking de «Dónde está»—, porque en un
 * móvil una cascada vertical de nueve columnas son nueve palillos sin nombre.
 * Cada fila es un paso: su nombre y su importe arriba, y debajo una barra que
 * FLOTA entre lo que quedaba antes y lo que queda después. Leídas de arriba
 * abajo, las barras bajan en escalera hasta la última, que es lo ahorrado (o
 * lo que falta, si cruza el cero: la línea del cero se marca).
 *
 * LA CABECERA ES LA LECTURA: al pasar por una fila (ratón, foco o toque) la
 * cabecera la lee; si la fila lleva adónde ir, tocarla abre sus movimientos.
 */
export function Cascada({
  pasos,
  min,
  max,
  tamano = "compacto",
  etiquetaAccesible,
  className,
  children,
}: {
  pasos: PasoVisible[];
  min: number;
  max: number;
  tamano?: TamanoLectura;
  etiquetaAccesible: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [activo, setActivo] = useState<number | null>(null);
  const rango = Math.max(max - min, 1);
  const pct = (v: number) => ((v - min) / rango) * 100;
  const cero = min < 0 ? pct(0) : null;
  const leido = activo !== null ? pasos[activo] : null;

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="px-[18px] pb-3 lg:px-5">
        <CabeceraLectura lectura={leido?.lectura ?? null} tamano={tamano}>
          {children}
        </CabeceraLectura>
      </div>

      <ul aria-label={etiquetaAccesible}>
        {pasos.map((p, i) => {
          const izq = pct(Math.min(p.desde, p.hasta));
          const ancho = Math.max(Math.abs(pct(p.hasta) - pct(p.desde)), 0.6);
          const baja = p.hasta < p.desde;
          const contenido = (
            <>
              <span className="flex items-baseline gap-3">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    p.extremo ? "text-[15px] font-semibold" : "text-[14px] text-fg",
                  )}
                >
                  {p.nombre}
                </span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    p.extremo ? "text-[15px] font-semibold" : "text-[14px]",
                  )}
                >
                  {p.texto}
                </span>
                {p.href ? (
                  <span className="-mr-1 shrink-0 self-center text-muted" aria-hidden>
                    <Icon name="chevron-right" size={16} />
                  </span>
                ) : null}
              </span>
              <span className="relative block h-[10px]" aria-hidden>
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-separator" />
                {cero !== null ? (
                  <span
                    className="absolute -top-[3px] -bottom-[3px] w-px bg-hairline"
                    style={{ left: `${cero}%` }}
                  />
                ) : null}
                <span
                  className={cn(
                    "absolute inset-y-0 animate-bar-fill overflow-hidden rounded-full",
                    baja ? "origin-right" : "origin-left",
                  )}
                  style={{
                    left: `${izq}%`,
                    width: `${ancho}%`,
                    background: p.color,
                    animationDelay: `${i * 45}ms`,
                  }}
                >
                  <span className="absolute inset-0 [background:linear-gradient(180deg,rgba(255,255,255,0.32),transparent_60%)] [mix-blend-mode:screen]" />
                </span>
              </span>
            </>
          );
          const clase = cn(
            "flex w-full flex-col gap-2 px-[18px] py-[10px] text-left text-fg lg:px-5",
            "transition-opacity duration-150 ease-out",
            activo !== null && activo !== i && "opacity-55",
            activo === i && "bg-surface-2",
          );
          const lectura = {
            onPointerEnter: (e: React.PointerEvent) => {
              if (e.pointerType === "mouse") setActivo(i);
            },
            onPointerLeave: (e: React.PointerEvent) => {
              if (e.pointerType === "mouse") setActivo(null);
            },
            onFocus: () => setActivo(i),
            onBlur: () => setActivo(null),
          };
          return (
            <li key={p.id} className="hair-t border-separator">
              {p.href ? (
                <Link href={p.href} className={cn("fila-pulsable", clase)} {...lectura}>
                  {contenido}
                </Link>
              ) : (
                <button
                  type="button"
                  className={cn("fila-pulsable", clase)}
                  aria-pressed={activo === i}
                  onClick={() => setActivo(i)}
                  {...lectura}
                >
                  {contenido}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
