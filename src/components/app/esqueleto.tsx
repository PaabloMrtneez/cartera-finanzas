import { PageBody, PageHeader } from "@/components/app/page-header";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";

/**
 * Las piezas de los esqueletos de carga (`loading.tsx` de cada pantalla).
 *
 * POR QUÉ. Sin `loading.tsx`, tocar una pestaña no cambiaba NADA en pantalla
 * hasta que el servidor terminaba todas las consultas: 0,8–1,6 s mudos en un
 * móvil. Con él, Next precarga este esqueleto junto al enlace y lo pinta en el
 * acto; la pantalla de verdad llega por streaming y lo sustituye.
 *
 * FIELES A LA PANTALLA. La cabecera es la de verdad (`PageHeader` con su
 * título y su flecha de volver): lo primero que se ve ya dice adónde se ha
 * ido. Debajo, la misma maqueta —héroe, tira, tarjetas, lista— con las MISMAS
 * clases de tamaño que la pantalla (`cifra-hero`, el `PageBody` con su ancho),
 * de modo que al llegar el contenido las cosas no saltan de sitio. Los bloques
 * llevan `esqueleto` (el brillo de la superficie secundaria, que con movimiento
 * reducido se queda en un latido).
 *
 * Accesibilidad: el cuerpo va `aria-busy` y anuncia «Cargando…» una vez; los
 * bloques son decorativos.
 */

export function EsqueletoPantalla({
  titulo,
  subtitulo = false,
  className,
  children,
}: {
  titulo: string;
  /** La pantalla lleva subtítulo en la cabecera: se reserva su renglón. */
  subtitulo?: boolean;
  /** Las mismas clases que el `PageBody` de la pantalla (ancho, rejilla). */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader title={titulo} subtitle={subtitulo ? " " : undefined} />
      <PageBody className={className} aria-busy="true">
        <p role="status" className="sr-only">
          Cargando…
        </p>
        {children}
      </PageBody>
    </>
  );
}

/** Un bloque de esqueleto suelto. */
export function Bloque({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block esqueleto rounded-xs", className)} />;
}

/**
 * La cifra héroe sin caja: rótulo, la cifra al cuerpo de `cifra-hero` (el alto
 * lo da la propia utilidad, así que si cambia el token el esqueleto le sigue) y
 * una línea de pie.
 */
export function EsqHeroe({ pie = true, className }: { pie?: boolean; className?: string }) {
  return (
    <section aria-hidden className={cn("flex flex-col", className)}>
      <span className="flex h-[18px] items-center">
        <Bloque className="h-3 w-40" />
      </span>
      <span className="mt-2 flex items-center cifra-hero">
        {/* Un espacio duro da al renglón el alto de la cifra. */}
        <span className="inline-block w-[6.5ch] esqueleto rounded-sm">&nbsp;</span>
      </span>
      {pie ? (
        <span className="mt-2 flex h-5 items-center lg:h-[22px]">
          <Bloque className="h-3 w-56" />
        </span>
      ) : null}
    </section>
  );
}

/** La tira de totales separada por filetes (Ingresos · Balance · Previsión). */
export function EsqTira({ columnas = 3 }: { columnas?: number }) {
  return (
    <div aria-hidden className="flex hair-t hair-b border-hairline">
      {Array.from({ length: columnas }, (_, i) => (
        <div key={i} className="flex flex-1">
          {i > 0 ? <div className="w-px bg-hairline" /> : null}
          <div className={cn("flex flex-1 flex-col py-3 lg:py-4", i > 0 && "pl-4 lg:pl-6")}>
            <span className="flex h-[18px] items-center lg:h-5">
              <Bloque className="h-3 w-16" />
            </span>
            <span className="mt-1 flex h-7 items-center lg:h-9">
              <Bloque className="h-5 w-24 lg:h-6" />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Una tarjeta con su título y un cuerpo del alto que se le dé (el de la
 * gráfica o el bloque que sustituye).
 */
export function EsqTarjeta({
  cuerpo = "h-40",
  titulo = true,
  className,
}: {
  /** Clases de alto del cuerpo, p. ej. `h-48 lg:h-64`. */
  cuerpo?: string;
  titulo?: boolean;
  className?: string;
}) {
  return (
    <Card aria-hidden className={className}>
      {titulo ? (
        <div className="flex h-[52px] items-end px-[18px] pb-[10px]">
          <Bloque className="h-4 w-36" />
        </div>
      ) : null}
      <div className={cn("px-[18px] pb-4", !titulo && "pt-4")}>
        <Bloque className={cn("w-full rounded-md", cuerpo)} />
      </div>
    </Card>
  );
}

/** Una lista de filas con icono redondo, dos líneas y la cifra a la derecha. */
export function EsqLista({
  filas = 5,
  cabecera = false,
  className,
}: {
  filas?: number;
  /** Con la cabecera de día de la lista de movimientos. */
  cabecera?: boolean;
  className?: string;
}) {
  return (
    <Card aria-hidden className={className}>
      {cabecera ? (
        <div className="flex h-8 items-center bg-surface-2 px-4">
          {/* Sobre la superficie secundaria, el bloque va en filete: con el
              color del esqueleto no se vería. */}
          <span className="block h-3 w-28 rounded-xs bg-hairline" />
        </div>
      ) : null}
      {Array.from({ length: filas }, (_, i) => (
        <div key={i} className="flex min-h-[60px] items-center gap-3 px-4 py-[9px]">
          <span className="size-[38px] shrink-0 esqueleto rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <Bloque className="h-3.5 w-2/5" />
            <Bloque className="h-3 w-3/5" />
          </span>
          <Bloque className="h-3.5 w-16" />
        </div>
      ))}
    </Card>
  );
}
