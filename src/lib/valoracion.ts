/**
 * El menos tipográfico (U+2212), el mismo que `MINUS` de money.ts. Va copiado
 * y no importado para que este módulo no importe nada: así
 * scripts/test-valoracion.mjs lo carga tal cual con Node y comprueba estas
 * mismas funciones contra la base real.
 */
const MINUS = "−";

/**
 * Valorar una posición por porcentaje, sin coma flotante.
 *
 * Módulo NEUTRAL a propósito (ni "use client" ni "use server"): la vista previa
 * del diálogo y la server action que guarda usan EXACTAMENTE las mismas
 * funciones, así que lo que se enseña es lo que se guarda, al céntimo.
 *
 * ── EL PORCENTAJE ES TEXTO, Y SE QUEDA EN ENTEROS ──────────────────────────
 *
 * `Number("12,5")` es NaN y `base * (1 + 12.5 / 100)` arrastra el error de
 * representación de los binarios (0,29 no existe en coma flotante). Así que el
 * texto se lee como un decimal EXACTO: «12,5» → 125 / 10, «−3,25» → −325 / 100,
 * «0,01» → 1 / 100. Y el valor nuevo se calcula como una fracción de enteros:
 *
 *   valor = base × (100·10^d + n) / (100·10^d)        (pct = n / 10^d)
 *
 * El producto se hace en BigInt, porque base × numerador se sale enseguida de
 * los 2^53 de un `number` (una base de 10 millones de euros por un porcentaje
 * con cuatro decimales ya pasa).
 *
 * ── REDONDEO: MITAD HACIA ARRIBA ───────────────────────────────────────────
 *
 * El resultado casi nunca cae en un céntimo exacto. Se redondea al céntimo más
 * cercano y, en el empate exacto (medio céntimo), HACIA ARRIBA. Es el redondeo
 * comercial, el que hace `round()` de Postgres sobre `numeric` (que es como se
 * redondean los porcentajes de rendimiento en la base) y el que hacía antes
 * `Math.round`. No se elige el bancario (mitad al par) porque aquí no se
 * acumulan miles de redondeos que haya que compensar: es UNA cifra que la
 * persona compara con la de su bróker, y los brókers redondean así. Como el
 * valor nunca es negativo (un −100 % deja la posición a cero y por debajo se
 * rechaza), «mitad hacia arriba» y «mitad lejos del cero» coinciden.
 */

/** Un porcentaje exacto: `n / 10^decimales` por ciento. */
export type Porcentaje = {
  /** El número sin coma, con su signo: «−3,25» → −325. */
  n: number;
  /** Cuántos decimales tenía: «−3,25» → 2. */
  decimales: number;
};

/** Más precisión que esta no la da ningún bróker; más allá es un error de tecleo. */
export const MAX_DECIMALES_PORCENTAJE = 4;

/**
 * Lee el porcentaje que escribe una persona: «5», «5,2», «-3,25», «−0,5 %»,
 * «+12.5», «,5». Coma o punto como decimal (un porcentaje no lleva separador de
 * millares, así que no hay ambigüedad posible con un solo separador).
 *
 * Devuelve null si no es un número limpio: nunca inventa un porcentaje.
 */
export function parsePercent(input: string): Porcentaje | null {
  if (typeof input !== "string") return null;

  const limpio = input
    .replace(new RegExp(MINUS, "g"), "-")
    .replace(/%/g, "")
    .replace(/\s+/g, "");

  const m = /^([+-]?)(\d*)(?:[.,](\d+))?$/.exec(limpio);
  if (!m) return null;

  const [, signo, entero, fraccion = ""] = m;
  if (entero === "" && fraccion === "") return null;
  if (fraccion.length > MAX_DECIMALES_PORCENTAJE) return null;
  // Seis cifras enteras: un 999.999 % ya es absurdo, pero no rompe nada.
  if (entero.length > 6) return null;

  const magnitud = Number((entero || "0") + fraccion);
  const n = signo === "-" ? -magnitud : magnitud;
  // Normaliza −0 a 0 para que «-0» y «0» sean el mismo porcentaje.
  return { n: n === 0 ? 0 : n, decimales: fraccion.length };
}

