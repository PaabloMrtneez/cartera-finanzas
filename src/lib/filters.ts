import type { TransactionType } from "./types";

/**
 * Los filtros de Movimientos. Vive fuera de los componentes de cliente a
 * propósito: la página es un componente de servidor y necesita leerlos, y desde
 * el servidor no se puede llamar a nada exportado por un módulo "use client".
 */
export type Filters = {
  q: string;
  tipo: TransactionType | "";
  categoria: string;
  cuenta: string;
  auto: boolean;
  pendientes: boolean;
};

/** Cuántos filtros hay puestos, para el distintivo del botón. */
export function activeFilterCount(f: Filters): number {
  return [f.tipo !== "", f.categoria !== "", f.cuenta !== "", f.auto, f.pendientes].filter(Boolean)
    .length;
}

/** Lee los filtros de los parámetros de la dirección. */
export function readFilters(params: Record<string, string | string[] | undefined>): Filters {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : "";
  };
  const tipo = one("tipo");
  return {
    q: one("q"),
    tipo: (["EXPENSE", "INCOME", "TRANSFER"].includes(tipo) ? tipo : "") as TransactionType | "",
    categoria: one("categoria"),
    cuenta: one("cuenta"),
    auto: one("auto") === "1",
    pendientes: one("pendientes") === "1",
  };
}
