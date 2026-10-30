/**
 * Préstamos personales: el cuadro de amortización, la TAE y la lectura del TIN.
 *
 * Módulo NEUTRAL a propósito (ni "use client" ni "use server"): la vista
 * previa del formulario, la server action y la prueba de base de datos
 * (scripts/test-prestamos.mjs, que lo carga tal cual con Node) usan EXACTAMENTE
 * estas funciones, y la prueba las compara al céntimo con `public.loan_plan` y
 * `public.loan_tae` de la base. Lo que se enseña al crear el préstamo es lo
 * que luego se cobra. Su único import es `./dates.ts`, CON la extensión, para
 * que Node lo resuelva sin empaquetador (y dates.ts solo importa tipos).
 *
 * ── SISTEMA FRANCÉS, EN ENTEROS ────────────────────────────────────────────
 *
 * Cuota constante: `cuota = P·i / (1 − (1+i)^−n)`, con `i = TIN / 12`.
 *
 * El TIN llega como TEXTO y se lee como decimal exacto en DIEZMILÉSIMAS DE
 * PUNTO: «6,5» → 65 000, «4,125» → 41 250. Así `i = T / D` con
 * `D = 12 · 100 · 10⁴ = 12 000 000`, y la cuota es una fracción de enteros:
 *
 *   cuota = P·T·(D+T)ⁿ / (D·((D+T)ⁿ − Dⁿ))
 *
 * `(D+T)ⁿ` tiene miles de cifras con 480 meses: se calcula en BigInt (y en la
 * base con `numeric`, que también es exacto). Nada de `Math.pow`, que daría una
 * cuota distinta de la de la base en el céntimo del empate.
 *
 * ── REDONDEO: MITAD HACIA ARRIBA, POR PERIODO ──────────────────────────────
 *
 *   · cuota       = redondeo(fórmula)                       (una vez)
 *   · intereses_k = redondeo(pendiente_k · T / D)           (cada mes)
 *   · capital_k   = cuota − intereses_k                     (meses 1..n−1)
 *   · la ÚLTIMA cuota paga TODO el pendiente: capital_n = pendiente_n e
 *     intereses_n = redondeo(pendiente_n · T / D). Así el pendiente acaba
 *     EXACTAMENTE en 0 y la suma del capital es el principal al céntimo.
 *
 * `redondeo(a/b) = ⌊(2a + b) / 2b⌋` con a, b ≥ 0: el céntimo más cercano y, en
 * el empate exacto, hacia arriba. El mismo que `applyPercent` de valoracion.ts.
 *
 * Con TIN 0 % la cuota es `redondeo(P / n)` y no hay intereses.
 *
 * ── LA TAE ES INFORMATIVA ──────────────────────────────────────────────────
 *
 * Es la tasa efectiva anual que iguala lo RECIBIDO (principal − comisión de
 * apertura) con el flujo de cuotas del cuadro: se busca el tipo mensual r con
 *
 *   P − comisión = Σ cuota_k / (1+r)^k          (k = 1..n)
 *
 * por bisección (100 pasos sobre [0, 1]) y `TAE = (1+r)¹² − 1`. Periodos
 * mensuales iguales, no días/365 como la del Banco de España: puede diferir en
 * alguna centésima de la del contrato, y por eso, si el usuario mete la del
 * banco, se enseña la suya.
 *
 * No es un importe sino un porcentaje, así que se calcula en coma flotante
 * (doble), con el MISMO orden de operaciones que `public.loan_tae` en la base:
 * sumas y productos de dobles IEEE dan el mismo resultado bit a bit en los dos
 * lados. El redondeo final a dos decimales reproduce el de Postgres
 * (`float8 → numeric` con 15 cifras significativas y `round(x, 2)`).
 */

import { daysInMonth, hoyMadrid, shiftDateMonths, toIso } from "./dates.ts";

/** D: 12 meses × 100 (es un porcentaje) × 10⁴ (el TIN admite cuatro decimales). */
const D = BigInt(12_000_000);

