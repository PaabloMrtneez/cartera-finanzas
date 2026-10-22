"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { escaparComodinesLike, patronContienePostgrest } from "@/lib/busqueda";
import { cn } from "@/lib/cn";
import { shortDate } from "@/lib/dates";
import { formatSignedCents } from "@/lib/money";
import { SECTIONS } from "@/lib/nav";
import { createClient } from "@/lib/supabase/client";
import type { EntryType } from "@/lib/supabase/database.types";
import { mensajeErrorLectura } from "@/lib/llamar-accion";

type Resultado =
  | { tipo: "seccion"; id: string; titulo: string; icono: string; href: string }
  | { tipo: "categoria"; id: string; titulo: string; icono: string; color: string; href: string }
  | { tipo: "cuenta"; id: string; titulo: string; href: string }
  | {
      tipo: "movimiento";
      id: string;
      titulo: string;
      href: string;
      cents: number;
      entrada: EntryType;
      fecha: string;
    };

/**
 * El cuerpo de la búsqueda global: el diálogo de Radix, el campo, las consultas
 * a Supabase y la lista de resultados.
 *
 * Vive en su propio módulo y se carga con `next/dynamic` desde `command-search`,
 * de modo que ni Radix ni `@supabase/supabase-js` entran en el paquete inicial
 * de cada pantalla: llegan la primera vez que se abre la paleta. La búsqueda es
 * de escritorio y a demanda, así que un pequeño retardo al abrirla por primera
 * vez no se nota; a cambio, ninguna pantalla arrastra esos kilobytes sin usarlos.
 *
 * El estado (abrir/cerrar) lo gobierna el armazón ligero; aquí solo se recibe.
 */
