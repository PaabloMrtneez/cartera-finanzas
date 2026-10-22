"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ArcoAnillo } from "@/components/ui/donut-aurora";
import { Icon } from "@/components/ui/icon";
import { CabeceraLectura } from "@/components/ui/lectura";
import { cn } from "@/lib/cn";
import type { LecturaPunto, TamanoLectura } from "@/lib/graficos";

export type AnilloProgreso = {
  id: string;
  nombre: string;
  /** Un peldaño del espectro, asignado por posición. */
  color: string;
  /**
   * Lo consumido entre el tope, para la GEOMETRÍA (1 = el anillo cerrado; 1,3
   * = una vuelta y un 30 % más). Viene de dos enteros en céntimos; aquí solo
   * dibuja.
   */
  fraccion: number;
  lectura: LecturaPunto;
  href?: string;
};

/** Una fila de la lista de debajo: todos los límites, estén o no en anillo. */
export type FilaProgreso = {
  id: string;
  nombre: string;
  /** Bajo el nombre: «45,20 € de 100,00 €». */
  detalle: string;
  /** A la derecha, la cifra: «45 %». */
  cifra: string;
  /** Bajo la cifra: «quedan 54,80 €», o «23,00 € de más» si se pasó. */
  estado: string;
  excedido: boolean;
  fraccion: number;
  /** El color de su anillo, si lo tiene; sin anillo, una barra fina. */
  color?: string;
  /** Su índice en los anillos, para casar la lista con el dibujo. */
  anillo?: number;
  href?: string;
};

const LADO = 200;
const C = LADO / 2;

/**
 * ANILLOS DE PROGRESO, como los de Actividad del Apple Watch: uno por límite,
 * concéntricos, que se CIERRAN según gastas. Si te pasas, el anillo sigue
 * dando la vuelta por encima de sí mismo y su extremo se marca con un filete
 * del color de la superficie, para que se vea dónde acaba la segunda vuelta.
 *
 * El centro de cuatro anillos es demasiado pequeño para leer nada, así que la
 * lectura va en la CABECERA, como en el resto de gráficos: en reposo, el
 * conjunto; al tocar un anillo (o su fila), ese límite. Los nombres, en la
 * lista de debajo —nunca rótulos alrededor, que se cortan—. Caben cuatro
 * anillos; el resto de límites va solo en la lista, con una barra fina.
 *
 * Al entrar, cada anillo se barre desde las doce, escalonado; con movimiento
 * reducido, un fundido. Se toca por la distancia al centro; con el teclado,
 * las flechas recorren los anillos e Intro abre los movimientos del límite.
 */