/** Más precisión que esta no la da ningún contrato; más allá es un error de tecleo. */
export const MAX_DECIMALES_TIPO = 4;
/** El TIN más alto que se admite (en %). Por encima es un error, no un préstamo. */
export const TIN_MAXIMO = 50;
/** La TAE más alta que se admite (en %). */
export const TAE_MAXIMA = 100;
/** Plazo máximo en meses (40 años). */
export const PLAZO_MAXIMO = 480;
/** Principal mínimo: 100 €. Por debajo el cuadro deja de tener sentido. */
export const PRINCIPAL_MINIMO = 10_000;
/** Principal máximo: 10 millones de euros. */
export const PRINCIPAL_MAXIMO = 1_000_000_000;

const MINUS = "−";

/**
 * Lee un tipo de interés escrito por una persona («6,5», «6.5 %», «4,125»,
 * «0») y lo devuelve en DIEZMILÉSIMAS de punto: «6,5» → 65 000. Coma o punto
 * como decimal; sin signo (un tipo negativo no es un préstamo).
 *
 * Devuelve null si no es un número limpio o pasa del máximo: nunca inventa un tipo.
 */
export function leerTipo(input: string, maximo = TIN_MAXIMO): number | null {
  if (typeof input !== "string") return null;
  const limpio = input.replace(new RegExp(MINUS, "g"), "-").replace(/%/g, "").replace(/\s+/g, "");
  const m = /^\+?(\d*)(?:[.,](\d+))?$/.exec(limpio);
  if (!m) return null;
  const [, entero, fraccion = ""] = m;
  if (entero === "" && fraccion === "") return null;
  if (fraccion.length > MAX_DECIMALES_TIPO || entero.length > 3) return null;
  const t = Number((entero || "0") + fraccion.padEnd(MAX_DECIMALES_TIPO, "0"));
  if (!Number.isSafeInteger(t) || t > maximo * 10_000) return null;
  return t;
}

/** Diezmilésimas de punto → el texto decimal exacto que entiende `numeric`: 65000 → "6.5". */
export function tipoComoDecimal(diezmilesimas: number): string {
  const entero = Math.floor(diezmilesimas / 10_000);
  const resto = String(diezmilesimas % 10_000).padStart(4, "0").replace(/0+$/, "");
  return resto ? `${entero}.${resto}` : String(entero);
}

/**
 * La comisión de apertura en céntimos a partir de un porcentaje del principal
 * (en diezmilésimas de punto, como el TIN), redondeada al céntimo con mitad
 * hacia arriba: 1 % de 10 000,00 € → 100,00 €.
 */
export function comisionPorPorcentaje(principalCents: number, diezmilesimas: number): number {
  const num = BigInt(principalCents) * BigInt(diezmilesimas);
  const den = BigInt(1_000_000); // 100 (%) × 10⁴ (decimales)
  return Number(redondeo(num, den));
}

/** ⌊(2a + b) / 2b⌋: el entero más cercano a a/b, con el empate hacia arriba (a, b ≥ 0). */
function redondeo(a: bigint, b: bigint): bigint {
  const dos = BigInt(2);
  return (dos * a + b) / (dos * b);
}

export type CuotaDelCuadro = {
  periodo: number;
  /** Fecha de la cuota, ISO. */
  fecha: string;
  cuota: number;
  intereses: number;
  capital: number;
  /** Capital pendiente DESPUÉS de esta cuota. */
  pendiente: number;
};

export type EntradaCuadro = {
  principalCents: number;
  plazoMeses: number;
  /** TIN en diezmilésimas de punto (6,5 % → 65 000). */
  tin: number;
  /** Fecha de la primera cuota, ISO. Las siguientes, el mismo día de cada mes. */
  primeraCuota: string;
};

export class CuadroInvalido extends Error {}

/**
 * El cuadro de amortización completo. Espejo exacto de `public.loan_plan`.
 * Lanza `CuadroInvalido` si los datos no dan un cuadro con sentido (el mismo
 * caso en que la base rechaza el préstamo).
 */
