import { addDays, shiftDateMonths } from "@/lib/dates";

/**
 * Los rangos de la curva de patrimonio.
 *
 * Vive aquí y no dentro del componente por la misma razón que los filtros de
 * Movimientos: la página de Patrimonio es un componente de SERVIDOR y necesita
 * leer esta lista para validar el parámetro de la dirección, y desde el
 * servidor no se puede usar nada exportado por un módulo `"use client"`: Next
 * sustituye sus exports por referencias y `RANGOS.some` revienta con «is not a
 * function». Typecheck, lint y build pasan igual; solo se ve abriendo la página.
 *
 * DOS GRANULARIDADES. 1M y 3M son DIARIOS (`net_worth_daily`: un punto por
 * día, que con cierres mensuales «el último mes» serían dos puntos y una
 * recta); 6M, 1A y Todo son MENSUALES (`net_worth_monthly`). La página elige
 * la fuente según `granularidad`; el gráfico recibe puntos genéricos (rótulos,
 * valores y periodo anterior) y no cambia.
 */
export const RANGOS = [
  { clave: "1m", etiqueta: "1M", meses: 1, granularidad: "dia" },
  { clave: "3m", etiqueta: "3M", meses: 3, granularidad: "dia" },
  { clave: "6m", etiqueta: "6M", meses: 6, granularidad: "mes" },
  { clave: "1a", etiqueta: "1A", meses: 12, granularidad: "mes" },
  // «Todo» no tiene meses fijos: va desde el primer movimiento.
  { clave: "todo", etiqueta: "Todo", meses: null, granularidad: "mes" },
] as const;

export type ClaveRangoPatrimonio = (typeof RANGOS)[number]["clave"];

/** Si el rango se dibuja día a día o mes a mes. */
export function esDiario(clave: ClaveRangoPatrimonio): boolean {
  return RANGOS.find((r) => r.clave === clave)?.granularidad === "dia";
}

/**
 * Los días de un rango diario: desde el mismo día de hace N meses (recortado
 * a fin de mes, como en PostgreSQL) hasta hoy. Devuelve también el periodo
 * ANTERIOR, de la misma longitud y justo antes, para la discontinua.
 */
export function diasDeRango(
  clave: ClaveRangoPatrimonio,
  hoy: string,
): { desde: string; hasta: string; previoDesde: string; dias: number } {
  const meses = RANGOS.find((r) => r.clave === clave)?.meses ?? 1;
  const desde = addDays(shiftDateMonths(hoy, -meses), 1);
  const dias = diasEntre(desde, hoy) + 1;
  return { desde, hasta: hoy, previoDesde: addDays(desde, -dias), dias };
}

/** Días de `desde` a `hasta` (0 si son el mismo). */
export function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export const RANGO_PATRIMONIO_POR_DEFECTO: ClaveRangoPatrimonio = "1a";

/**
 * El rango pedido si es uno de los válidos; si no, un año. Los enlaces viejos
 * (`?rango=12`, `?rango=60`, de cuando había «12 meses / 5 años») siguen
 * abriendo lo que abrían.
 */
export function leerRango(valor: string | undefined): ClaveRangoPatrimonio {
  if (valor === "12") return "1a";
  if (valor === "60") return "todo";
  return RANGOS.some((r) => r.clave === valor)
    ? (valor as ClaveRangoPatrimonio)
    : RANGO_PATRIMONIO_POR_DEFECTO;
}

/** Cuántos meses hay desde el mes de `desde` hasta el de `hasta`, ambos incluidos. */
export function mesesEntre(desde: string, hasta: string): number {
  const [ya, ma] = desde.split("-").map(Number);
  const [yb, mb] = hasta.split("-").map(Number);
  return (yb - ya) * 12 + (mb - ma) + 1;
}

/**
 * Los meses que abarca un rango. «Todo» va desde el primer movimiento, con un
 * mínimo de dos (una curva necesita dos puntos) y un tope de diez años.
 */
export function mesesDeRango(
  clave: ClaveRangoPatrimonio,
  primerDia: string | null,
  hoy: string,
): number {
  const rango = RANGOS.find((r) => r.clave === clave);
  if (rango?.meses) return rango.meses;
  if (!primerDia) return 12;
  return Math.min(Math.max(mesesEntre(primerDia, hoy), 2), 120);
}
