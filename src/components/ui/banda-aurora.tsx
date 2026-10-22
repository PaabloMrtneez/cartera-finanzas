"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { useLectura } from "@/components/ui/use-lectura";
import { cn } from "@/lib/cn";

export type SegmentoBanda = {
  id: string;
  /** Nombre de la categoría, para la leyenda y la lectura. */
  nombre: string;
  /** Color CSS del segmento: un peldaño de `ESPECTRO_AURORA` (`@/lib/aurora`),
   *  asignado por posición en el envoltorio de dominio. */
  color: string;
  /** El número, para la geometría (ancho ∝ valor). Siempre positivo. */
  valor: number;
  /** El importe ya formateado (`formatCents` se hace fuera: strings cruzan la
   *  frontera servidor→cliente, las funciones no). */
  texto: string;
  /** La proporción ya formateada, «33 %». */
  share: string;
  /** Adónde lleva: los movimientos de esa categoría en ese mes. */
  href?: string;
};

/**
 * La BANDA AURORA: el espectro de categorías. Es la FIRMA de la identidad y
 * sustituye al donut como visualización del reparto.
 *
 * Un espectro horizontal segmentado por categoría —el ancho de cada segmento es
 * su proporción del gasto—, dentro de un carril de cristal con brillo y una
 * sombra que lo hace flotar. Debajo, la leyenda con nombre, importe y peso.
 *
 * SE TOCA, con la misma mecánica que la curva y las barras (`useLectura`):
 * tocar un segmento —con el dedo, el ratón o las flechas— lo resalta y la
 * cabecera deja de dar el total para dar el detalle de esa categoría; si el
 * segmento lleva `href`, el rótulo de la cabecera pasa a ser el enlace a sus
 * movimientos, y tocarlo otra vez (o Intro) va. La leyenda es además una fila
 * de botones, con una diana más grande para el dedo que un segmento estrecho.
 *
 * Reutilizable a propósito: no sabe nada de «gasto» ni de «categorías», solo
 * recibe segmentos con su valor, color y textos. Se usará en otras pantallas.
 */