export function cuadroAmortizacion(e: EntradaCuadro): CuotaDelCuadro[] {
  const { principalCents, plazoMeses: n, tin, primeraCuota } = e;
  if (!Number.isSafeInteger(principalCents) || principalCents <= 0) {
    throw new CuadroInvalido("El importe tiene que ser mayor que cero.");
  }
  if (!Number.isInteger(n) || n < 1 || n > PLAZO_MAXIMO) {
    throw new CuadroInvalido(`El plazo va de 1 a ${PLAZO_MAXIMO} meses.`);
  }
  if (!Number.isInteger(tin) || tin < 0 || tin > TIN_MAXIMO * 10_000) {
    throw new CuadroInvalido(`El TIN va de 0 a ${TIN_MAXIMO} %.`);
  }

  const P = BigInt(principalCents);
  const T = BigInt(tin);
  const cuota = cuotaFrancesa(P, n, T);

  const filas: CuotaDelCuadro[] = [];
  let pendiente = P;
  for (let k = 1; k <= n; k++) {
    const intereses = redondeo(pendiente * T, D);
    const capital = k < n ? cuota - intereses : pendiente;
    // H-08: toda cuota tiene que amortizar algo. Con capital 0 el préstamo
    // solo paga intereses y TODO el principal caería en la última cuota.
    if (capital <= BigInt(0) || (k < n && pendiente - capital <= BigInt(0))) {
      throw new CuadroInvalido(NO_AMORTIZA);
    }
    pendiente -= capital;
    filas.push({
      periodo: k,
      fecha: sumarMeses(primeraCuota, k - 1),
      cuota: Number(intereses + capital),
      intereses: Number(intereses),
      capital: Number(capital),
      pendiente: Number(pendiente),
    });
  }

  // H-08: el medio céntimo de redondeo de la cuota se capitaliza durante todo
  // el plazo. En préstamos normales la última cuota se desvía unos céntimos;
  // con un TIN alto y un plazo muy largo, cientos de euros (50.000 € a 40 años
  // al 25 %: 979 € menos). Eso ya no es una cuota constante: se rechaza.
  if (n > 1) {
    const ultima = filas[n - 1].cuota;
    const normal = filas[0].cuota;
    if (Math.abs(ultima - normal) > Math.max(DESVIO_MINIMO, Math.floor(normal / 10))) {
      throw new CuadroInvalido(NO_AMORTIZA);
    }
  }
  return filas;
}

/**
 * La cuota francesa de `pendiente` a `meses` meses, en céntimos exactos:
 * `redondeo(P·T·(D+T)ⁿ / (D·((D+T)ⁿ − Dⁿ)))`, o `redondeo(P/n)` sin interés.
 * La misma cuenta que `public.loan_plan` y que `public.loan_cuadro` cuando una
 * aportación recalcula la cuota.
 */
function cuotaFrancesa(pendiente: bigint, meses: number, T: bigint): bigint {
  if (T === BigInt(0)) return redondeo(pendiente, BigInt(meses));
  let q = BigInt(1);
  let dn = BigInt(1);
  for (let k = 0; k < meses; k++) {
    q *= D + T;
    dn *= D;
  }
  return redondeo(pendiente * T * q, D * (q - dn));
}

const NO_AMORTIZA =
  "Con ese TIN y ese plazo la cuota no amortiza bien el préstamo. Prueba con un plazo más corto.";

// ---------------------------------------------------------------------------
// Aportaciones extra (amortización anticipada parcial)
// ---------------------------------------------------------------------------

/**
 * Qué hace una aportación con lo que queda:
 *   · PLAZO: la misma cuota; el préstamo termina antes (el que más ahorra).
 *   · CUOTA: el mismo fin; la cuota baja.
 */
export type ModoAportacion = "PLAZO" | "CUOTA";

/** Una aportación extra, tal como la guarda `public.loan_prepayment`. */
export type Aportacion = {
  /** Se aplica TRAS esta cuota (0: antes de la primera). */
  despuesDe: number;
  importe: number;
  modo: ModoAportacion;
};

/** Una fila del cuadro con aportaciones: la de siempre más lo aportado tras ella. */
export type CuotaConAportacion = CuotaDelCuadro & {
  /** Lo aportado justo después de esta cuota (ya restado de `pendiente`). */
  aportado: number;
};

/** La aportación mínima: 1 €. */
export const APORTACION_MINIMA = 100;

/**
 * Cómo está el préstamo justo después de la cuota k (y de lo aportado tras
 * ella): lo que se debe, la cuota que rige, el último periodo previsto y si el
 * tramo es de PLAZO (la cuota fija acorta el fin).
 */
type EstadoTramo = { pendiente: bigint; cuota: bigint; fin: number; enPlazo: boolean };

