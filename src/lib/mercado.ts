/**
 * Cómo se ENSEÑAN las cifras de mercado: participaciones, precios y tipos de
 * cambio, que llegan de la base como texto decimal exacto («1234.56789000»,
 * «14.659200»).
 *
 * Módulo NEUTRAL (ni "use client" ni "use server"): lo usan la pantalla de
 * Inversiones, que es de servidor, y los diálogos, que son de cliente. Lo que se
 * enseña en los dos sitios sale de las mismas funciones.
 *
 * Nada de esto pasa por un `number` cuando puede perder precisión: el texto se
 * formatea tal cual, y la única cuenta (la vista previa del valor) se hace con
 * BigInt sobre los dígitos. El valor de verdad lo calcula la base; aquí solo se
 * adelanta para que quien escribe vea a qué equivale lo que escribe.
 */

/** Espacio duro, el mismo que Intl mete antes del €. */
const NBSP = " ";

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

// Sin literales `10n`: el objetivo de TypeScript es anterior a ES2020.
const CERO = BigInt(0);
const DOS = BigInt(2);
const DIEZ = BigInt(10);
const CIEN = BigInt(100);

/**
 * «1234.56789000» → «1234,56789»; «12345.5» → «12.345,50» con dos decimales
 * mínimos. Formato es-ES: coma decimal y punto de millares, que NO se agrupan
 * hasta las cinco cifras (como `Intl` en es-ES, y como `money.ts`).
 *
 * `max` recorta redondeando la mitad hacia arriba sobre los dígitos, sin pasar
 * por coma flotante. Devuelve el texto tal cual si no es un decimal.
 */
export function formatDecimalTexto(
  texto: string,
  { min = 0, max }: { min?: number; max?: number } = {},
): string {
  const m = DECIMAL.exec(texto.trim());
  if (!m) return texto;
  let entero = m[1].replace(/^0+(?=\d)/, "");
  let fraccion = m[2] ?? "";

  if (max !== undefined && fraccion.length > max) {
    // Redondeo exacto: se trabaja con el número entero de unidades de 10^-max.
    const escala = BigInt(fraccion.length - max);
    const n = BigInt(entero + fraccion);
    const divisor = DIEZ ** escala;
    const redondeado = (n * DOS + divisor) / (divisor * DOS);
    const digitos = redondeado.toString().padStart(max + 1, "0");
    entero = digitos.slice(0, digitos.length - max).replace(/^0+(?=\d)/, "");
    fraccion = max > 0 ? digitos.slice(digitos.length - max) : "";
  }

  fraccion = fraccion.replace(/0+$/, "");
  if (fraccion.length < min) fraccion = fraccion.padEnd(min, "0");

  const agrupado =
    entero.length >= 5 ? entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : entero;
  return fraccion ? `${agrupado},${fraccion}` : agrupado;
}

const simbolos = new Map<string, string>();

/** «EUR» → «€», «USD» → «$». Si Intl no conoce la divisa, el código. */
export function simboloDivisa(divisa: string): string {
  const guardado = simbolos.get(divisa);
  if (guardado) return guardado;
  let simbolo = divisa;
  try {
    simbolo =
      new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: divisa,
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? divisa;
  } catch {
    // Código que Intl no reconoce: se enseña tal cual.
  }
  simbolos.set(divisa, simbolo);
  return simbolo;
}

/** Un precio en su divisa: «14,6592 €», «350,50 $». Entre 2 y 6 decimales. */
export function formatPrecio(texto: string, divisa: string): string {
  return `${formatDecimalTexto(texto, { min: 2, max: 6 })}${NBSP}${simboloDivisa(divisa)}`;
}

export type TipoInstrumento = "FONDO" | "ETF" | "ACCION";

/** «Fondo», «ETF», «Acción». */
export const NOMBRE_TIPO: Record<TipoInstrumento, string> = {
  FONDO: "Fondo",
  ETF: "ETF",
  ACCION: "Acción",
};

/**
 * «1234,56789 part.» en un fondo; «12 acc.» en una acción o un ETF, que se
 * compran por acciones. Todos los decimales que haya: son los del bróker.
 */
export function formatParticipaciones(texto: string, tipo: TipoInstrumento | null): string {
  const unidad = tipo === "FONDO" || tipo === null ? "part." : "acc.";
  return `${formatDecimalTexto(texto)}${NBSP}${unidad}`;
}

/** «1 € = 1,1177 $»: el cambio del BCE como lo publica, unidades por euro. */
export function formatCambio(texto: string, divisa: string): string {
  return `1${NBSP}€ = ${formatDecimalTexto(texto, { min: 2, max: 5 })}${NBSP}${simboloDivisa(divisa)}`;
}

/** Un decimal en texto → entero y escala (n / 10^escala). null si no lo es. */
function aEscalado(texto: string): { n: bigint; escala: number } | null {
  const m = DECIMAL.exec(texto.trim());
  if (!m) return null;
  const fraccion = m[2] ?? "";
  return { n: BigInt(m[1] + fraccion), escala: fraccion.length };
}

/**
 * Participaciones × precio (÷ cambio) en céntimos, redondeando la mitad hacia
 * arriba: el mismo criterio que la base (round() de Postgres sobre numeric).
 * Exacto: BigInt sobre los dígitos, nunca coma flotante.
 *
 * Es una VISTA PREVIA. El valor que cuenta lo calcula la base con el precio del
 * día que toque; esto solo dice a qué equivale lo que se está escribiendo.
 */
export function valorEnCentimos(
  participaciones: string,
  precio: string,
  cambio: string | null = null,
): number | null {
  const u = aEscalado(participaciones);
  const p = aEscalado(precio);
  if (!u || !p) return null;

  let numerador = u.n * p.n * CIEN;
  let denominador = DIEZ ** BigInt(u.escala + p.escala);
  if (cambio !== null) {
    const f = aEscalado(cambio);
    if (!f || f.n === CERO) return null;
    numerador *= DIEZ ** BigInt(f.escala);
    denominador *= f.n;
  }
  const centimos = (numerador * DOS + denominador) / (denominador * DOS);
  if (centimos > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(centimos);
}

/**
 * Lo aportado a una posición hasta una fecha (incluida), en céntimos. Es lo que
 * pre-rellena el «total aportado» del alta: los traspasos ya enlazados.
 */
export function aportadoHasta(
  aportes: readonly { fecha: string; cents: number }[],
  fecha: string,
): number {
  let total = 0;
  for (const a of aportes) if (a.fecha <= fecha) total += a.cents;
  return total;
}
