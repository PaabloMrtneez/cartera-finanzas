"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { CabeceraLectura, TONO_CLASE } from "@/components/ui/lectura";
import { cn } from "@/lib/cn";
import type { LecturaPunto, TamanoLectura, Tono } from "@/lib/graficos";

export type FilaRanking = {
  id: string;
  nombre: string;
  /** Segunda línea bajo el nombre: el tipo de cuenta, «archivada»… */
  subtitulo?: string;
  /** Icono del medallón. Sin él, un punto del color de la fila. */
  icono?: string;
  /** El color que identifica la fila: medallón y relleno de la barra. */
  color: string;
  /** El número, para la geometría (largo ∝ valor). Un valor ≤ 0 no dibuja barra. */
  valor: number;
  /** El importe ya formateado (los strings cruzan la frontera; las funciones no). */
  texto: string;
  /** La proporción ya formateada, «31 %». */
  share?: string;
  /** El importe sale en rojo: una cuenta en descubierto, una deuda. */
  negativo?: boolean;
  /**
   * El valor del periodo anterior, en la misma unidad que `valor`: se dibuja
   * como una MARCA FANTASMA sobre el carril, para ver de un vistazo si esta
   * fila ha crecido o encogido.
   */
  previo?: number | null;
  /** La variación ya escrita, «+12 % vs agosto», con su tono. */
  variacion?: { texto: string; tono: Tono };
  /** La fila lleva a algún sitio: los movimientos de esa cuenta y mes. */
  href?: string;
  /** Lo que lee la cabecera al pasar por la fila (si el ranking tiene cabecera). */
  lectura?: LecturaPunto;
  /**
   * Filas anidadas: una cuenta y sus tarjetas. Se pintan debajo, sangradas y
   * con un carril más fino. Su proporción es sobre el MISMO total.
   */
  hijos?: FilaRanking[];
};

/**
 * RANKING EN BARRAS HORIZONTALES: el patrón de «Dónde está».
 *
 * Una lista de filas —medallón, nombre, importe— con su peso dibujado en una
 * barra GRANDE debajo. «31 %» hay que leerlo y compararlo a mano; una barra se
 * compara de un vistazo, que es justo la pregunta de una lista así (¿qué pesa
 * más?). La cifra exacta se queda al lado para quien la quiera.
 *
 * La barra es una CÁPSULA de 10 px sobre su carril, con el color de la fila y
 * el barniz de la banda Aurora, y crece por `scale` desde la izquierda,
 * escalonada. Con `previo`, una muesca fantasma marca dónde estaba antes.
 *
 * El largo es la fracción del TOTAL de las filas (`escala="total"`) o del
 * mayor (`escala="maximo"`, para que la primera llene el carril cuando lo que
 * importa es el orden y no el reparto).
 *
 * LECTURA. Si lleva cabecera (`children`), al pasar el ratón o el foco por una
 * fila la cabecera la lee, como en la curva. Con el dedo, una fila con `href`
 * va directamente —en una lista, tocar una fila es abrirla—; una sin `href` se
 * selecciona y se lee. El índice activo puede venir de fuera (`activo` y
 * `alCambiar`) para casar la lista con otro gráfico: el donut la usa de
 * leyenda.
 */
