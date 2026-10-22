import { esFechaIso } from "./dates";
import { formatCents } from "./money";
import type { Aviso } from "./push";

/**
 * Lo que la ruta del Atajo (/api/ingest) valida y normaliza ANTES de llamar a
 * la base. Vive aquí, y no en la ruta, porque un `route.ts` de Next solo puede
 * exportar los métodos HTTP y su configuración, y esto se prueba suelto.
 */

/**
 * Un importe que llega como NÚMERO JSON, a céntimos sin pasar por coma
 * flotante (H-06). Se trabaja sobre su texto más corto («12.5», «0.29»): con
 * más de dos decimales, negativo, cero o con exponente, es null. Nada de
 * `Math.round(x * 100)`, que redondea 1,005 a 1,00 € sin avisar.
 */
export function centimosDeNumero(amount: number): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/**
 * La tarjeta como la entiende la base: los 4 últimos dígitos o nada (H-02).
 * «123» o un texto sin cifras chocaban con el CHECK de 4 dígitos y el pago se
 * perdía; ahora va a la cuenta por defecto. Un número de tarjeta entero deja
 * sus 4 últimos.
 */
export function ultimosCuatro(card: string | null | undefined): string | null {
  const cifras = (card ?? "").replace(/\D/g, "");
  return cifras.length >= 4 ? cifras.slice(-4) : null;
}

/**
 * ¿Es una fecha (y hora) ISO 8601 que existe y que Postgres entiende? (H-02)
 * «2026-10-19», «2026-10-19T14:32», «2026-10-19T14:32:05.123+02:00», «…Z».
 */
export function esInstanteIso(texto: string): boolean {
  const m =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(
      texto.trim(),
    );
  if (!m || !esFechaIso(m[1])) return false;
  const [, , hh = "0", mm = "0", ss = "0"] = m;
  return Number(hh) <= 23 && Number(mm) <= 59 && Number(ss) <= 59;
}

/**
 * ¿Es un error de los DATOS (tipo, formato, restricción: SQLSTATE 22 y 23) y
 * no de la base caída o saturada? El primero no se arregla reintentando.
 */
export function esErrorDeDatos(error: { message?: string; code?: string }): boolean {
  if (error.code && /^(22|23)/.test(error.code)) return true;
  return /violates|invalid input|out of range|malformed/i.test(error.message ?? "");
}

/** Lo que devuelve `ingest_transaction` y hace falta para avisar del pago. */
export type PagoRegistrado = {
  id?: string;
  cents: number;
  merchant?: string | null;
  account?: string | null;
  category?: string | null;
  status?: string;
  inherited?: boolean;
};

/**
 * El aviso que llega al móvil en cuanto el Atajo registra un pago.
 *
 * Dice lo que ha pasado en dos líneas: cuánto y dónde, y qué ha hecho Cartera
 * con él. Si una regla (o lo que hiciste otras veces con ese comercio) le ha
 * puesto categoría, lo dice; si no, invita a entrar a ponérsela, y tocar el
 * aviso abre ese movimiento, que es donde se elige.
 *
 * No se menciona el Atajo: es cómo llega el dato, no algo que le importe a
 * quien acaba de pagar.
 */
export function avisoDePago(pago: PagoRegistrado): Aviso {
  const comercio = pago.merchant?.trim() || "un comercio";
  const cuenta = pago.account?.trim();
  const titulo = `Has pagado ${formatCents(Math.abs(pago.cents))} en ${comercio}`;

  let cuerpo: string;
  if (pago.status === "PENDING" || !pago.category) {
    cuerpo = "Sin categoría todavía. Entra para asignarle una.";
  } else if (pago.inherited) {
    cuerpo = `Asignado a ${pago.category}, como otras veces.`;
  } else {
    cuerpo = `Asignado a ${pago.category}${cuenta ? ` · ${cuenta}` : ""}.`;
  }

  return {
    title: titulo,
    body: cuerpo,
    url: pago.id ? `/movimientos/${pago.id}` : "/movimientos",
    tag: `ingesta-${pago.id ?? comercio}`,
  };
}