/**
 * El último periodo al que se llega pagando `cuota` desde lo que se debe tras
 * la cuota `k`, con las reglas de un tramo de PLAZO (la última paga todo; nunca
 * más allá de `fin`). Es el fin vigente que mantiene una aportación en CUOTA.
 */
function finPrevisto(pendiente: bigint, cuota: bigint, fin: number, k: number, T: bigint): number {
  let p = pendiente;
  for (let j = k + 1; ; j++) {
    const intereses = redondeo(p * T, D);
    if (j >= fin || cuota - intereses >= p) return j;
    p -= cuota - intereses;
  }
}

/** El motor: el cuadro efectivo y el estado tras cada cuota (0 = antes de la primera). */
function calcularConAportaciones(
  e: EntradaCuadro,
  aportaciones: Aportacion[],
): { filas: CuotaConAportacion[]; estados: Map<number, EstadoTramo> } {
  const original = cuadroAmortizacion(e); // valida las condiciones
  const T = BigInt(e.tin);
  const cero = BigInt(0);
  if (aportaciones.some((a) => !Number.isInteger(a.despuesDe) || a.despuesDe < 0)) {
    throw new CuadroInvalido("Aportación fuera del cuadro.");
  }
  // Estable: dos aportaciones del mismo mes, en el orden en que se hicieron.
  const orden = [...aportaciones].sort((a, b) => a.despuesDe - b.despuesDe);

  let pendiente = BigInt(e.principalCents);
  let cuota = cuotaFrancesa(pendiente, e.plazoMeses, T);
  let fin = e.plazoMeses;
  let enPlazo = false;
  let i = 0;
  const estados = new Map<number, EstadoTramo>();

  /** Aplica las aportaciones de tras la cuota `k` y devuelve cuánto se aportó. */
  const aplicar = (k: number): bigint => {
    let total = cero;
    while (i < orden.length && orden[i].despuesDe === k) {
      const a = orden[i++];
      if (!Number.isSafeInteger(a.importe) || a.importe < APORTACION_MINIMA) {
        throw new CuadroInvalido("Una aportación tiene que ser de 1 € o más.");
      }
      const importe = BigInt(a.importe);
      if (importe >= pendiente) {
        throw new CuadroInvalido("Esa aportación paga todo lo que queda: para eso, liquida el préstamo.");
      }
      if (a.modo === "CUOTA" && enPlazo) {
        // Tras reducir plazo, el fin vigente es antes que el del contrato:
        // reducir cuota tiene que mantener ESE fin, no volver a alargarlo.
        fin = finPrevisto(pendiente, cuota, fin, k, T);
      }
      pendiente -= importe;
      total += importe;
      if (a.modo === "CUOTA") {
        cuota = cuotaFrancesa(pendiente, fin - k, T);
        enPlazo = false;
      } else {
        enPlazo = true;
      }
    }
    estados.set(k, { pendiente, cuota, fin, enPlazo });
    return total;
  };

  if (orden.length === 0) {
    const filas = original.map((f) => ({ ...f, aportado: 0 }));
    estados.set(0, { pendiente, cuota, fin, enPlazo });
    for (const f of filas) estados.set(f.periodo, { pendiente: BigInt(f.pendiente), cuota, fin, enPlazo });
    return { filas, estados };
  }

  aplicar(0);
  const filas: CuotaConAportacion[] = [];
  for (let k = 1; pendiente > cero; k++) {
    const intereses = redondeo(pendiente * T, D);
    const ultima = k >= fin || (enPlazo && cuota - intereses >= pendiente);
    const capital = ultima ? pendiente : cuota - intereses;
    if (capital <= cero) throw new CuadroInvalido(NO_AMORTIZA);
    pendiente -= capital;
    const fila: CuotaConAportacion = {
      periodo: k,
      fecha: sumarMeses(e.primeraCuota, k - 1),
      cuota: Number(intereses + capital),
      intereses: Number(intereses),
      capital: Number(capital),
      pendiente: 0,
      aportado: 0,
    };
    if (ultima) {
      fin = k;
      estados.set(k, { pendiente, cuota, fin, enPlazo });
    } else {
      fila.aportado = Number(aplicar(k));
    }
    fila.pendiente = Number(pendiente);
    filas.push(fila);
  }
  if (i < orden.length) throw new CuadroInvalido("Esa aportación llega cuando el préstamo ya está pagado.");
  return { filas, estados };
}

