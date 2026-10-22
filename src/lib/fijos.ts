/**
 * Fijos: lo que se repite solo, en las dos direcciones.
 *
 * Antes eran dos pantallas —Suscripciones e Ingresos recurrentes— y en el fondo
 * eran la misma cosa con el signo cambiado: algo que se repite cada cierto
 * tiempo, que genera su movimiento cuando toca y que pesa en el mes sin que
 * hagas nada. Ahora es una sola, con dos grupos.
 *
 * Esto vive en `src/lib` y no en el componente porque lo leen las dos orillas:
 * la página (servidor) decide qué grupo pinta y qué consulta lanza, y el
 * segmentado (cliente) pinta las mismas opciones con los mismos rótulos.
 */

export const VISTAS_FIJOS = [
  { value: "gastos", label: "Gastos fijos" },
  { value: "ingresos", label: "Ingresos fijos" },
] as const;

export type VistaFijos = (typeof VISTAS_FIJOS)[number]["value"];

export const VISTA_FIJOS_POR_DEFECTO: VistaFijos = "gastos";

/**
 * El grupo que pide la dirección (`?ver=`). Cualquier otra cosa —nada, un valor
 * repetido, uno inventado— es el grupo por defecto: un enlace viejo o mal
 * escrito abre la pantalla, no un error.
 */
export function leerVistaFijos(valor: string | string[] | undefined): VistaFijos {
  const v = Array.isArray(valor) ? valor[0] : valor;
  return VISTAS_FIJOS.some((o) => o.value === v) ? (v as VistaFijos) : VISTA_FIJOS_POR_DEFECTO;
}

/**
 * El neto fijo del mes: lo que entra fijo menos lo que sale fijo, en céntimos
 * enteros. Solo cuenta lo ACTIVO —lo que está en pausa no genera nada— y cada
 * importe ya viene mensualizado por la vista (`monthly_cents`), así que una
 * cuota anual pesa su doceava parte.
 */
export function netoFijo(
  gastos: readonly { monthly_cents: number; active: boolean }[],
  ingresos: readonly { monthly_cents: number; active: boolean }[],
): { gastosCents: number; ingresosCents: number; netoCents: number } {
  const suma = (filas: readonly { monthly_cents: number; active: boolean }[]) =>
    filas.reduce((s, f) => (f.active ? s + f.monthly_cents : s), 0);
  const gastosCents = suma(gastos);
  const ingresosCents = suma(ingresos);
  return { gastosCents, ingresosCents, netoCents: ingresosCents - gastosCents };
}
