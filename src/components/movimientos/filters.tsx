"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { activeFilterCount, type Filters } from "@/lib/filters";
/** De categorías y cuentas, los filtros solo necesitan con qué identificarlas y cómo llamarlas. */
type Opcion = { id: string; name: string };
import { TYPE_COLOR_VAR, type TransactionType } from "@/lib/types";

function useApply() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  return (patch: Partial<Filters>) => {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === "" || value === false) query.delete(key);
      else query.set(key, value === true ? "1" : String(value));
    }
    router.push(`${pathname}?${query}`, { scroll: false });
  };
}

/** Buscador. Aparece siempre, en los dos tamaños. */
export function SearchBox({ value }: { value: string }) {
  const apply = useApply();
  const [text, setText] = useState(value);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        apply({ q: text.trim() });
      }}
      className="relative flex-1"
    >
      <span aria-hidden className="absolute top-1/2 left-3 -translate-y-1/2 text-muted">
        <Icon name="search" size={18} />
      </span>
      {/*
        El sitio donde busca va en el nombre accesible y no en el placeholder:
        «Busca en descripción, comercio, categoría o cuenta» no cabía en un
        móvil de 390 px y se cortaba a media palabra.
      */}
      <Input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={text}
        onChange={(e) => setText(e.target.value)}
        // Solo si cambió: antes cada vez que el campo perdía el foco se empujaba
        // otra entrada idéntica al historial, y «atrás» parecía no hacer nada.
        onBlur={() => {
          if (text.trim() !== value) apply({ q: text.trim() });
        }}
        placeholder="Buscar movimientos…"
        aria-label="Buscar en descripción, comercio, categoría o cuenta"
        className="pl-10"
      />
    </form>
  );
}

/**
 * Los mismos filtros en dos presentaciones: dentro de una hoja en móvil, en
 * línea en escritorio. El estado vive en la dirección en ambos casos.
 */
export function FilterControls({
  filters,
  categories,
  accounts,
  layout,
}: {
  filters: Filters;
  categories: Opcion[];
  accounts: Opcion[];
  /**
   * `columna` apila los controles con su rótulo encima: es lo que quiere la hoja
   * de móvil y también el raíl de escritorio. `linea` los pone en una fila que
   * se envuelve, para barras estrechas.
   */
  layout: "columna" | "linea";
}) {
  const apply = useApply();
  const inline = layout === "linea";

  return (
    <div className={cn(inline ? "flex flex-wrap items-center gap-2" : "flex flex-col gap-4")}>
      <div className={cn(inline ? "w-auto" : "flex flex-col gap-[6px]")}>
        {!inline ? <Label>Tipo</Label> : null}
        <Segmented
          label="Tipo de movimiento"
          value={filters.tipo === "" ? "TODOS" : filters.tipo}
          onChange={(next) => apply({ tipo: next === "TODOS" ? "" : (next as TransactionType) })}
          options={[
            { value: "TODOS", label: "Todos" },
            { value: "EXPENSE", label: "Gasto", color: TYPE_COLOR_VAR.EXPENSE },
            { value: "INCOME", label: "Ingreso", color: TYPE_COLOR_VAR.INCOME },
            { value: "TRANSFER", label: "Traspaso", color: TYPE_COLOR_VAR.TRANSFER },
          ]}
          className={inline ? "w-auto" : undefined}
        />
      </div>

      <div className={cn(inline ? "w-auto" : "flex flex-col gap-[6px]")}>
        {!inline ? <Label htmlFor="f-categoria">Categoría</Label> : null}
        <Select
          id="f-categoria"
          value={filters.categoria || "__todas"}
          onValueChange={(v) => apply({ categoria: v === "__todas" ? "" : v })}
          aria-label="Filtrar por categoría"
        >
          <SelectItem value="__todas">Todas las categorías</SelectItem>
          <SelectItem value="sin">Sin categorizar</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </Select>
      </div>

      <div className={cn(inline ? "w-auto" : "flex flex-col gap-[6px]")}>
        {!inline ? <Label htmlFor="f-cuenta">Cuenta</Label> : null}
        <Select
          id="f-cuenta"
          value={filters.cuenta || "__todas"}
          onValueChange={(v) => apply({ cuenta: v === "__todas" ? "" : v })}
          aria-label="Filtrar por cuenta"
        >
          <SelectItem value="__todas">Todas las cuentas</SelectItem>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </Select>
      </div>

      <Toggle
        label="Solo automáticos"
        active={filters.auto}
        onClick={() => apply({ auto: !filters.auto })}
      />
      <Toggle
        label="Pendientes"
        active={filters.pendientes}
        onClick={() => apply({ pendientes: !filters.pendientes })}
      />
    </div>
  );
}

function Toggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "pulsable toque relative h-8 shrink-0 rounded-xs px-3 text-[13px] font-semibold",
        "transition-[opacity,color,background-color] duration-150 ease-ui",
        active ? "bg-fg text-bg" : "bg-surface-2 text-muted",
      )}
    >
      {label}
    </button>
  );
}

/** Botón que abre los filtros en una hoja. Solo en móvil. */
export function FilterSheet({
  filters,
  categories,
  accounts,
}: {
  filters: Filters;
  categories: Opcion[];
  accounts: Opcion[];
}) {
  const apply = useApply();
  const count = activeFilterCount(filters);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" size="compact" className="relative shrink-0">
          <Icon name="list" size={15} />
          Filtros
          {count > 0 ? (
            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[13px] font-bold text-accent-ink tabular-nums">
              {count}
            </span>
          ) : null}
        </Button>
      </DialogTrigger>
      <DialogContent size="base" title="Filtros">
        <FilterControls
          filters={filters}
          categories={categories}
          accounts={accounts}
          layout="columna"
        />
        <DialogFooter>
          <Button
            variant="secondary"
            block
            onClick={() =>
              apply({ tipo: "", categoria: "", cuenta: "", auto: false, pendientes: false })
            }
          >
            Limpiar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