/**
 * Aplica un porcentaje a una base en céntimos: `base × (1 + pct / 100)`,
 * en enteros y redondeando al céntimo con mitad hacia arriba.
 *
 * Devuelve null si el resultado sería negativo (más de un −100 %) o no cabe
 * en un entero seguro.
 */
export function applyPercent(baseCents: number, pct: Porcentaje): number | null {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) return null;
  if (!Number.isSafeInteger(pct.n)) return null;

  const escala = BigInt(100) * BigInt(10) ** BigInt(pct.decimales);
  const numerador = BigInt(baseCents) * (escala + BigInt(pct.n));
  if (numerador < BigInt(0)) return null;

  // floor((2·num + den) / (2·den)) = redondeo al entero más cercano con el
  // empate hacia arriba. Con num >= 0, la división entera de BigInt (que trunca
  // hacia cero) es un floor.
  const dos = BigInt(2);
  const resultado = (dos * numerador + escala) / (dos * escala);

  const cents = Number(resultado);
  return Number.isSafeInteger(cents) ? cents : null;
}

// ---------------------------------------------------------------------------
// La base sobre la que se aplica el porcentaje.
// ---------------------------------------------------------------------------

export type ValoracionPrevia = { date: string; value_cents: number };
export type Aportacion = { occurred_on: string; amount_cents: number };

export type BaseValoracion = {
  /** La valoración de la que se parte: la última de un mes ANTERIOR. */
  valorPrevio: number;
  fechaPrevia: string;
  /** Lo aportado después de ella y hasta la fecha de la valoración nueva. */
  aportado: number;
  /** valorPrevio + aportado: lo que hay invertido según la vista. */
  base: number;
};

/**
 * Sobre qué se aplica un «+5 %» que se valora en la fecha `fecha`.
 *
 * Es el criterio del valor de una posición (v_position_value, migración
 * 20261005090300_valor_de_posicion_con_aportes_posteriores.sql):
 *
 *   valor(d) = última valoración con fecha <= d + lo aportado DESPUÉS de ella
 *              y hasta d (al coste: una aportación no es rendimiento)
 *
 * con UNA diferencia deliberada: la valoración de partida es la última de un
 * mes ANTERIOR al de `fecha`, no una del mismo mes. Hay una valoración por
 * posición y mes, y guardar otra del mismo mes la SUSTITUYE; si la base fuera
 * la que se va a sustituir, corregir un porcentaje mal tecleado lo aplicaría
 * encima del valor equivocado (5 % sobre el 5 % de antes) en vez de rehacerlo.
 * Así, «Cuánto ha variado» es siempre la variación desde el cierre anterior, y
 * repetir la misma valoración da la misma cifra.
 *
 * Una aportación del mismo día que la valoración previa se da por incluida en
 * ella (como en la vista); una del mismo día que la nueva, cuenta como
 * aportada. Sin valoración previa de un mes anterior no hay base: null.
 *
 * `valoraciones` y `aportaciones` pueden venir sin filtrar ni ordenar.
 */
export function baseDeValoracion(
  fecha: string,
  valoraciones: readonly ValoracionPrevia[],
  aportaciones: readonly Aportacion[],
): BaseValoracion | null {
  const inicioMes = `${fecha.slice(0, 7)}-01`;

  let previa: ValoracionPrevia | null = null;
  for (const v of valoraciones) {
    if (v.date < inicioMes && (previa === null || v.date > previa.date)) previa = v;
  }
  if (previa === null) return null;

  let aportado = 0;
  for (const a of aportaciones) {
    if (a.occurred_on > previa.date && a.occurred_on <= fecha) aportado += a.amount_cents;
  }

  return {
    valorPrevio: previa.value_cents,
    fechaPrevia: previa.date,
    aportado,
    base: previa.value_cents + aportado,
  };
}
