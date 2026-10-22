import type { TransactionType } from "./types";

/**
 * Todo el dinero de la app son enteros en céntimos. Nunca coma flotante:
 * los importes se suman, se comparan y se guardan siempre como enteros, y
 * solo se dividen entre 100 en el último paso, para pintarlos.
 *
 * El formato es-ES de Intl reproduce exactamente la convención del prototipo:
 * no agrupa los millares hasta los 5 dígitos ("9800,00 €" pero "13.374,55 €"),
 * y usa espacio duro (U+00A0) antes del símbolo. Verificado, no supuesto.
 */

const eur = new Intl.NumberFormat("es-ES", {
  style: "currency",
  currency: "EUR",
});

const eurRounded = new Intl.NumberFormat("es-ES", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const plain = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Signo menos tipográfico. El prototipo lo usa en los porcentajes. */
export const MINUS = "−";
/** Espacio duro, el que Intl mete antes del €. */
export const NBSP = " ";

/** 1337455 → "13.374,55 €" */
export function formatCents(cents: number): string {
  return eur.format(cents / 100);
}

/** 1337455 → "13.375 €". Para cifras grandes donde los céntimos son ruido. */
export function formatCentsRounded(cents: number): string {
  // Se redondea la MAGNITUD, en enteros, y el signo se pone después: así
  // −1,50 € da «-2 €» igual que 1,50 € da «2 €» (Math.round iría hacia +∞).
  const euros = Math.floor((Math.abs(cents) + 50) / 100);
  return eurRounded.format(cents < 0 && euros !== 0 ? -euros : euros);
}

/** 1337455 → "13.374,55", sin símbolo. Para campos de formulario. */
export function formatCentsPlain(cents: number): string {
  return plain.format(cents / 100);
}

/**
 * Pinta un importe con el signo que le corresponde por su tipo. Los importes
 * se guardan siempre en positivo: el signo lo da el tipo de movimiento, y un
 * traspaso no lleva ninguno porque no es ni gasto ni ingreso.
 */
export function formatSignedCents(cents: number, type: TransactionType): string {
  const magnitude = eur.format(Math.abs(cents) / 100);
  if (type === "TRANSFER") return magnitude;
  return (type === "EXPENSE" ? "-" : "+") + magnitude;
}

/**
 * Convierte a céntimos lo que escribe una persona, lo que trae un extracto o lo
 * que manda el Atajo de iOS, que llega como texto ya formateado según la región
 * del teléfono ("23,45 €", "1.234,56", "23.45"...).
 *
 * Devuelve null si no hay forma de interpretarlo: nunca inventa un importe.
 *
 * El criterio, explícito porque de él depende dinero de verdad:
 *
 *   · Se descartan el símbolo «€», el código «EUR» y los espacios de alrededor.
 *     Cualquier otra letra («1e5», «2x 3,50», «12abc34») da null.
 *   · El menos vale en tres sitios: delante del número aunque vaya detrás del
 *     símbolo («€ -45,00»), al final, como lo ponen algunos bancos («45,00-»),
 *     o con paréntesis contables («(45,00)»). Dos signos a la vez, o un menos
 *     entre cifras, dan null. «-0» es 0, no menos cero.
 *   · Con «,» y «.» a la vez, el ÚLTIMO es el decimal y el otro tiene que ser
 *     de millares bien agrupado (de tres en tres).
 *   · Con un solo tipo de separador repetido («1.234.567»), todos son millares
 *     y se comprueban los grupos.
 *   · Con un único separador: una o dos cifras detrás son decimales («23.45»,
 *     «5,5»). Exactamente tres detrás de un entero de una a tres cifras que no
 *     es cero son millares («1.234» = 1234 €). Cualquier otra cosa («0,295»,
 *     «12,3456», «1234,567») serían más de dos decimales, y un importe no tiene
 *     fracciones de céntimo: null, nunca 295 € ni 123.456 €.
 *   · Los espacios (también el duro y el fino) y el apóstrofo suizo valen como
 *     separador de millares, con los grupos bien puestos.
 */
export function parseAmountToCents(input: string): number | null {
  if (typeof input !== "string") return null;

  let s = input
    .replace(new RegExp(MINUS, "g"), "-")
    .replace(/€|EUR/gi, "")
    .trim();
  if (!s) return null;

  // El signo: paréntesis contables, menos delante o menos detrás. Solo uno.
  let negativo = false;
  let signos = 0;
  const parentesis = /^\((.*)\)$/.exec(s);
  if (parentesis) {
    negativo = true;
    signos++;
    s = parentesis[1].trim();
  }
  const delante = /^([-+])\s*/.exec(s);
  if (delante) {
    if (delante[1] === "-") negativo = true;
    signos++;
    s = s.slice(delante[0].length);
  }
  const detras = /\s*-$/.exec(s);
  if (detras) {
    negativo = true;
    signos++;
    s = s.slice(0, s.length - detras[0].length);
  }
  if (signos > 1) return null;

  // Lo que queda solo pueden ser cifras, separadores y espacios de millares.
  if (!/^[\d.,'\s]+$/.test(s) || !/\d/.test(s)) return null;

  const comas = (s.match(/,/g) ?? []).length;
  const puntos = (s.match(/\./g) ?? []).length;

  let entero: string; // con sus separadores de millares, si los lleva
  let fraccion = "";

  if (comas > 0 && puntos > 0) {
    const partes = s.split(s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".");
    if (partes.length !== 2) return null;
    [entero, fraccion] = partes;
  } else if (comas + puntos > 1) {
    entero = s; // «1.234.567»: todos son millares
  } else if (comas + puntos === 1) {
    const [antes, despues] = s.split(/[.,]/);
    const esMillar = despues.length === 3 && /^\d{1,3}$/.test(antes) && /[1-9]/.test(antes);
    if (esMillar) {
      entero = s;
    } else {
      entero = antes;
      fraccion = despues;
    }
  } else {
    entero = s;
  }

  // La fracción: ninguna, una o dos cifras. Más serían fracciones de céntimo.
  if (!/^\d{0,2}$/.test(fraccion)) return null;

  // El entero: cifras seguidas o grupos de millares bien puestos.
  let cifras: string;
  if (/^\d*$/.test(entero)) {
    cifras = entero;
  } else {
    const grupos = entero.split(/[.,'\s]/);
    if (!/^\d{1,3}$/.test(grupos[0]) || grupos.slice(1).some((g) => !/^\d{3}$/.test(g))) return null;
    cifras = grupos.join("");
  }
  if (cifras === "" && fraccion === "") return null;
  if (cifras.length > 16) return null;

  const cents = Number(cifras || "0") * 100 + Number(fraccion.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  if (cents === 0) return 0;

  return negativo ? -cents : cents;
}

/**
 * Porcentajes con el menos tipográfico y espacio duro antes del %, como el
 * prototipo. `null` significa que no hay con qué comparar todavía.
 */
export function formatPercent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? MINUS : "+";
  return sign + Math.abs(value).toFixed(digits).replace(".", ",") + NBSP + "%";
}

/** Igual pero sin forzar el signo en los positivos: "38 %" de un reparto. */
export function formatShare(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits).replace(".", ",") + NBSP + "%";
}

/**
 * Variación porcentual entre dos importes. Devuelve null cuando no se puede
 * calcular (no hay dato anterior, o era cero y dividir no significaría nada).
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Una variación con su signo delante: `+1334,00 €` o `−269,15 €`.
 *
 * `formatSignedCents` pone el signo según el TIPO de movimiento, que es otra
 * cosa: un gasto lleva menos aunque su importe sea positivo. Aquí el signo es
 * el del número, porque lo que se pinta es una diferencia.
 */
export function formatSignedDelta(cents: number): string {
  return `${cents < 0 ? MINUS : "+"}${formatCents(Math.abs(cents))}`;
}
