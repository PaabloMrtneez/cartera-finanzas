/**
 * Préstamos en pantalla: la vista previa del formulario, las series de los
 * gráficos y las frases (la confirmación del borrado, el origen de una cuota).
 *
 * Módulo NEUTRAL (ni servidor ni cliente): lo usan las fichas de la pantalla,
 * que son componentes de servidor, y el formulario de alta, que es de cliente.
 * El cálculo del cuadro NO vive aquí: es `lib/prestamos.ts`, el espejo exacto
 * de la base. Esto solo lo prepara para enseñarlo.
 *
 * Todo importe es un entero en céntimos (invariante 1). Los tipos de interés
 * llegan de la base como TEXTO (`tin_pct::text`, «6.5000») y se pintan desde
 * el texto: un numeric por JSON llega como doble.
 */

import { parseIsoDate } from "./dates";
import { enumerar, nombreConfirma } from "./eliminar-cuenta";
import { NBSP, formatCents, parseAmountToCents } from "./money";
import {
  CuadroInvalido,
  PLAZO_MAXIMO,
  PRINCIPAL_MAXIMO,
  PRINCIPAL_MINIMO,
  TIN_MAXIMO,
  arranqueYaApuntado,
  comisionPorPorcentaje,
  leerTipo,
  primeraCuotaPorDefecto,
  resumenPrestamo,
  type LoanDeletePreview,
  type ResumenPrestamo,
} from "./prestamos";
import type { LoanPart } from "./types";

/** La misma regla que `delete_loan` en la base (y que al eliminar una cuenta). */
export { nombreConfirma };

const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_LARGOS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** «1 nov 2026»: la fecha de una cuota, con su año (un préstamo dura años). */
export function fechaCuota(iso: string): string {
  const { year, month, day } = parseIsoDate(iso);
  return `${day} ${MESES_CORTOS[month - 1]} ${year}`;
}

/** «nov 26»: el rótulo corto del eje de una curva de varios años. */
export function mesEje(iso: string): string {
  const { year, month } = parseIsoDate(iso);
  return `${MESES_CORTOS[month - 1]} ${String(year).slice(2)}`;
}

/** «octubre de 2031»: cuándo termina. */
export function mesLargo(iso: string): string {
  const { year, month } = parseIsoDate(iso);
  return `${MESES_LARGOS[month - 1]} de ${year}`;
}

/**
 * Un tipo de interés tal cual lo guarda la base («6.5000», «0.0000») → «6,5 %».
 * Desde el TEXTO: sin pasar por un número, se pinta exactamente lo guardado.
 */
export function formatTipo(texto: string | null | undefined): string {
  const campo = tipoParaCampo(texto);
  return campo === "" ? "—" : `${campo}${NBSP}%`;
}

/** «6.5000» → «6,5»: el tipo como lo escribiría una persona en el campo. */
export function tipoParaCampo(texto: string | null | undefined): string {
  if (!texto) return "";
  const m = /^(\d+)(?:\.(\d+))?$/.exec(texto.trim());
  if (!m) return "";
  const decimales = (m[2] ?? "").replace(/0+$/, "");
  return decimales ? `${m[1]},${decimales}` : m[1];
}

/** «12 de 60 cuotas». */
export function textoCuotas(pagadas: number, plazo: number): string {
  return `${pagadas.toLocaleString("es-ES")} de ${plazo.toLocaleString("es-ES")} ${plazo === 1 ? "cuota" : "cuotas"}`;
}

// ---------------------------------------------------------------------------
// El formulario: plazo, primera cuota y la vista previa en vivo.
// ---------------------------------------------------------------------------

export type UnidadPlazo = "MESES" | "ANIOS";

/**
 * El plazo escrito → meses. Solo dígitos (un plazo de «2,5 años» no es un
 * plazo de cuotas mensuales enteras: se escribe en meses). Null si no vale.
 */
export function leerPlazo(texto: string, unidad: UnidadPlazo): number | null {
  const limpio = texto.trim();
  if (!/^\d{1,3}$/.test(limpio)) return null;
  const n = Number(limpio);
  const meses = unidad === "ANIOS" ? n * 12 : n;
  return meses >= 1 && meses <= PLAZO_MAXIMO ? meses : null;
}

/**
 * Las fechas que puede tener la primera cuota: el día de cobro de cada mes,
 * siempre DESPUÉS del inicio (la base lo exige), trece meses a partir del
 * primero posible. La primera de la lista puede ser del mismo mes del inicio
 * si el día de cobro aún no ha llegado; la que se propone por defecto es la
 * de `primeraCuotaPorDefecto` (el mes siguiente), que es lo que hace la base.
 */
export function primerasCuotasPosibles(inicio: string, diaCobro: number, cuantas = 13): string[] {
  const { year, month, day } = parseIsoDate(inicio);
  const desde = diaCobro > day ? 0 : 1;
  const fechas: string[] = [];
  for (let k = 0; k < cuantas; k++) {
    const total = year * 12 + (month - 1) + desde + k;
    const a = Math.floor(total / 12);
    const m = (total % 12) + 1;
    fechas.push(`${a}-${String(m).padStart(2, "0")}-${String(diaCobro).padStart(2, "0")}`);
  }
  return fechas;
}