export function AnillosProgreso({
  anillos,
  filas,
  tamano = "compacto",
  etiquetaAccesible,
  className,
  children,
}: {
  anillos: AnilloProgreso[];
  filas: FilaProgreso[];
  tamano?: TamanoLectura;
  etiquetaAccesible: string;
  className?: string;
  /** La cabecera en reposo. */
  children: React.ReactNode;
}) {
  const router = useRouter();
  const id = useId();
  const caja = useRef<HTMLDivElement>(null);
  const pulsando = useRef(false);
  const [activo, setActivo] = useState<number | null>(null);
  // El barrido de entrada es una máscara por anillo. Al acabar se QUITA: una
  // máscara de trazo deja una costura de un píxel a las doce, y en un anillo
  // que da la vuelta entera se ve. Con un reloj de respaldo por si el
  // navegador no avisa del final de la animación.
  const [barriendo, setBarriendo] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setBarriendo(false), 1400);
    return () => window.clearTimeout(t);
  }, []);

  const n = Math.min(anillos.length, 4);
  const grosor = n <= 2 ? 18 : n === 3 ? 16 : 14;
  const hueco = 4;
  const radio = (k: number) => C - 2 - grosor / 2 - k * (grosor + hueco);
  const interior = radio(n - 1) - grosor / 2;

  const desde = (clientX: number, clientY: number): number | null | "fuera" => {
    const r = caja.current?.getBoundingClientRect();
    if (!r || r.width === 0) return "fuera";
    const escala = r.width / LADO;
    const dist =
      Math.hypot(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2)) / escala;
    if (dist < interior - 2) return null;
    if (dist > C + 2) return "fuera";
    // El anillo cuyo radio cae más cerca del dedo.
    let mejor = 0;
    for (let k = 1; k < n; k++) {
      if (Math.abs(radio(k) - dist) < Math.abs(radio(mejor) - dist)) mejor = k;
    }
    return mejor;
  };

  const leer = (e: React.PointerEvent) => {
    const i = desde(e.clientX, e.clientY);
    if (i === "fuera") {
      if (e.pointerType === "mouse") setActivo(null);
      return;
    }
    setActivo(i);
  };

  const leido = activo !== null ? anillos[activo] : null;

  return (
    <div
      className={cn(
        "flex flex-col gap-4 lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:items-center lg:gap-x-8 lg:px-5 lg:pb-2",
        className,
      )}
    >
      <CabeceraLectura
        lectura={leido?.lectura ?? null}
        tamano={tamano}
        href={leido?.href}
        className="px-[18px] lg:col-start-2 lg:row-start-1 lg:self-end lg:px-0"
      >
        {children}
      </CabeceraLectura>

      <div
        ref={caja}
        role="group"
        aria-label={`${etiquetaAccesible} Recórrelos con las flechas.`}
        tabIndex={0}
        className={cn(
          "relative mx-auto aspect-square w-[208px] cursor-pointer touch-pan-y rounded-full outline-none",
          "lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:w-[240px]",
          "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
          "focus-visible:ring-offset-surface",
        )}
        onPointerDown={(e) => {
          pulsando.current = true;
          leer(e);
        }}
        onPointerMove={(e) => {
          if (pulsando.current || e.pointerType === "mouse") leer(e);
        }}
        onPointerUp={() => {
          pulsando.current = false;
        }}
        onPointerCancel={() => {
          pulsando.current = false;
        }}
        onPointerLeave={(e) => {
          pulsando.current = false;
          if (e.pointerType === "mouse") setActivo(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") return setActivo(null);
          if (e.key === "Enter" && leido?.href) {
            e.preventDefault();
            return router.push(leido.href);
          }
          const salto =
            e.key === "ArrowRight" || e.key === "ArrowDown"
              ? 1
              : e.key === "ArrowLeft" || e.key === "ArrowUp"
                ? -1
                : 0;
          if (salto === 0) return;
          e.preventDefault();
          setActivo((i) => (i === null ? (salto > 0 ? 0 : n - 1) : (i + salto + n) % n));
        }}
      >
        <svg
          viewBox={`0 0 ${LADO} ${LADO}`}
          className="block size-full overflow-visible"
          aria-hidden
        >
          <defs>
            {anillos.slice(0, n).map((a, k) => (
              <mask
                key={a.id}
                id={`${id}-barrido-${k}`}
                maskUnits="userSpaceOnUse"
                x={0}
                y={0}
                width={LADO}
                height={LADO}
              >
                <circle
                  cx={C}
                  cy={C}
                  r={radio(k)}
                  fill="none"
                  stroke="#fff"
                  strokeWidth={grosor + 6}
                  pathLength={1}
                  strokeDasharray={1}
                  transform={`rotate(-90 ${C} ${C})`}
                  className="animate-trazo"
                  style={{ animationDelay: `${k * 70}ms` }}
                  onAnimationEnd={k === n - 1 ? () => setBarriendo(false) : undefined}
                />
              </mask>
            ))}
          </defs>
          {anillos.slice(0, n).map((a, k) => {
            const r = radio(k);
            const f = Math.max(a.fraccion, 0);
            const vueltas = Math.floor(f);
            const resto = (f - vueltas) * 100;
            const opacidad = activo === null || activo === k ? 1 : 0.3;
            // El extremo: dónde acaba lo gastado, en el sentido del reloj.
            const angulo = ((f % 1) * 360 - 90) * (Math.PI / 180);
            const excedido = f > 1;
            return (
              <g key={a.id}>
                {/* El carril: el mismo color, muy apagado, como en Actividad. */}
                <circle
                  cx={C}
                  cy={C}
                  r={r}
                  fill="none"
                  stroke={a.color}
                  strokeOpacity={0.16}
                  strokeWidth={grosor}
                />
                <g mask={barriendo ? `url(#${id}-barrido-${k})` : undefined}>
                  {f > 0 ? (
                    <ArcoAnillo
                      radio={r}
                      grosor={grosor}
                      desde={0}
                      largo={excedido ? 100 : Math.max(f * 100, 0.01)}
                      color={a.color}
                      opacidad={opacidad}
                    />
                  ) : null}
                  {excedido && resto > 0 ? (
                    <>
                      <ArcoAnillo
                        radio={r}
                        grosor={grosor}
                        desde={0}
                        largo={resto}
                        color={a.color}
                        opacidad={opacidad}
                      />
                      {/* El extremo marcado: un remate con filete del color de
                          la superficie, que lo despega de la vuelta de debajo. */}
                      <circle
                        cx={C + r * Math.cos(angulo)}
                        cy={C + r * Math.sin(angulo)}
                        r={grosor / 2}
                        fill={a.color}
                        stroke="var(--surface)"
                        strokeWidth={2}
                        className="transition-opacity duration-150 ease-out"
                        style={{ opacity: opacidad }}
                      />
                    </>
                  ) : null}
                </g>
              </g>
            );
          })}
        </svg>
      </div>

      <ul aria-label={etiquetaAccesible} className="lg:col-start-2 lg:row-start-2">
        {filas.map((f) => {
          const resaltada = activo !== null && f.anillo === activo;
          const atenuada = activo !== null && f.anillo !== activo;
          const contenido = (
            <>
              <span className="flex items-center gap-3">
                <span className="flex size-[22px] shrink-0 items-center justify-center" aria-hidden>
                  <span
                    className={cn("rounded-full", f.color ? "size-[10px]" : "size-[7px] bg-muted")}
                    style={f.color ? { background: f.color } : undefined}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px] font-semibold">{f.nombre}</span>
                  <span className="truncate text-[13px] leading-[18px] text-muted tabular-nums">
                    {f.detalle}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span
                    className={cn(
                      "text-[15px] font-semibold tabular-nums",
                      f.excedido && "text-expense",
                    )}
                  >
                    {f.cifra}
                  </span>
                  <span
                    className={cn(
                      "text-[13px] leading-[18px] tabular-nums",
                      f.excedido ? "text-expense" : "text-muted",
                    )}
                  >
                    {f.estado}
                  </span>
                </span>
                {f.href ? (
                  <span className="-mr-1 shrink-0 text-muted" aria-hidden>
                    <Icon name="chevron-right" size={16} />
                  </span>
                ) : null}
              </span>
              {f.anillo === undefined ? (
                <span className="block pl-[34px]" aria-hidden>
                  <span className="relative block h-[6px] overflow-hidden rounded-full bg-surface-2">
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 origin-left animate-bar-fill rounded-full",
                        f.excedido ? "bg-expense" : "bg-muted",
                      )}
                      style={{
                        width: `${Math.min(Math.max(f.fraccion, 0), 1) * 100}%`,
                      }}
                    />
                  </span>
                </span>
              ) : null}
            </>
          );
          const clase = cn(
            "fila-pulsable flex w-full flex-col gap-2 px-[18px] py-3 text-left text-fg lg:px-0",
            "transition-opacity duration-150 ease-out",
            atenuada && "opacity-55",
            resaltada && "bg-surface-2",
          );
          const lectura =
            f.anillo !== undefined
              ? {
                  onPointerEnter: (e: React.PointerEvent) => {
                    if (e.pointerType === "mouse") setActivo(f.anillo ?? null);
                  },
                  onPointerLeave: (e: React.PointerEvent) => {
                    if (e.pointerType === "mouse") setActivo(null);
                  },
                  onFocus: () => setActivo(f.anillo ?? null),
                  onBlur: () => setActivo(null),
                }
              : {};
          return (
            <li key={f.id} className="hair-t border-separator">
              {f.href ? (
                <Link href={f.href} className={clase} {...lectura}>
                  {contenido}
                </Link>
              ) : (
                <div className={clase}>{contenido}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
