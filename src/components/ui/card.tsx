import type * as React from "react";
import { cn } from "@/lib/cn";

/**
 * La tarjeta: radio grande, superficie propia y `overflow-hidden` para que las
 * filas interiores no se salgan por las esquinas.
 *
 * Se separa del fondo con FILETE, no con sombra. Una sombra dice «esto flota
 * por encima», y en una pantalla con seis bloques apilados eso es mentira seis
 * veces; el filete solo dice «esto acaba aquí», que es lo que hace falta. En
 * oscuro la sombra ya era `none`, así que el filete es además lo único que
 * unifica los dos temas.
 */
export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("overflow-hidden rounded-lg hair border-hairline bg-surface", className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  action,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline gap-3 px-[18px] pt-4 pb-[10px]", className)}>
      <h2 className="flex-1 text-[17px] leading-[22px] font-semibold lg:text-[16px]">{title}</h2>
      {action}
    </div>
  );
}

/** Encabezado en mayúsculas, el que el prototipo usa sobre listas y bloques. */
export function Eyebrow({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn(
        "text-[13px] leading-[18px] font-semibold tracking-[0.03em] text-muted uppercase",
        className,
      )}
      {...props}
    />
  );
}

/** Tarjeta anidada dentro de otra: superficie secundaria y radio menor. */
export function InnerCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("overflow-hidden rounded-md bg-surface-2", className)} {...props} />
  );
}

/**
 * Sección con el rótulo FUERA de la tarjeta, al estilo de los ajustes de iOS.
 *
 * Un título dentro de la caja gasta una fila entera y empuja el contenido hacia
 * abajo; fuera, el rótulo hace de separador entre grupos y la tarjeta empieza
 * directamente por lo que importa. En una pantalla con seis grupos seguidos, la
 * diferencia es media pantalla de desplazamiento.
 */
export function Grupo({
  titulo,
  className,
  claseTarjeta,
  children,
}: {
  titulo: string;
  /**
   * Va al GRUPO, rótulo incluido. Aquí es donde tiene que ir `hidden lg:block`:
   * puesto en la tarjeta dejaba el rótulo solo en mitad de la pantalla,
   * anunciando una sección que no estaba.
   */
  className?: string;
  /** Va solo a la tarjeta: relleno, disposición interior. */
  claseTarjeta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <Eyebrow className="px-1">{titulo}</Eyebrow>
      <Card className={claseTarjeta}>{children}</Card>
    </section>
  );
}