export type EntradaVistaPrevia = {
  principal: string;
  plazo: string;
  unidad: UnidadPlazo;
  tin: string;
  modoComision: "IMPORTE" | "PORCENTAJE";
  comision: string;
  diaCobro: number;
  inicio: string;
  /** La primera cuota elegida, o null para la de por defecto. */
  primera: string | null;
  /** true: el dinero entra ahora; false: ya estaba apuntado; null: sin elegir. */
  desembolso: boolean | null;
  /** Hoy en Madrid: el «hoy» con el que la base genera las cuotas. */
  hoy: string;
};

export type VistaPrevia =
  | { estado: "incompleto"; falta: string }
  | { estado: "error"; error: string }
  | {
      estado: "ok";
      resumen: ResumenPrestamo;
      plazoMeses: number;
      principalCents: number;
      comisionCents: number;
      primera: string;
      /** «Ya lo tenía apuntado»: desde qué cuota sigue la app y con qué deuda. */
      arranque: { primerPeriodo: number; pendiente: number } | null;
      /** «Entra ahora» con fecha pasada: cuántas cuotas se cobrarán al guardar. */
      vencidas: number;
    };

/**
 * La vista previa del alta, con las MISMAS reglas que el esquema del servidor
 * (`loanPreviewSchema`) y el MISMO cálculo que la base (`resumenPrestamo`).
 * Lo que enseña al escribir es lo que luego se cobra; la validación de verdad
 * sigue siendo la del servidor.
 */
export function vistaPreviaPrestamo(e: EntradaVistaPrevia): VistaPrevia {
  if (e.principal.trim() === "" || e.plazo.trim() === "" || e.tin.trim() === "") {
    return { estado: "incompleto", falta: "Escribe el importe, el plazo y el TIN para ver la cuota." };
  }
  const principalCents = parseAmountToCents(e.principal);
  if (principalCents === null || principalCents < PRINCIPAL_MINIMO || principalCents > PRINCIPAL_MAXIMO) {
    return { estado: "error", error: "El importe va de 100 € a 10 millones." };
  }
  const plazoMeses = leerPlazo(e.plazo, e.unidad);
  if (plazoMeses === null) {
    return { estado: "error", error: `El plazo va de 1 a ${PLAZO_MAXIMO} meses (40 años).` };
  }
  const tin = leerTipo(e.tin, TIN_MAXIMO);
  if (tin === null) {
    return { estado: "error", error: `El TIN se escribe como 6,5 (de 0 a ${TIN_MAXIMO} %, hasta cuatro decimales).` };
  }

  let comisionCents = 0;
  if (e.desembolso !== false && e.comision.trim() !== "") {
    if (e.modoComision === "PORCENTAJE") {
      const t = leerTipo(e.comision, 100);
      if (t === null) return { estado: "error", error: "La comisión en % se escribe como 1,5." };
      comisionCents = comisionPorPorcentaje(principalCents, t);
    } else {
      const c = parseAmountToCents(e.comision);
      if (c === null || c < 0) return { estado: "error", error: "La comisión se escribe en euros, como 150,00." };
      comisionCents = c;
    }
  }
  if (comisionCents >= principalCents) {
    return { estado: "error", error: "La comisión no puede llegar al importe del préstamo." };
  }

  const primera = e.primera ?? primeraCuotaPorDefecto(e.inicio, e.diaCobro);
  if (primera <= e.inicio) {
    return { estado: "error", error: "La primera cuota tiene que ser posterior a la fecha de inicio." };
  }

  let resumen: ResumenPrestamo;
  try {
    resumen = resumenPrestamo({
      principalCents,
      plazoMeses,
      tin,
      primeraCuota: primera,
      comisionCents,
    });
  } catch (error) {
    if (error instanceof CuadroInvalido) return { estado: "error", error: error.message };
    throw error;
  }

  let arranque: { primerPeriodo: number; pendiente: number } | null = null;
  if (e.desembolso === false) {
    arranque = arranqueYaApuntado(resumen.cuadro, e.hoy);
    if (!arranque) {
      return { estado: "error", error: "Todas las cuotas de este préstamo ya han pasado: estaría pagado." };
    }
  }
  const vencidas = e.desembolso === true ? resumen.cuadro.filter((f) => f.fecha <= e.hoy).length : 0;

  return { estado: "ok", resumen, plazoMeses, principalCents, comisionCents, primera, arranque, vencidas };
}

// ---------------------------------------------------------------------------
// Las series de la ficha.
// ---------------------------------------------------------------------------

/** Una fila de `loan_schedule`. */
export type FilaCuadro = {
  period: number;
  due_on: string;
  payment_cents: number;
  interest_cents: number;
  principal_cents: number;
  balance_after_cents: number;
  state: "PREVIA" | "COBRADA" | "PENDIENTE" | "ANULADA";
  /** Lo aportado de más justo después de esta cuota (0 si nada). */
  prepaid_cents: number;
};