/**
 * El cuadro EFECTIVO: el original, recalculado en cada aportación. Espejo
 * exacto de `public.loan_cuadro`; sin aportaciones da el cuadro original fila
 * a fila (`cuadroAmortizacion`).
 *
 * Para cada cuota k:
 *  1. Antes de ella se aplican, en orden, las aportaciones con `despuesDe =
 *     k − 1`: bajan el pendiente; en CUOTA se recalcula la cuota francesa con
 *     los meses que quedan hasta el fin; en PLAZO la cuota no cambia.
 *  2. intereses = redondeo(pendiente · T / D), como siempre.
 *  3. Es la última si llega el fin, o si (tras una aportación en PLAZO) la
 *     cuota ya cubre todo lo que queda: entonces paga TODO el pendiente y la
 *     deuda acaba en 0 al céntimo.
 *
 * La aportación se aplica al cambio de mes (tras la cuota): sin intereses por
 * días, que el banco puede cobrar aparte (van como comisión).
 *
 * Lanza `CuadroInvalido` si una aportación no cabe: menos de 1 €, igual o más
 * de lo que se debe (eso es liquidar), o después de la última cuota.
 */
export function cuadroConAportaciones(e: EntradaCuadro, aportaciones: Aportacion[]): CuotaConAportacion[] {
  return calcularConAportaciones(e, aportaciones).filas;
}

/** Los intereses de las cuotas posteriores a `desde`. */
function interesesDesde(cuadro: CuotaDelCuadro[], desde: number): number {
  return cuadro.filter((f) => f.periodo > desde).reduce((s, f) => s + f.intereses, 0);
}

/** La siguiente cuota después de `desde` (0 si ya no queda ninguna). */
function siguienteCuota(cuadro: CuotaDelCuadro[], desde: number): number {
  return cuadro.find((f) => f.periodo > desde)?.cuota ?? 0;
}

/** El efecto de una aportación: cómo queda el préstamo antes y después. */
export type EfectoAportacion = {
  finAntes: string;
  finDespues: string;
  cuotasAntes: number;
  cuotasDespues: number;
  /** La siguiente cuota, antes y después. */
  cuotaAntes: number;
  cuotaDespues: number;
  /** Intereses por pagar desde la última cuota cobrada. */
  interesesAntes: number;
  interesesDespues: number;
  /** Lo que te ahorras en intereses (sin contar la comisión). */
  ahorro: number;
  cuadro: CuotaConAportacion[];
};

/**
 * Qué pasa si se añade `nueva` a las aportaciones que ya hay, contado desde la
 * última cuota cobrada (`nueva.despuesDe`). Lanza `CuadroInvalido` como
 * `cuadroConAportaciones`.
 */
export function efectoAportacion(e: EntradaCuadro, aportaciones: Aportacion[], nueva: Aportacion): EfectoAportacion {
  const antes = cuadroConAportaciones(e, aportaciones);
  const despues = cuadroConAportaciones(e, [...aportaciones, nueva]);
  const desde = nueva.despuesDe;
  const interesesAntes = interesesDesde(antes, desde);
  const interesesDespues = interesesDesde(despues, desde);
  return {
    finAntes: antes[antes.length - 1].fecha,
    finDespues: despues[despues.length - 1].fecha,
    cuotasAntes: antes.filter((f) => f.periodo > desde).length,
    cuotasDespues: despues.filter((f) => f.periodo > desde).length,
    cuotaAntes: siguienteCuota(antes, desde),
    cuotaDespues: siguienteCuota(despues, desde),
    interesesAntes,
    interesesDespues,
    ahorro: interesesAntes - interesesDespues,
    cuadro: despues,
  };
}

/** Lo que dice el simulador «quiero terminar en N meses». */
export type PlanParaTerminar = {
  meses: number;
  /** La misma aportación cada mes, desde hoy, reduciendo plazo. */
  mensual: { extra: number; pagoMes: number; ahorro: number } | null;
  /** Una sola aportación hoy, reduciendo plazo. */
  unica: { importe: number; ahorro: number } | null;
};

/**
 * El simulador: cuánto hay que aportar para que lo que queda tras la cuota
 * `desde` se pague en `meses` cuotas o menos. El céntimo mínimo, por búsqueda
 * binaria sobre las mismas reglas que el cuadro. Null en cada respuesta si no
 * hace falta (ya terminas en esos meses) o no cabe.
 */