export default function CommandSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [activo, setActivo] = useState(0);
  const [buscando, setBuscando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);
  // Turno de la última búsqueda lanzada. Una consulta lenta que vuelve DESPUÉS
  // de otra más reciente no pisa sus resultados: se descarta.
  const turno = useRef(0);
  // Ids del patrón combobox: el campo dice qué lista controla y cuál de sus
  // opciones es la señalada, para que el lector de pantalla siga las flechas.
  const base = useId();
  const idLista = `${base}-lista`;
  const idOpcion = (indice: number) => `${base}-opcion-${indice}`;

  const buscar = useCallback(async (consulta: string) => {
    const limpio = consulta.trim();
    const mio = ++turno.current;

    // Sin texto, se ofrecen las secciones: sirve de navegador rápido.
    if (limpio.length === 0) {
      setResultados(
        SECTIONS.map((s) => ({
          tipo: "seccion" as const,
          id: s.href,
          titulo: s.label,
          icono: s.icon,
          href: s.href,
        })),
      );
      setBuscando(false);
      return;
    }

    setBuscando(true);
    const supabase = createClient();

    // Lo escrito nunca se interpola en la gramática de filtros de PostgREST: una
    // coma o un paréntesis la reescribirían. Los nombres van por `.ilike()` con
    // el patrón escapado, y los movimientos por `search_transactions`, donde el
    // texto llega a Postgres como parámetro (y busca en los mismos campos que
    // la pantalla de Movimientos, nombres de categoría y cuenta incluidos).
    const patron = patronContienePostgrest(limpio);
    const [categorias, cuentas, movimientos] = await Promise.all([
      supabase.from("category").select("id, name, icon, color").ilike("name", patron).limit(5),
      supabase.from("account").select("id, name").ilike("name", patron).limit(5),
      supabase.rpc("search_transactions", { p_q: escaparComodinesLike(limpio), p_limit: 12 }),
    ]);

    if (mio !== turno.current) return;

    const error = categorias.error ?? cuentas.error ?? movimientos.error;
    setFallo(error ? mensajeErrorLectura(error, "los resultados") : null);

    const salida: Resultado[] = [
      ...(categorias.data ?? []).map((c) => ({
        tipo: "categoria" as const,
        id: c.id,
        titulo: c.name,
        icono: c.icon,
        color: c.color,
        href: `/movimientos?categoria=${c.id}&mes=todo`,
      })),
      ...(cuentas.data ?? []).map((a) => ({
        tipo: "cuenta" as const,
        id: a.id,
        titulo: a.name,
        href: `/movimientos?cuenta=${a.id}&mes=todo`,
      })),
      ...(movimientos.data ?? []).map((t) => ({
        tipo: "movimiento" as const,
        id: t.id,
        titulo: t.description || t.merchant_raw || "Sin descripción",
        href: `/movimientos/${t.id}`,
        cents: t.amount_cents,
        entrada: t.type,
        fecha: t.occurred_on,
      })),
    ];

    setResultados(salida);
    setActivo(0);
    setBuscando(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const temporizador = setTimeout(() => void buscar(texto), texto.trim() ? 200 : 0);
    return () => clearTimeout(temporizador);
  }, [open, texto, buscar]);

  function ir(resultado: Resultado) {
    onOpenChange(false);
    setTexto("");
    router.push(resultado.href);
  }

  function alTeclear(event: React.KeyboardEvent) {
    if (resultados.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActivo((i) => (i + 1) % resultados.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActivo((i) => (i - 1 + resultados.length) % resultados.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const elegido = resultados[activo];
      if (elegido) ir(elegido);
    }
  }

  // Mantiene visible la fila señalada al moverse con el teclado. Se busca por
  // su id: la lista está AGRUPADA, así que el hijo n-ésimo del contenedor es un
  // grupo y no la fila n-ésima (antes se desplazaba hasta el grupo equivocado).
  useEffect(() => {
    document.getElementById(`${base}-opcion-${activo}`)?.scrollIntoView({ block: "nearest" });
  }, [activo, base]);

  const agrupado = agrupar(resultados);

  return (
    <Dialog
      open={open}
      onOpenChange={(siguiente) => {
        onOpenChange(siguiente);
        if (!siguiente) setTexto("");
      }}
    >
      {/*
          Sin animación de apertura: se abre con ⌘K y se puede usar cien veces
          al día. A esa frecuencia la animación no adorna, estorba.
        */}
        <DialogContent size="buscar" title="Buscar en todo el histórico" instantaneo>
        <div className="flex flex-col gap-3">
          <div className="relative">
            <span aria-hidden className="absolute top-1/2 left-3 -translate-y-1/2 text-muted">
              <Icon name="search" size={18} />
            </span>
            <Input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={alTeclear}
              placeholder="Descripción, comercio, categoría o cuenta…"
              aria-label="Buscar"
              role="combobox"
              aria-expanded={resultados.length > 0}
              aria-controls={idLista}
              aria-autocomplete="list"
              aria-activedescendant={resultados.length > 0 ? idOpcion(activo) : undefined}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="go"
              className="pl-10 lg:h-11 lg:text-[17px]"
            />
          </div>

          {buscando && resultados.length === 0 ? (
            <div className="h-40 esqueleto rounded-md" />
          ) : resultados.length === 0 ? (
            <p role="status" className="py-10 text-center text-[15px] text-muted">
              {fallo ?? "Nada coincide. Prueba con otra palabra o con parte del nombre."}
            </p>
          ) : (
            /*
              Listbox con grupos. El foco se queda en el campo y las flechas
              mueven la opción señalada (`aria-activedescendant`), así que las
              filas no entran en el orden de tabulación: son opciones, no una
              lista de botones. El relleno de 4 px deja sitio al anillo de foco
              y al resaltado sin que el scroll los recorte por los lados.
            */
            <div
              id={idLista}
              role="listbox"
              aria-label="Resultados"
              className="-mx-1 max-h-[50vh] overflow-y-auto overscroll-contain px-1"
            >
              {agrupado.map(({ etiqueta, items }) => (
                <div key={etiqueta} role="group" aria-labelledby={`${base}-${etiqueta}`}>
                  <p
                    id={`${base}-${etiqueta}`}
                    className="px-1 pt-3 pb-1 text-[13px] font-semibold tracking-[0.03em] text-muted uppercase"
                  >
                    {etiqueta}
                  </p>
                  <div>
                    {items.map((resultado) => {
                      const indice = resultados.indexOf(resultado);
                      return (
                          <div
                            key={`${resultado.tipo}-${resultado.id}`}
                            id={idOpcion(indice)}
                            role="option"
                            aria-selected={indice === activo}
                            onClick={() => ir(resultado)}
                            onMouseEnter={() => setActivo(indice)}
                            className={cn(
                              "flex w-full min-h-11 cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-left",
                              indice === activo ? "bg-accent-soft" : "",
                            )}
                          >
                            <Icono resultado={resultado} />
                            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                              {resultado.titulo}
                            </span>
                            {resultado.tipo === "movimiento" ? (
                              <span className="shrink-0 text-[13px] text-muted tabular-nums">
                                {shortDate(resultado.fecha)} ·{" "}
                                {formatSignedCents(resultado.cents, resultado.entrada)}
                              </span>
                            ) : null}
                          </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p aria-hidden className="hidden items-center gap-3 pt-1 text-[13px] text-muted lg:flex">
            <Tecla>↑</Tecla>
            <Tecla>↓</Tecla>
            para moverte
            <Tecla>↵</Tecla>
            para abrir
            <Tecla>esc</Tecla>
            para cerrar
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Icono({ resultado }: { resultado: Resultado }) {
  if (resultado.tipo === "categoria") {
    return (
      <span
        aria-hidden
        className="flex size-[30px] shrink-0 items-center justify-center rounded-full"
        style={{
          background: `color-mix(in srgb, ${resultado.color} 16%, transparent)`,
          color: resultado.color,
        }}
      >
        <Icon name={resultado.icono} size={16} />
      </span>
    );
  }

  const nombre =
    resultado.tipo === "seccion"
      ? resultado.icono
      : resultado.tipo === "cuenta"
        ? "wallet"
        : "list";

  return (
    <span
      aria-hidden
      className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted"
    >
      <Icon name={nombre} size={16} />
    </span>
  );
}

function Tecla({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-xs bg-surface-2 px-[6px] py-[2px] font-mono text-[13px] text-fg">
      {children}
    </kbd>
  );
}

const ETIQUETAS: Record<Resultado["tipo"], string> = {
  seccion: "Ir a",
  categoria: "Categorías",
  cuenta: "Cuentas",
  movimiento: "Movimientos",
};

function agrupar(resultados: Resultado[]) {
  const orden: Resultado["tipo"][] = ["seccion", "categoria", "cuenta", "movimiento"];
  return orden
    .map((tipo) => ({
      etiqueta: ETIQUETAS[tipo],
      items: resultados.filter((r) => r.tipo === tipo),
    }))
    .filter((grupo) => grupo.items.length > 0);
}
