"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { CIFRA_LECTURA, type LecturaPunto, type TamanoLectura, type Tono } from "@/lib/graficos";

/**
 * LA CABECERA ES LA LECTURA. La gramática de Bolsa y Salud: nada flota sobre
 * la curva; al recorrerla, la cifra grande de arriba pasa a ser la del punto
 * que tienes bajo el dedo, con su fecha y su variación. Se lee donde siempre
 * se lee.
 *
 * POR QUÉ LOS DOS ESTADOS ESTÁN SIEMPRE PUESTOS. Reposo y lectura ocupan la
 * MISMA celda de la rejilla, y el que no toca se queda invisible pero con su
 * sitio guardado. Así el bloque mide siempre lo del más alto y nada de lo que
 * hay debajo salta al tocar. Con `hidden` no valdría: quita el hueco, que es
 * justo lo que hay que conservar.
 */

export const TONO_CLASE: Record<Tono, string> = {
  bien: "text-income",
  mal: "text-expense",
  neutro: "text-muted",
};

/** El enlace de una lectura: «Ver movimientos», con su chevrón. */
function EnlaceLectura({ href, texto }: { href: string; texto: string }) {
  return (
    <Link
      href={href}
      className="pulsable toque relative inline-flex shrink-0 items-center gap-[2px] text-[13px] leading-[18px] font-semibold text-accent-text"
    >
      {texto}
      <Icon name="chevron-right" size={14} />
    </Link>
  );
}

/**
 * Lo que oye el lector de pantalla al recorrer un gráfico.
 *
 * La lectura visible no sirve como región viva: está `aria-hidden` en reposo y
 * pasa a visible en el MISMO render en que cambia su texto, y VoiceOver y NVDA
 * no anuncian con fiabilidad una región que aparece a la vez que su contenido.
 * Esta está siempre montada (invisible) y solo cambia el texto: así se anuncia
 * cada punto al moverse con las flechas.
 */
function AnuncioLectura({ lectura }: { lectura: LecturaPunto | null }) {
  return (
    <span aria-live="polite" aria-atomic="true" className="sr-only">
      {lectura
        ? `${lectura.rotulo}: ${lectura.cifra}${lectura.detalle ? `, ${lectura.detalle}` : ""}`
        : ""}
    </span>
  );
}

export function CabeceraLectura({
  lectura,
  tamano = "normal",
  href,
  enlace = "Ver movimientos",
  inicio,
  children,
  className,
}: {
  /** La lectura del dato tocado, o null en reposo. */
  lectura: LecturaPunto | null;
  /** «fila» pone la lectura a la derecha de `inicio` (un medallón y un nombre). */
  tamano?: TamanoLectura;
  /** Adónde lleva el dato que se lee. Aparece solo leyendo. */
  href?: string;
  enlace?: string;
  inicio?: React.ReactNode;
  /** Lo que se ve en reposo, con las mismas medidas que la lectura. */
  children: React.ReactNode;
  className?: string;
}) {
  const leyendo = lectura !== null;
  // Sin nada tocado, la celda de lectura sigue dibujándose para reservar su
  // alto: invisible y con un contenido cualquiera del mismo tamaño.
  const l = lectura ?? { rotulo: " ", cifra: " " };

  const reposo = (
    <div
      className={cn("col-start-1 row-start-1 min-w-0", leyendo && "invisible")}
      aria-hidden={leyendo}
    >
      {children}
    </div>
  );

  if (tamano === "fila") {
    return (
      <div className={cn("flex items-center gap-3", className)}>
        {inicio}
        <div className="grid shrink-0 justify-items-end text-right">
          {reposo}
          <div
            className={cn(
              "col-start-1 row-start-1 flex flex-col items-end",
              !leyendo && "invisible",
            )}
            aria-hidden={!leyendo}
          >
            <span className={CIFRA_LECTURA.fila}>{l.cifra}</span>
            <span className="flex items-center gap-2 text-[13px] leading-[18px] text-muted tabular-nums">
              <span className="first-letter:uppercase">{l.rotulo}</span>
              {href && leyendo ? <EnlaceLectura href={href} texto="Ver" /> : null}
            </span>
          </div>
        </div>
        <AnuncioLectura lectura={lectura} />
      </div>
    );
  }

  return (
    <div className={cn("grid", className)}>
      {reposo}
      <div
        className={cn("col-start-1 row-start-1 flex min-w-0 flex-col gap-1", !leyendo && "invisible")}
        aria-hidden={!leyendo}
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[13px] leading-[18px] font-semibold text-muted first-letter:uppercase">
            {l.rotulo}
          </span>
          {href && leyendo ? <EnlaceLectura href={href} texto={enlace} /> : null}
        </span>
        <span className={CIFRA_LECTURA[tamano]}>{l.cifra}</span>
        {l.detalle !== undefined ? (
          <span className={cn("text-[14px] leading-5 tabular-nums", TONO_CLASE[l.tono ?? "neutro"])}>
            {l.detalle}
          </span>
        ) : null}
      </div>
      <AnuncioLectura lectura={lectura} />
    </div>
  );
}