export function planParaTerminar(
  e: EntradaCuadro,
  aportaciones: Aportacion[],
  desde: number,
  meses: number,
): PlanParaTerminar {
  const { filas: base, estados } = calcularConAportaciones(e, aportaciones);
  const restantes = base.filter((f) => f.periodo > desde).length;
  const estado = estados.get(desde);
  if (!estado || !Number.isInteger(meses) || meses < 1 || meses >= restantes) {
    return { meses, mensual: null, unica: null };
  }
  const T = BigInt(e.tin);
  const pendiente = Number(estado.pendiente);
  const interesesBase = interesesDesde(base, desde);

  /** El menor importe en [1 €, pendiente − 1] que cumple `vale` (monótona). */
  const minimo = (vale: (x: number) => boolean): number | null => {
    let bajo = APORTACION_MINIMA;
    let alto = pendiente - 1;
    if (alto < bajo || !vale(alto)) return null;
    while (bajo < alto) {
      const medio = Math.floor((bajo + alto) / 2);
      if (vale(medio)) alto = medio;
      else bajo = medio + 1;
    }
    return bajo;
  };

  // Única: con el cuadro de verdad.
  const conUnica = (importe: number) =>
    cuadroConAportaciones(e, [...aportaciones, { despuesDe: desde, importe, modo: "PLAZO" }]);
  const importeUnico = minimo((x) => conUnica(x).filter((f) => f.periodo > desde).length <= meses);
  const unica =
    importeUnico === null
      ? null
      : { importe: importeUnico, ahorro: interesesBase - interesesDesde(conUnica(importeUnico), desde) };

  // Mensual: las mismas reglas que el motor con una aportación en PLAZO tras
  // cada cuota (en PLAZO la cuota no cambia, así que no hace falta rehacer el
  // cuadro entero cada mes). Si el extra ya cubre lo que queda, eso es
  // liquidar en ese mes.
  const conMensual = (extra: number): { cuotas: number; intereses: number } => {
    const x = BigInt(extra);
    let pend = estado.pendiente - x;
    let cuotas = 0;
    let intereses = BigInt(0);
    for (let k = desde + 1; ; k++) {
      const int = redondeo(pend * T, D);
      const ultima = k >= estado.fin || estado.cuota - int >= pend;
      pend -= ultima ? pend : estado.cuota - int;
      intereses += int;
      cuotas++;
      if (ultima || x >= pend) break;
      pend -= x;
    }
    return { cuotas, intereses: Number(intereses) };
  };
  const extra = minimo((x) => conMensual(x).cuotas <= meses);
  const mensual =
    extra === null
      ? null
      : { extra, pagoMes: Number(estado.cuota) + extra, ahorro: interesesBase - conMensual(extra).intereses };

  return { meses, mensual, unica };
}

/**
 * Lo que se tolera que la última cuota se aparte de las demás: el 10 % de la
 * cuota y, en cuotas pequeñas, hasta 1 €.
 */
const DESVIO_MINIMO = 100;

/**
 * La TAE (en %, con dos decimales) que iguala `netoCents` con el flujo de
 * cuotas. Espejo exacto de `public.loan_tae`. Null si no hay una TAE con
 * sentido (un tipo mensual por encima del 100 %).
 */
export function taeCalculada(cuotas: number[], netoCents: number): number | null {
  if (cuotas.length === 0 || netoCents <= 0) return null;
  const neto = netoCents;
  const valorActual = (r: number): number => {
    const v = 1 / (1 + r);
    let factor = 1;
    let suma = 0;
    for (const c of cuotas) {
      factor = factor * v;
      suma = suma + c * factor;
    }
    return suma - neto;
  };

  if (valorActual(0) <= 0) return 0;
  if (valorActual(1) > 0) return null;

  let bajo = 0;
  let alto = 1;
  for (let i = 0; i < 100; i++) {
    const medio = (bajo + alto) / 2;
    if (valorActual(medio) > 0) bajo = medio;
    else alto = medio;
  }
  const r = (bajo + alto) / 2;
  let anual = 1;
  for (let m = 0; m < 12; m++) anual = anual * (1 + r);
  return redondearComoPostgres((anual - 1) * 100);
}

