import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";

/**
 * Una sección de Ajustes: título y explicación a un lado, controles al otro.
 *
 * En escritorio eran dos columnas de tarjetas, y una rejilla de bloques de
 * alturas tan distintas (El Atajo mide seis veces lo que Apariencia) deja un
 * hueco al lado de cada bloque corto. Aquí cada sección tiene su propia fila:
 * la columna estrecha es solo para leer y se queda a la vista mientras se baja
 * por una tarjeta larga. Mide mucho menos que la ventana, así que puede anclarse.
 *
 * En móvil es lo de siempre: rótulo, explicación y tarjeta, uno debajo de otro.
 */
export const FILA_SECCION =
  "flex flex-col gap-2 lg:grid lg:grid-cols-[clamp(200px,20vw,280px)_minmax(0,1fr)] lg:gap-x-[clamp(24px,3.4vw,48px)] lg:hair-t lg:border-hairline lg:pt-8";

export function SeccionAjustes({
  titulo,
  descripcion,
  claseTarjeta,
  children,
}: {
  titulo: string;
  descripcion?: React.ReactNode;
  /** Va solo a la tarjeta: relleno, disposición interior. */
  claseTarjeta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={FILA_SECCION}>
      <div className="flex flex-col gap-1 px-1 lg:sticky lg:top-[88px] lg:gap-2 lg:self-start lg:px-0">
        <h2 className="text-[13px] leading-[18px] font-semibold tracking-[0.03em] text-muted uppercase lg:text-[17px] lg:leading-[22px] lg:tracking-normal lg:text-fg lg:normal-case">
          {titulo}
        </h2>
        {descripcion ? (
          <div className="flex flex-col gap-2 text-[13px] leading-[18px] text-muted lg:text-[14px] lg:leading-5">
            {descripcion}
          </div>
        ) : null}
      </div>
      {/*
        `@container`: lo que cabe en una línea dentro de la tarjeta depende de lo
        que mide ella, no la ventana. A 1024 px ya es escritorio, pero con las dos
        barras la tarjeta se queda en 460 px.
      */}
      <Card className={cn("@container lg:self-start", claseTarjeta)}>{children}</Card>
    </section>
  );
}

/** Las clases de una fila de ajustes: icono, texto y, si la hay, su acción. */
export const FILA_AJUSTE =
  "flex min-h-[60px] items-center gap-3 hair-t border-separator px-[18px] py-3 first:border-t-0";

/** Lo mismo para una fila que es entera un enlace. */
export const FILA_AJUSTE_ENLACE = cn(FILA_AJUSTE, "fila-pulsable text-fg lg:hover:bg-surface-2");

/** El interior de una fila. Con todas iguales, los textos caen en la misma vertical. */
export function ContenidoFila({
  icono,
  claseIcono = "bg-surface-2 text-muted",
  titulo,
  detalle,
}: {
  icono: React.ReactNode;
  /** El fondo y el color del círculo, para las filas que dicen un estado. */
  claseIcono?: string;
  titulo: React.ReactNode;
  detalle?: React.ReactNode;
}) {
  return (
    <>
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", claseIcono)}>
        {icono}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] leading-5 font-semibold wrap-anywhere">{titulo}</span>
        {detalle ? <span className="text-[13px] leading-[18px] text-muted">{detalle}</span> : null}
      </span>
    </>
  );
}