export function BandaAurora({
  segmentos,
  etiquetaAccesible,
  titulo = "Por categoría",
  resumen,
  nota,
  enlace = "Ver movimientos",
  className,
}: {
  segmentos: SegmentoBanda[];
  etiquetaAccesible: string;
  /** El rótulo en mayúsculas a la izquierda de la cabecera. */
  titulo?: string;
  /** Lo que se lee a la derecha de la cabecera cuando no hay nada tocado. */
  resumen?: React.ReactNode;
  /** Pie opcional (p. ej. el aviso de categorías en negativo). */
  nota?: React.ReactNode;
  /** El texto del enlace de un segmento con `href`. */
  enlace?: string;
  className?: string;
}) {
  const router = useRouter();
  const total = segmentos.reduce((suma, s) => suma + s.valor, 0) || 1;

  // Los cortes acumulados en fracción [0,1]: sirven para el ancho (flex-grow) y
  // para saber qué segmento cae bajo el dedo a partir de su posición en x.
  const cortes = segmentos.map((s, i) => {
    const anteriores = segmentos.slice(0, i).reduce((suma, p) => suma + p.valor, 0);
    return { desde: anteriores / total, hasta: (anteriores + s.valor) / total };
  });

  // La misma mecánica de lectura que la curva y las barras: dedo, ratón y
  // flechas; y, si el segmento lleva adónde ir, tocar otra vez es ir.
  const conEnlaces = segmentos.some((s) => s.href);
  const { caja, activo, setActivo, manejadores } = useLectura({
    total: segmentos.length,
    altoBase: 58,
    // El espectro se lee de izquierda a derecha: la primera flecha, al primero.
    inicio: 0,
    indice: (x, ancho) => {
      const frac = x / ancho;
      const i = cortes.findIndex((c) => frac >= c.desde && frac < c.hasta);
      return i === -1 ? (frac < 0 ? 0 : segmentos.length - 1) : i;
    },
    alConfirmar: conEnlaces
      ? (i) => {
          const href = segmentos[i]?.href;
          if (href) router.push(href);
        }
      : undefined,
  });

  const elegido = activo !== null ? segmentos[activo] : null;

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Cabecera: rótulo a la izquierda; a la derecha, el resumen o —al tocar—
          el detalle del segmento elegido. Los dos estados comparten línea, así
          que el alto no salta. */}
      <div className="mb-3 flex items-baseline justify-between gap-3">
        {/* El rótulo cede su sitio al enlace del segmento leído, si lo tiene:
            leyendo, ya se sabe de qué es la banda; lo útil es poder ir. */}
        {elegido?.href ? (
          <Link
            href={elegido.href}
            className="pulsable toque relative inline-flex shrink-0 items-center gap-[2px] text-[13px] leading-[18px] font-semibold text-accent-text"
          >
            {enlace}
            <Icon name="chevron-right" size={14} />
          </Link>
        ) : (
          <span className="text-[13px] leading-[18px] font-semibold tracking-[0.03em] text-muted uppercase">
            {titulo}
          </span>
        )}
        <span className="min-w-0 truncate text-right text-[13px] leading-[18px]" aria-live="polite">
          {elegido ? (
            <>
              <span className="font-semibold text-fg">{elegido.nombre}</span>{" "}
              <span className="cifra text-fg tabular-nums">{elegido.texto}</span>{" "}
              <span className="text-muted tabular-nums">· {elegido.share}</span>
            </>
          ) : (
            <span className="text-muted tabular-nums">{resumen}</span>
          )}
        </span>
      </div>

      {/* El carril de cristal con los segmentos. Es una role=group recorrible por
          teclado; el brillo interior y la sombra de abajo lo hacen flotar. */}
      <div
        ref={caja}
        role="group"
        aria-label={conEnlaces ? `${etiquetaAccesible} Intro abre sus movimientos.` : etiquetaAccesible}
        tabIndex={0}
        {...manejadores}
        className={cn(
          "flex h-[58px] w-full touch-pan-y gap-[3px] rounded-lg p-[3px] outline-none",
          "cursor-pointer bg-white/[0.04]",
          "shadow-[0_14px_46px_-16px_color-mix(in_srgb,var(--accent)_45%,transparent),inset_0_1px_0_rgba(255,255,255,0.12)]",
          "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
          "focus-visible:ring-offset-surface",
        )}
      >
        {segmentos.map((s, i) => (
          <div
            key={s.id}
            className={cn(
              "relative h-full overflow-hidden rounded-[calc(var(--r-lg)-3px)]",
              // El filete del segmento leído en el color del texto: en oscuro es
              // casi blanco, como antes; en claro, blanco sobre el oro no se veía.
              activo === i && "outline outline-[1.5px] -outline-offset-1 outline-fg/55",
            )}
            style={{ flexGrow: s.valor, flexBasis: 0 }}
          >
            {/* El relleno crece de izquierda a derecha, escalonado 45 ms. El color
                va SÓLIDO (un peldaño del espectro); el barniz blanco de arriba le
                da el volumen. Nada de `color-mix(var(), …)`: el navegador tira la
                declaración entera cuando el argumento de color-mix es un `var()`,
                y el segmento se quedaba sin fondo. */}
            <span
              className="absolute inset-0 origin-left animate-bar-fill"
              style={{ background: s.color, animationDelay: `${i * 45}ms` }}
              aria-hidden
            />
            <span
              className="pointer-events-none absolute inset-0 rounded-[calc(var(--r-lg)-3px)] [background:linear-gradient(180deg,rgba(255,255,255,0.32),transparent_46%)] [mix-blend-mode:screen]"
              aria-hidden
            />
          </div>
        ))}
      </div>

      {/* Leyenda: una fila de botones, diana grande para el dedo. Tocar aquí hace
          lo mismo que tocar el segmento. El índice casa con el del carril. */}
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-3 lg:flex-nowrap">
        {segmentos.map((s, i) => (
          <li key={s.id} className="min-w-0 flex-1 basis-[calc(50%-10px)] lg:basis-0">
            <button
              type="button"
              onClick={() => setActivo(i)}
              onFocus={() => setActivo(i)}
              aria-pressed={activo === i}
              className={cn(
                "flex min-h-11 w-full flex-col items-start rounded-md px-1 py-1 text-left",
                "transition-colors duration-150 ease-out",
                activo === i && "bg-surface-2",
              )}
            >
              <span
                className="mb-2 h-[4px] w-[22px] rounded-full"
                style={{ background: s.color }}
                aria-hidden
              />
              <span
                className={cn(
                  "w-full truncate text-[13px] leading-[18px]",
                  activo === i ? "font-semibold text-fg" : "text-muted",
                )}
              >
                {s.nombre}
              </span>
              <span className="cifra mt-0.5 text-[15px] leading-5 text-fg tabular-nums">
                {s.texto}
              </span>
              <span className="text-[13px] leading-[18px] text-muted tabular-nums">{s.share}</span>
            </button>
          </li>
        ))}
      </ul>

      {nota ? <div className="mt-3">{nota}</div> : null}
    </div>
  );
}