export function BarrasRanking({
  filas,
  escala = "total",
  activo: activoExterno,
  alCambiar,
  tamano = "compacto",
  etiquetaAccesible,
  className,
  children,
}: {
  filas: FilaRanking[];
  escala?: "total" | "maximo";
  activo?: number | null;
  alCambiar?: (i: number | null) => void;
  tamano?: TamanoLectura;
  etiquetaAccesible: string;
  className?: string;
  /** La cabecera en reposo. Sin ella, el ranking no tiene cabecera de lectura. */
  children?: React.ReactNode;
}) {
  const [activoPropio, setActivoPropio] = useState<number | null>(null);
  const controlado = activoExterno !== undefined;
  const activo = controlado ? activoExterno : activoPropio;
  const fijar = (i: number | null) => {
    if (!controlado) setActivoPropio(i);
    alCambiar?.(i);
  };

  const positivos = (lista: FilaRanking[]) => lista.map((f) => Math.max(f.valor, 0));
  const base =
    escala === "maximo"
      ? Math.max(...positivos(filas), 1)
      : Math.max(positivos(filas).reduce((s, v) => s + v, 0), 1);
  const fraccion = (v: number) => Math.min(Math.max(v, 0) / base, 1) * 100;

  const leida = activo !== null ? filas[activo] : null;
  const conCabecera = children !== undefined;
  const hayLectura = conCabecera || controlado;

  return (
    <div className={cn("flex flex-col", className)}>
      {conCabecera ? (
        <div className="px-[18px] pb-3 lg:px-5">
          <CabeceraLectura lectura={leida?.lectura ?? null} tamano={tamano}>
            {children}
          </CabeceraLectura>
        </div>
      ) : null}

      <ul aria-label={etiquetaAccesible}>
        {filas.map((f, i) => (
          <li key={f.id} className="hair-t border-separator">
            <Fila
              fila={f}
              ancho={fraccion(f.valor)}
              previo={f.previo !== undefined && f.previo !== null ? fraccion(f.previo) : null}
              retardo={i * 45}
              activa={activo === i}
              atenuada={activo !== null && activo !== i}
              lectora={hayLectura}
              alEntrar={() => fijar(i)}
              alSalir={() => fijar(null)}
              alPulsar={() => fijar(i)}
            />
            {f.hijos && f.hijos.length > 0 ? (
              <ul className="pb-2">
                {f.hijos.map((h, k) => (
                  <li key={h.id}>
                    <Fila
                      fila={h}
                      ancho={fraccion(h.valor)}
                      previo={h.previo !== undefined && h.previo !== null ? fraccion(h.previo) : null}
                      retardo={i * 45 + (k + 1) * 30}
                      anidada
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Fila({
  fila: f,
  ancho,
  previo,
  retardo,
  activa = false,
  atenuada = false,
  lectora = false,
  anidada = false,
  alEntrar,
  alSalir,
  alPulsar,
}: {
  fila: FilaRanking;
  ancho: number;
  previo: number | null;
  retardo: number;
  activa?: boolean;
  atenuada?: boolean;
  lectora?: boolean;
  anidada?: boolean;
  alEntrar?: () => void;
  alSalir?: () => void;
  alPulsar?: () => void;
}) {
  const contenido = (
    <>
      <span className="flex items-center gap-3">
        {anidada ? (
          <span className="flex size-[30px] shrink-0 items-center justify-center" aria-hidden>
            <span className="size-[7px] rounded-full" style={{ background: f.color }} />
          </span>
        ) : f.icono ? (
          // El tinte del medallón es una capa del color a 16 % de opacidad, no un
          // `color-mix()` en línea: con un color `var(--aurora-n)` el navegador
          // tira la declaración entera y el medallón se queda sin fondo.
          <span
            className="relative flex size-[30px] shrink-0 items-center justify-center rounded-full"
            style={{ color: f.color }}
            aria-hidden
          >
            <span
              className="absolute inset-0 rounded-full opacity-16"
              style={{ background: f.color }}
            />
            <Icon name={f.icono} size={16} className="relative" />
          </span>
        ) : (
          <span className="flex size-[30px] shrink-0 items-center justify-center" aria-hidden>
            <span className="size-[10px] rounded-full" style={{ background: f.color }} />
          </span>
        )}

        <span className="flex min-w-0 flex-1 flex-col">
          {/* Un nombre largo («Fidelity MSCI World Index EUR P Acc») se corta
              con puntos suspensivos por el ancho real que deja el importe; el
              texto entero sigue ahí para el lector de pantalla y en el `title`. */}
          <span
            className={cn("truncate font-semibold", anidada ? "text-[14px]" : "text-[15px]")}
            title={f.nombre}
          >
            {f.nombre}
          </span>
          {f.subtitulo ? (
            <span className="truncate text-[13px] leading-[18px] text-muted">{f.subtitulo}</span>
          ) : null}
        </span>

        <span className="flex shrink-0 flex-col items-end">
          <span
            className={cn(
              "font-semibold tabular-nums",
              anidada ? "text-[14px]" : "text-[15px]",
              f.negativo && "text-expense",
            )}
          >
            {f.texto}
          </span>
          {f.variacion ? (
            <span className={cn("text-[13px] leading-[18px] tabular-nums", TONO_CLASE[f.variacion.tono])}>
              {f.variacion.texto}
            </span>
          ) : null}
        </span>
        {f.href ? (
          <span className="-mr-1 shrink-0 text-muted" aria-hidden>
            <Icon name="chevron-right" size={16} />
          </span>
        ) : null}
      </span>

      {ancho > 0 || previo !== null ? (
        <span className="flex items-center gap-2 pl-[42px]">
          <span className="relative flex-1">
            <span
              className={cn(
                "relative block overflow-hidden rounded-full bg-surface-2",
                anidada ? "h-[6px]" : "h-[10px]",
              )}
            >
              <span
                className="absolute inset-y-0 left-0 origin-left animate-bar-fill rounded-full"
                style={{
                  width: `${ancho}%`,
                  background: f.color,
                  animationDelay: `${retardo}ms`,
                }}
              >
                {/* El barniz de la banda Aurora: brillo arriba, volumen. */}
                <span
                  className="pointer-events-none absolute inset-0 rounded-full [background:linear-gradient(180deg,rgba(255,255,255,0.32),transparent_60%)] [mix-blend-mode:screen]"
                  aria-hidden
                />
              </span>
            </span>
            {/* La marca fantasma del periodo anterior: sobresale del carril,
                como una muesca, para no confundirse con el relleno. */}
            {previo !== null ? (
              <span
                className="absolute -top-[3px] -bottom-[3px] w-[2px] -translate-x-1/2 rounded-full bg-fg opacity-45"
                style={{ left: `${previo}%` }}
                aria-hidden
              />
            ) : null}
          </span>
          {f.share ? (
            <span className="w-11 text-right text-[13px] text-muted tabular-nums">{f.share}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );

  const clase = cn(
    "flex w-full flex-col gap-2 px-[18px] text-left text-fg lg:px-5",
    anidada ? "py-2" : "py-3",
    "transition-opacity duration-150 ease-out",
    atenuada && "opacity-55",
    activa && "bg-surface-2",
  );

  const lectura = lectora
    ? {
        onPointerEnter: (e: React.PointerEvent) => {
          if (e.pointerType === "mouse") alEntrar?.();
        },
        onPointerLeave: (e: React.PointerEvent) => {
          if (e.pointerType === "mouse") alSalir?.();
        },
        onFocus: alEntrar,
        onBlur: alSalir,
      }
    : {};

  if (f.href) {
    return (
      <Link href={f.href} className={cn("fila-pulsable", clase)} {...lectura}>
        {contenido}
      </Link>
    );
  }
  if (lectora) {
    return (
      <button
        type="button"
        className={cn("fila-pulsable", clase)}
        aria-pressed={activa}
        onClick={alPulsar}
        {...lectura}
      >
        {contenido}
      </button>
    );
  }
  return <div className={clase}>{contenido}</div>;
}