/*
 * LECTURA COMPARTIDA. A veces la cifra grande no es del gráfico sino de la
 * pantalla: el patrimonio neto de la losa de Patrimonio. Para que AL TOCAR LA
 * CURVA SEA ESA CIFRA LA QUE LEA —y no una segunda copia del total encima del
 * gráfico—, la curva publica su lectura en este contexto y `CifraLectora`, que
 * envuelve la cifra héroe, la enseña. Fuera de un proveedor, cada gráfico lee
 * en su propia cabecera.
 */

type Compartida = {
  lectura: LecturaPunto | null;
  publicar: (l: LecturaPunto | null) => void;
};

const Contexto = createContext<Compartida | null>(null);

export function LecturaCompartida({ children }: { children: React.ReactNode }) {
  const [lectura, publicar] = useState<LecturaPunto | null>(null);
  return <Contexto.Provider value={{ lectura, publicar }}>{children}</Contexto.Provider>;
}

/** Publica una lectura en el proveedor más cercano, si lo hay. */
export function usePublicarLectura(lectura: LecturaPunto | null, activo: boolean) {
  const ctx = useContext(Contexto);
  const publicar = ctx?.publicar;
  const rotulo = lectura?.rotulo;
  const cifra = lectura?.cifra;
  const detalle = lectura?.detalle;
  const tono = lectura?.tono;
  useEffect(() => {
    if (!activo || !publicar) return;
    publicar(rotulo === undefined || cifra === undefined ? null : { rotulo, cifra, detalle, tono });
  }, [activo, publicar, rotulo, cifra, detalle, tono]);
  // Al desmontar (otro rango, otra pantalla), la cifra vuelve a su reposo.
  useEffect(() => {
    if (!activo || !publicar) return;
    return () => publicar(null);
  }, [activo, publicar]);
  return ctx !== null;
}

/**
 * La cifra héroe que lee lo que publica la curva. `children` es el reposo
 * (la cifra y su línea de variación, tal cual las pinta la pantalla); al leer,
 * la misma cifra con la clase `claseCifra` y debajo la fecha y la variación.
 */
export function CifraLectora({
  children,
  claseCifra,
  className,
}: {
  children: React.ReactNode;
  claseCifra: string;
  className?: string;
}) {
  const lectura = useContext(Contexto)?.lectura ?? null;
  const leyendo = lectura !== null;
  return (
    <div className={cn("grid", className)}>
      <div className={cn("col-start-1 row-start-1 min-w-0", leyendo && "invisible")} aria-hidden={leyendo}>
        {children}
      </div>
      <div
        className={cn("col-start-1 row-start-1 min-w-0", !leyendo && "invisible")}
        aria-hidden={!leyendo}
      >
        <p className={claseCifra}>{lectura?.cifra ?? " "}</p>
        <p className="mt-2 text-[14px] leading-5 tabular-nums">
          <span className="inline-block font-semibold text-fg first-letter:uppercase">
            {lectura?.rotulo}
          </span>
          {lectura?.detalle ? (
            <span className={TONO_CLASE[lectura.tono ?? "neutro"]}> · {lectura.detalle}</span>
          ) : null}
        </p>
      </div>
      <AnuncioLectura lectura={lectura} />
    </div>
  );
}
