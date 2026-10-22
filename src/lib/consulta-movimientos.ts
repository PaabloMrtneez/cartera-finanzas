import { escaparComodinesLike } from "./busqueda";
import { monthEnd, monthStart, todayIso } from "./dates";
import { readFilters, type Filters } from "./filters";
import type { TransactionType } from "./types";

/**
 * Cómo se traduce la dirección de Movimientos (`?mes=…&q=…&filas=…`) en la
 * llamada a `search_transactions`. Vive aquí, y no en la página, porque la usan
 * dos sitios que tienen que decir EXACTAMENTE lo mismo: la página, que pinta la
 * primera tanda, y la acción de «Cargar más», que trae las siguientes. Si
 * divergieran, la segunda tanda sería de otra consulta.
 */

/** Filas de la primera tanda. */
export const PAGINA = 100;
/** Lo que crece la lista con cada «Cargar más», como en el prototipo. */
export const PASO = 50;
/**
 * Tope de filas que se pintan en el servidor al abrir la pantalla (lo que pide
 * `?filas=` en la dirección). Antes eran 5000: una dirección compartida podía
 * pedir un documento de varios megas. Más allá de esto se sigue con «Cargar
 * más», que trae solo lo nuevo.
 */
export const MAX_FILAS_INICIALES = 500;
/** Hasta dónde puede pedir «Cargar más». */
export const MAX_DESDE = 20_000;

type Params = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un uuid, o nada. Lo que no lo sea haría fallar la RPC entera. */
function uuidONulo(valor: string): string | null {
  return UUID.test(valor) ? valor : null;
}

export type ConsultaMovimientos = {
  filters: Filters;
  /** «Todo el histórico» en lugar de un mes. */
  all: boolean;
  /** Primer día del mes que se mira. */
  month: string;
  /** Cuántas filas pinta la primera tanda. */
  filas: number;
};

/** Lee mes, filtros y número de filas de la dirección. */
export function leerConsulta(params: Params, hoy = todayIso()): ConsultaMovimientos {
  const filters = readFilters(params);
  const rawMonth = typeof params.mes === "string" ? params.mes : "";
  const all = rawMonth === "todo";
  const month = monthStart(/^\d{4}-\d{2}-\d{2}$/.test(rawMonth) ? rawMonth : hoy);

  const pedidas = Number(typeof params.filas === "string" ? params.filas : "");
  const filas = Number.isFinite(pedidas)
    ? Math.min(Math.max(Math.trunc(pedidas), PAGINA), MAX_FILAS_INICIALES)
    : PAGINA;

  return { filters, all, month, filas };
}

/** Los mismos parámetros, leídos de una cadena `a=1&b=2` (lo que manda el cliente). */
export function leerConsultaDeTexto(consulta: string, hoy = todayIso()): ConsultaMovimientos {
  const params: Params = {};
  for (const [clave, valor] of new URLSearchParams(consulta)) {
    if (!(clave in params)) params[clave] = valor;
  }
  return leerConsulta(params, hoy);
}

/** Los argumentos de `search_transactions` para una consulta y un límite. */
export function argumentosBusqueda(c: ConsultaMovimientos, limite: number) {
  const { filters, all, month } = c;
  return {
    p_from: all ? null : month,
    p_to: all ? null : monthEnd(month),
    p_type: (filters.tipo || null) as TransactionType | null,
    p_account: uuidONulo(filters.cuenta),
    p_category: filters.categoria !== "sin" ? uuidONulo(filters.categoria) : null,
    p_uncategorized: filters.categoria === "sin",
    p_only_shortcut: filters.auto,
    p_only_pending: filters.pendientes,
    // Literal: «50%» o «mi_tienda» se buscan tal cual, no como comodines.
    p_q: filters.q ? escaparComodinesLike(filters.q) : null,
    p_limit: limite,
  };
}

/**
 * Lo que viaja al navegador por cada movimiento: los campos que pinta la fila,
 * nada más. La categoría y las cuentas van por id, contra un catálogo que se
 * manda una sola vez (no un objeto entero repetido en cada fila).
 */
export type FilaLigera = {
  id: string;
  type: TransactionType;
  amount_cents: number;
  description: string | null;
  occurred_on: string;
  occurred_time: string;
  status: string;
  category_id: string | null;
  account_id: string;
  to_account_id: string | null;
};

export function filaLigera(tx: FilaLigera): FilaLigera {
  return {
    id: tx.id,
    type: tx.type,
    amount_cents: Number(tx.amount_cents),
    description: tx.description,
    occurred_on: tx.occurred_on,
    occurred_time: tx.occurred_time,
    status: tx.status,
    category_id: tx.category_id,
    account_id: tx.account_id,
    to_account_id: tx.to_account_id,
  };
}

export type Catalogo = {
  categorias: Record<string, { name: string; color: string; icon: string }>;
  cuentas: Record<string, { name: string }>;
};

/** Une una fila ligera con su catálogo para pintarla. */
export function conCatalogo(tx: FilaLigera, catalogo: Catalogo) {
  return {
    ...tx,
    category: tx.category_id ? (catalogo.categorias[tx.category_id] ?? null) : null,
    account: catalogo.cuentas[tx.account_id] ?? null,
    toAccount: tx.to_account_id ? (catalogo.cuentas[tx.to_account_id] ?? null) : null,
  };
}