/**
 * `round(x::numeric, 2)` de Postgres sobre un doble: primero `float8 → numeric`,
 * que escribe el doble con 15 cifras significativas (`%.15g`), y luego redondeo
 * a dos decimales con el empate lejos del cero. Se hace sobre el TEXTO, en
 * enteros, para no reintroducir el error de representación.
 */
function redondearComoPostgres(x: number): number {
  const [mantisa, exp = "0"] = x.toPrecision(15).split("e");
  const negativo = mantisa.startsWith("-");
  const [ent, frac = ""] = mantisa.replace("-", "").split(".");
  let digitos = ent + frac;
  let coma = ent.length + Number(exp); // posición de la coma dentro de `digitos`
  if (coma < 0) {
    digitos = "0".repeat(-coma) + digitos;
    coma = 0;
  }
  if (coma > digitos.length) digitos = digitos.padEnd(coma, "0");
  const conDos = digitos.padEnd(coma + 3, "0");
  let centesimas = BigInt(conDos.slice(0, coma + 2) || "0");
  if (Number(conDos[coma + 2]) >= 5) centesimas += BigInt(1);
  const valor = Number(centesimas) / 100;
  return negativo && valor !== 0 ? -valor : valor;
}

export type ResumenPrestamo = {
  cuadro: CuotaDelCuadro[];
  /** La cuota de todos los meses menos, quizá, el último. */
  cuota: number;
  /** La última cuota, que ajusta el redondeo. */
  ultimaCuota: number;
  interesesTotales: number;
  comision: number;
  /** Intereses + comisión de apertura: lo que cuesta el préstamo. */
  costeTotal: number;
  /** Todo lo que se paga en cuotas (principal + intereses). */
  totalCuotas: number;
  /** TAE calculada con la comisión (en %), o null. */
  tae: number | null;
  fechaFin: string;
};

/** La vista previa entera: cuota, intereses, coste y TAE. */
export function resumenPrestamo(e: EntradaCuadro & { comisionCents: number }): ResumenPrestamo {
  const cuadro = cuadroAmortizacion(e);
  const interesesTotales = cuadro.reduce((s, f) => s + f.intereses, 0);
  const totalCuotas = cuadro.reduce((s, f) => s + f.cuota, 0);
  return {
    cuadro,
    cuota: cuadro[0].cuota,
    ultimaCuota: cuadro[cuadro.length - 1].cuota,
    interesesTotales,
    comision: e.comisionCents,
    costeTotal: interesesTotales + e.comisionCents,
    totalCuotas,
    tae: taeCalculada(
      cuadro.map((f) => f.cuota),
      e.principalCents - e.comisionCents,
    ),
    fechaFin: cuadro[cuadro.length - 1].fecha,
  };
}

/**
 * La primera cuota por defecto: el día de cobro del MES SIGUIENTE al de inicio.
 * Inicio 13 de octubre, día 1 → 1 de noviembre; día 20 → 20 de noviembre.
 * Es lo que hace `create_loan` cuando no se le da fecha.
 */
export function primeraCuotaPorDefecto(inicio: string, diaCobro: number): string {
  const [anio, mes] = inicio.split("-").map(Number);
  const total = anio * 12 + mes; // mes siguiente, en base 0
  const destino = toIso(Math.floor(total / 12), (total % 12) + 1, 1);
  // El esquema limita el día a 28, pero la función se protege sola (H-17): un
  // día 31 en noviembre es el 30, nunca el «31 de noviembre».
  const dia = Math.min(Math.max(1, Math.trunc(diaCobro) || 1), daysInMonth(destino));
  return toIso(Math.floor(total / 12), (total % 12) + 1, dia);
}

/**
 * Para un préstamo que «ya estaba apuntado»: el primer periodo que generará la
 * app (el primero con fecha POSTERIOR al alta: lo de hasta hoy ya está en tus
 * cuentas) y el capital pendiente con el que arranca la deuda. Null si todas
 * las cuotas ya han pasado (el préstamo estaría pagado).
 */
export function arranqueYaApuntado(
  cuadro: CuotaDelCuadro[],
  alta: string,
): { primerPeriodo: number; pendiente: number } | null {
  const primera = cuadro.find((f) => f.fecha > alta);
  if (!primera) return null;
  const anterior = cuadro[primera.periodo - 2];
  return { primerPeriodo: primera.periodo, pendiente: anterior ? anterior.pendiente : cuadro[0].pendiente + cuadro[0].capital };
}

