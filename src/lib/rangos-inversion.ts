import { shiftDateMonths, todayIso } from "@/lib/dates";

/**
 * Los periodos sobre los que se mira una inversión.
 *
 * Vive aquí y no dentro del componente por la misma razón que `rangos.ts`: la
 * página de Inversiones es un componente de SERVIDOR y necesita esta lista para
 * validar el parámetro de la dirección. Desde el servidor no se puede usar nada
 * exportado por un módulo `"use client"`, porque Next sustituye sus exports por
 * referencias y lo que llega es un proxy.
 */
export const RANGOS_INVERSION = [
  { clave: "1m", etiqueta: "1 M", meses: 1 },
  { clave: "3m", etiqueta: "3 M", meses: 3 },
  { clave: "6m", etiqueta: "6 M", meses: 6 },
  { clave: "ytd", etiqueta: "Año", meses: null },
  { clave: "todo", etiqueta: "Todo", meses: null },
] as const;

export type ClaveRango = (typeof RANGOS_INVERSION)[number]["clave"];

/** Por defecto el año en curso: es el periodo del que se habla al hacer cuentas. */
export const RANGO_POR_DEFECTO: ClaveRango = "ytd";

export function leerRangoInversion(valor: string | undefined): ClaveRango {
  return RANGOS_INVERSION.some((r) => r.clave === valor)
    ? (valor as ClaveRango)
    : RANGO_POR_DEFECTO;
}

/**
 * Desde qué día mira cada rango.
 *
 * `todo` NO puede ser una fecha cualquiera de hace mucho. `position_return`
 * pondera cada aportación por la fracción del periodo que lleva dentro, así que
 * con un periodo de cincuenta años el denominador se queda casi en cero y el
 * porcentaje se dispara a miles. Arranca en el primer día que hay algo —el
 * `since` más antiguo, menos uno para que la aportación de ese mismo día cuente
 * entera— y así el reparto es el real.
 */
export function desdeRango(
  clave: ClaveRango,
  primerDia: string | null,
  hoy = todayIso(),
): string {
  const rango = RANGOS_INVERSION.find((r) => r.clave === clave);
  if (rango?.meses) return shiftDateMonths(hoy, -rango.meses);
  if (clave === "ytd") return `${hoy.slice(0, 4)}-01-01`;
  // `todo` sin ninguna posición todavía: el año en curso sirve igual.
  return primerDia ?? `${hoy.slice(0, 4)}-01-01`;
}

/** Cómo se nombra el periodo dentro de una frase: «en los últimos 3 meses». */
export function etiquetaPeriodo(clave: ClaveRango, hoy = todayIso()): string {
  const rango = RANGOS_INVERSION.find((r) => r.clave === clave);
  if (rango?.meses === 1) return "en el último mes";
  if (rango?.meses) return `en los últimos ${rango.meses} meses`;
  if (clave === "ytd") return `en ${hoy.slice(0, 4)}`;
  return "desde el principio";
}