export type PuntoCapital = {
  /** 0 es el arranque (todo el principal); k, después de la cuota k. */
  periodo: number;
  fecha: string;
  pendiente: number;
  /** true si ya pasó (cuota previa o cobrada). */
  pasado: boolean;
};

/**
 * El capital pendiente mes a mes, del inicio al fin, según el CUADRO: el punto
 * 0 es el día de la firma (todo el principal) y cada punto k, lo que queda tras
 * la cuota k. Lo pasado son las cuotas previas al alta y las cobradas.
 */
export function serieCapital(principalCents: number, inicio: string, filas: FilaCuadro[]): PuntoCapital[] {
  const puntos: PuntoCapital[] = [{ periodo: 0, fecha: inicio, pendiente: principalCents, pasado: true }];
  for (const f of filas) {
    puntos.push({
      periodo: f.period,
      fecha: f.due_on,
      pendiente: f.balance_after_cents,
      pasado: f.state === "PREVIA" || f.state === "COBRADA",
    });
  }
  return puntos;
}

/** Cuántos puntos de la serie han pasado ya (el arranque cuenta). */
export function puntosPasados(puntos: PuntoCapital[]): number {
  let n = 0;
  for (const p of puntos) {
    if (!p.pasado) break;
    n++;
  }
  return n;
}

/**
 * Qué parte del capital llevas devuelta, en % (para la GEOMETRÍA del anillo y
 * su rótulo). Viene de dos enteros en céntimos; nunca es un importe.
 */
export function parteDevuelta(devueltoCents: number, principalCents: number): number {
  if (principalCents <= 0) return 0;
  return Math.min(Math.max((devueltoCents / principalCents) * 100, 0), 100);
}

// ---------------------------------------------------------------------------
// Frases.
// ---------------------------------------------------------------------------

function contar(n: number, singular: string, plural: string): string {
  return `${n.toLocaleString("es-ES")} ${n === 1 ? singular : plural}`;
}

/**
 * Lo que dice el detalle de un movimiento que es parte de un préstamo: «Cuota
 * 3 de 60 del préstamo Coche · intereses». Sustituye al «Generado por un gasto
 * fijo», que es lo que diría por venir del generador.
 */
export function origenMovimientoPrestamo(a: {
  parte: LoanPart;
  periodo: number | null;
  plazo: number | null;
  nombre: string;
}): string {
  const de = `del préstamo ${a.nombre}`;
  switch (a.parte) {
    case "INTERESES":
    case "CAPITAL": {
      const cuota =
        a.periodo !== null && a.plazo !== null
          ? `Cuota ${a.periodo} de ${a.plazo}`
          : a.periodo !== null
            ? `Cuota ${a.periodo}`
            : "Cuota";
      return `${cuota} ${de} · ${a.parte === "INTERESES" ? "intereses" : "capital"}`;
    }
    case "DESEMBOLSO":
      return `El dinero ${de}, al entrar`;
    case "COMISION":
      return `Comisión de apertura ${de}`;
    case "LIQUIDACION":
      return `Liquidación ${de}`;
    case "COMISION_CANCELACION":
      return `Comisión de cancelación ${de}`;
    case "AMORTIZACION":
      return `Aportación extra ${de}`;
    case "COMISION_AMORTIZACION":
      return `Comisión de la aportación extra ${de}`;
  }
}

/** La frase principal del borrado: qué se borra. */
export function fraseBorradoPrestamo(p: LoanDeletePreview): string {
  const partes: string[] = [];
  if (p.transactions > 0) {
    partes.push(
      p.installments > 0
        ? `${contar(p.transactions, "movimiento", "movimientos")} (entre ellos, ${contar(p.installments, "cuota cobrada", "cuotas cobradas")})`
        : contar(p.transactions, "movimiento", "movimientos"),
    );
  }
  partes.push("la cuenta del préstamo");
  return `Se borrarán ${enumerar(partes)}.`;
}

/** El gasto que deja de contar: intereses y comisiones. Null si no había. */
export function fraseGastoPrestamo(p: LoanDeletePreview): string | null {
  if (p.expense_cents <= 0) return null;
  return `Dejarán de contar ${formatCents(p.expense_cents)} de gasto en intereses y comisiones.`;
}

/** Cuánto cambia el saldo de cada otra cuenta, una frase por cuenta. */
export function frasesSaldosPrestamo(p: LoanDeletePreview): string[] {
  return p.balance_effects
    .filter((x) => x.balance_delta_cents !== 0)
    .map((x) =>
      x.balance_delta_cents > 0
        ? `El saldo de ${x.account_name} subirá ${formatCents(x.balance_delta_cents)}.`
        : `El saldo de ${x.account_name} bajará ${formatCents(-x.balance_delta_cents)}.`,
    );
}

/** Qué le pasa al patrimonio. */
export function frasePatrimonioPrestamo(p: LoanDeletePreview): string {
  const d = p.net_worth_delta_cents;
  if (d === 0) return "Tu patrimonio no cambia.";
  return d > 0 ? `Tu patrimonio subirá ${formatCents(d)}.` : `Tu patrimonio bajará ${formatCents(-d)}.`;
}