// ---------------------------------------------------------------------------
// Lo que devuelve la base, validado antes de dárselo a la interfaz: mejor un
// error que unos recuentos inventados (como parseAccountDeletePreview).
// ---------------------------------------------------------------------------

export type LoanDeletePreview = {
  name: string;
  status: string;
  /** Movimientos que se borran (los del préstamo y los que tocan su cuenta-pasivo). */
  transactions: number;
  /** Cuotas cobradas que desaparecen. */
  installments: number;
  /** Gasto (intereses y comisiones) que deja de contar. */
  expense_cents: number;
  /** Cuánto cambia el saldo de cada OTRA cuenta (positivo = sube). */
  balance_effects: { account_id: string; account_name: string; balance_delta_cents: number }[];
  /** Cuánto cambia el patrimonio (positivo = sube). */
  net_worth_delta_cents: number;
};

function entero(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error("no entero");
  return v;
}
function texto(v: unknown): string {
  if (typeof v !== "string") throw new Error("no texto");
  return v;
}
function objeto(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("no objeto");
  return v as Record<string, unknown>;
}

/** Valida el JSON de `loan_delete_preview`. Null si no tiene la forma esperada. */
export function parseLoanDeletePreview(raw: unknown): LoanDeletePreview | null {
  try {
    const p = objeto(raw);
    if (!Array.isArray(p.balance_effects)) return null;
    return {
      name: texto(p.name),
      status: texto(p.status),
      transactions: entero(p.transactions),
      installments: entero(p.installments),
      expense_cents: entero(p.expense_cents),
      balance_effects: p.balance_effects.map((x) => {
        const o = objeto(x);
        return {
          account_id: texto(o.account_id),
          account_name: texto(o.account_name),
          balance_delta_cents: entero(o.balance_delta_cents),
        };
      }),
      net_worth_delta_cents: entero(p.net_worth_delta_cents),
    };
  } catch {
    return null;
  }
}

export type LoanCreateResult = {
  loan_id: string;
  liability_account_id: string;
  first_charge_on: string;
  tracked_from_period: number;
  /** Cuotas ya vencidas que se generaron al crear. */
  generated: number;
};

/** Valida el JSON de `create_loan`. */
export function parseLoanCreateResult(raw: unknown): LoanCreateResult | null {
  try {
    const p = objeto(raw);
    return {
      loan_id: texto(p.loan_id),
      liability_account_id: texto(p.liability_account_id),
      first_charge_on: texto(p.first_charge_on),
      tracked_from_period: entero(p.tracked_from_period),
      generated: entero(p.generated),
    };
  } catch {
    return null;
  }
}

/**
 * Para el aviso push de una cuota cobrada: «Se ha cobrado la cuota 5 de Coche:
 * 193,33 €». Recibe el importe ya formateado (este módulo no importa nada).
 */
export function textoAvisoCuota(a: {
  nombre: string;
  desde: number;
  hasta: number;
  plazo: number;
  importe: string;
}): { title: string; body: string } {
  const cuantas = a.hasta - a.desde + 1;
  if (cuantas <= 1) {
    return {
      title: `Se ha cobrado la cuota de ${a.nombre}`,
      body: `Cuota ${a.hasta} de ${a.plazo}: ${a.importe}.`,
    };
  }
  return {
    title: `Se han cobrado ${cuantas} cuotas de ${a.nombre}`,
    body: `Cuotas ${a.desde} a ${a.hasta} de ${a.plazo}: ${a.importe} en total.`,
  };
}

// ---------------------------------------------------------------------------
// Fechas: las de dates.ts, que es el único reloj (H-07). Se reexportan con
// los nombres de siempre para quien ya los importa desde aquí.
// ---------------------------------------------------------------------------

/**
 * Hoy en MADRID (`YYYY-MM-DD`), que es el «hoy» con el que la base genera las
 * cuotas (`now() at time zone 'Europe/Madrid'`).
 */
export const hoyEnMadrid = hoyMadrid;

/** Una fecha ISO desplazada N meses, recortando al final del mes como Postgres. */
export const sumarMeses = shiftDateMonths;
