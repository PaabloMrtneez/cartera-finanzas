/**
 * De dónde salen los precios: Yahoo Finance (cierres diarios de fondos, ETF y
 * acciones) y el Banco Central Europeo (tipos de cambio de referencia).
 *
 * Módulo de SERVIDOR: lo usan la ruta /api/precios y las server actions de
 * Inversiones. No lleva `import "server-only"` porque el proyecto no tiene ese
 * paquete y aquí no hay nada secreto (son APIs públicas sin clave); lo que sí
 * importa es que no se importe desde un componente de cliente, y no se hace.
 *
 * Solo importa `../dates.ts` (el único reloj de la app), CON la extensión y
 * sin nada más detrás (dates.ts solo importa tipos), a propósito: así
 * `scripts/probar-precios-reales.mjs` lo carga tal cual con Node (que quita los
 * tipos) y prueba contra Yahoo y el BCE de verdad ESTE código, no una copia.
 *
 * ── NI UN FLOAT LLEGA A LA BASE ────────────────────────────────────────────
 *
 * Yahoo da los cierres como números JSON en coma flotante
 * (14.659199714660645). Se convierten AQUÍ, una sola vez, a un decimal en texto
 * (el más corto que representa el dato, con 6 decimales como mucho: «14.6592»;
 * ver `aDecimal`), y es ese texto el que viaja a Postgres, que lo
 * guarda en `numeric` exacto. El BCE ya da el cambio como texto decimal
 * («1.1269») y no se toca. Ninguna cifra de dinero se calcula en JavaScript:
 * participaciones × precio × cambio se multiplica en la base.
 *
 * ── LO QUE PUEDE FALLAR ────────────────────────────────────────────────────
 *
 * Todo error sale como `ErrorPrecios` con un código (NO_ENCONTRADO, HTTP,
 * TIEMPO, RED, FORMATO…), para que quien llama decida: la ruta programada
 * apunta el fallo de ese símbolo y sigue con los demás; la acción de seguir un
 * instrumento se lo explica a la persona. Nunca se inventa un precio: un
 * `close` a null (el último día de un fondo suele venir así) se ignora.
 */

import { addDays, hoyMadrid } from "../dates.ts";

// ---------------------------------------------------------------------------
// Tipos y errores
// ---------------------------------------------------------------------------

export type TipoInstrumento = "FONDO" | "ETF" | "ACCION";

export type CodigoErrorPrecios =
  | "SIMBOLO_NO_VALIDO"
  | "NO_ENCONTRADO"
  | "HTTP"
  | "TIEMPO"
  | "RED"
  | "FORMATO";

export class ErrorPrecios extends Error {
  readonly codigo: CodigoErrorPrecios;
  /** El código HTTP, si la fuente respondió con uno de error. */
  readonly estado: number | undefined;

  constructor(codigo: CodigoErrorPrecios, mensaje: string, estado?: number) {
    super(mensaje);
    this.name = "ErrorPrecios";
    this.codigo = codigo;
    this.estado = estado;
  }
}

/**
 * ¿Merece la pena reintentar? Un 429 (demasiadas peticiones: todos los
 * símbolos salen de la misma IP) o un 5xx de la fuente suelen pasarse en
 * segundos. Un símbolo que no existe o un JSON roto, no.
 */
export function esReintentable(e: unknown): boolean {
  return e instanceof ErrorPrecios && e.codigo === "HTTP" && e.estado !== undefined && (e.estado === 429 || e.estado >= 500);
}

/**
 * Las divisas de las que el BCE publica cambio de referencia (H-19). Una de
 * tres letras que no está aquí («XYZ», o una que el BCE dejó de publicar)
 * dejaría la posición sin valor en euros y sin explicación: se rechaza al dar
 * de alta el instrumento.
 */
export const DIVISAS_BCE: ReadonlySet<string> = new Set([
  "EUR", "USD", "JPY", "CZK", "DKK", "GBP", "HUF", "PLN", "RON", "SEK", "CHF",
  "ISK", "NOK", "TRY", "AUD", "BRL", "CAD", "CNY", "HKD", "IDR", "ILS", "INR",
  "KRW", "MXN", "MYR", "NZD", "PHP", "SGD", "THB", "ZAR",
]);

/** Un cierre diario: la fecha del mercado y el precio como decimal exacto. */
export type PrecioDiario = { fecha: string; cierre: string };

export type Cotizacion = {
  simbolo: string;
  nombre: string;
  /** null si Yahoo dice que es otra cosa (índice, divisa, futuro…). */
  tipo: TipoInstrumento | null;
  /** Divisa del precio, ya normalizada (GBp → GBP dividiendo entre 100). */
  divisa: string;
  mercado: string | null;
  /** Ordenados por fecha, sin huecos a null y sin fechas repetidas. */
  precios: PrecioDiario[];
};

export type Candidato = {
  simbolo: string;
  nombre: string;
  tipo: TipoInstrumento;
  divisa: string;
  mercado: string | null;
  ultimoPrecio: string | null;
  fechaUltimoPrecio: string | null;
};

/** Un tipo de cambio del BCE: unidades de la divisa por 1 EUR. */
export type TipoDeCambio = { fecha: string; tasa: string };

export type OpcionesRed = {
  /** Para las pruebas: un fetch simulado. Por defecto, el global. */
  fetch?: typeof fetch;
  /** Tiempo máximo por petición. */
  timeoutMs?: number;
  /**
   * Corte de quien llama, además del plazo de cada petición: la ruta
   * programada lo usa como presupuesto total, para no pasarse de sus 60 s.
   */
  signal?: AbortSignal;
};

const TIMEOUT_POR_DEFECTO = 8000;

/** Yahoo rechaza las peticiones sin un User-Agent de navegador. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** El mismo formato que el CHECK de `instrument.yahoo_symbol`. */
export const SIMBOLO_VALIDO = /^[A-Za-z0-9.^=-]{1,32}$/;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Conversión de números y fechas
// ---------------------------------------------------------------------------

/** Lo más grande que cabe en `numeric(20,6)`: 14 cifras enteras. */
const MAX_PRECIO = 1e14;

/** Decimales con los que se guarda un precio (`numeric(20,6)`). */
const DECIMALES_PRECIO = 6;

/**
 * El decimal más corto que representa `x`.
 *
 * Yahoo guarda los precios en coma flotante de 32 bits y los sirve como dobles:
 * el 306,64 publicado llega como 306.6400146484375 y el 14,6592 como
 * 14.659199714660645. Redondear eso a 6 decimales daría «306.640015», ruido
 * que no ha publicado nadie. Así que, si el número ES un float32
 * (`Math.fround(x) === x`), se busca el decimal con menos cifras significativas
 * que vuelve al mismo float32: «306.64», «14.6592». Es lo mismo que hace
 * JavaScript al imprimir un doble, pero con la precisión con la que Yahoo
 * guardó el dato, y recupera exactamente la cifra publicada siempre que tuviera
 * hasta 7 cifras significativas (las que caben en un float32). Si no es un
 * float32, el decimal más corto del doble (`String(x)`).
 */
function decimalMasCorto(x: number): string {
  let s = String(x);
  if (Math.fround(x) === x) {
    for (let p = 1; p <= 9; p++) {
      const candidato = x.toPrecision(p);
      if (Math.fround(Number(candidato)) === x) {
        s = candidato;
        break;
      }
    }
  }
  // toPrecision/String pueden dar notación exponencial («1.2e+6»).
  return /e/i.test(s) ? Number(s).toFixed(10) : s;
}

/**
 * Redondea un decimal en texto a `decimales` cifras, con el empate hacia arriba
 * (como `round()` de Postgres sobre numeric positivo), en enteros: sin pasar por
 * coma flotante. Quita los ceros sobrantes.
 */
function redondearDecimal(texto: string, decimales: number): string {
  const [entero, fraccion = ""] = texto.split(".");
  let digitos = BigInt(entero + fraccion.slice(0, decimales).padEnd(decimales, "0"));
  if ((fraccion.charCodeAt(decimales) || 48) - 48 >= 5) digitos += BigInt(1);
  const crudo = digitos.toString().padStart(decimales + 1, "0");
  const parteEntera = crudo.slice(0, crudo.length - decimales);
  const parteDecimal = crudo.slice(crudo.length - decimales).replace(/0+$/, "");
  return parteDecimal ? `${parteEntera}.${parteDecimal}` : parteEntera;
}

/** Divide entre 100 un decimal en texto, moviendo la coma: exacto. */
function entre100(texto: string): string {
  const [entero, fraccion = ""] = texto.split(".");
  const relleno = entero.padStart(3, "0");
  const nuevoEntero = relleno.slice(0, -2).replace(/^0+(?=\d)/, "");
  return `${nuevoEntero}.${relleno.slice(-2)}${fraccion}`;
}

/**
 * Un precio de Yahoo (coma flotante) a decimal exacto en texto: el decimal más
 * corto que lo representa (ver `decimalMasCorto`), dividido entre 100 si cotiza
 * en peniques o similar (moviendo la coma, sin dividir floats), y redondeado a
 * 6 decimales con el empate hacia arriba. Devuelve null si no es un precio
 * válido (null, NaN, ≤ 0, demasiado grande, o cero tras redondear).
 */
export function aDecimal(x: unknown, divisor: 1 | 100 = 1): string | null {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x >= MAX_PRECIO) return null;
  const corto = decimalMasCorto(x);
  const resultado = redondearDecimal(divisor === 100 ? entre100(corto) : corto, DECIMALES_PRECIO);
  return /^0(\.0*)?$/.test(resultado) ? null : resultado;
}

/**
 * Unas pocas bolsas cotizan en la fracción de su moneda: Londres en peniques
 * («GBp»/«GBX»), Johannesburgo en céntimos de rand, Tel Aviv en agorot. El BCE
 * da el cambio de la moneda entera, así que se guarda en la moneda entera y el
 * precio dividido entre 100.
 */
const SUBDIVISIONES: Record<string, string> = { GBp: "GBP", GBX: "GBP", ZAc: "ZAR", ILA: "ILS" };

/**
 * La fecha de mercado de una vela de Yahoo: el día en la zona horaria de la
 * bolsa. En UTC, una vela de un fondo alemán a las 00:00 de Fráncfort caería en
 * el día anterior. Se usa el nombre de la zona (que sabe de horario de verano);
 * si no se entiende, el desfase que da Yahoo.
 */
export function fechaEnZona(segundos: number, zona?: string, gmtoffset?: number): string | null {
  if (!Number.isFinite(segundos)) return null;
  const instante = new Date(segundos * 1000);
  if (zona) {
    try {
      const partes = new Intl.DateTimeFormat("en-CA", {
        timeZone: zona,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(instante);
      const v = (t: string) => partes.find((p) => p.type === t)?.value;
      const iso = `${v("year")}-${v("month")}-${v("day")}`;
      if (ISO.test(iso)) return iso;
    } catch {
      // Zona desconocida: se cae al desfase.
    }
  }
  const desfase = Number.isFinite(gmtoffset) ? (gmtoffset as number) : 0;
  return new Date((segundos + desfase) * 1000).toISOString().slice(0, 10);
}

function segundosUtc(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
}

// ---------------------------------------------------------------------------
// Red
// ---------------------------------------------------------------------------

async function pedir(url: string, opciones: OpcionesRed, acepta: string): Promise<Response> {
  const f = opciones.fetch ?? fetch;
  try {
    return await f(url, {
      headers: { "User-Agent": USER_AGENT, Accept: acepta },
      cache: "no-store",
      signal: opciones.signal
        ? AbortSignal.any([AbortSignal.timeout(opciones.timeoutMs ?? TIMEOUT_POR_DEFECTO), opciones.signal])
        : AbortSignal.timeout(opciones.timeoutMs ?? TIMEOUT_POR_DEFECTO),
    });
  } catch (e) {
    const nombre = (e as { name?: string })?.name;
    if (nombre === "TimeoutError" || nombre === "AbortError") {
      throw new ErrorPrecios("TIEMPO", "La fuente de precios no ha respondido a tiempo");
    }
    throw new ErrorPrecios("RED", "No se ha podido conectar con la fuente de precios");
  }
}

async function leerJson(respuesta: Response): Promise<unknown> {
  try {
    return await respuesta.json();
  } catch {
    throw new ErrorPrecios("FORMATO", "La fuente de precios ha devuelto algo que no se entiende");
  }
}

// ---------------------------------------------------------------------------
// Yahoo · histórico diario de un símbolo
// ---------------------------------------------------------------------------

type MetaYahoo = {
  currency?: unknown;
  symbol?: unknown;
  exchangeName?: unknown;
  fullExchangeName?: unknown;
  instrumentType?: unknown;
  longName?: unknown;
  shortName?: unknown;
  exchangeTimezoneName?: unknown;
  gmtoffset?: unknown;
};

const TIPOS_YAHOO: Record<string, TipoInstrumento> = {
  MUTUALFUND: "FONDO",
  ETF: "ETF",
  EQUITY: "ACCION",
};

const texto = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/**
 * Los cierres diarios de `simbolo` desde `desde` (incluido) hasta `hasta` o
 * hoy. Para dar de alta una posición se pide desde unos días antes de su fecha;
 * para la actualización diaria, los últimos días (`descargarUltimos`).
 *
 * Con un símbolo que no existe, NO_ENCONTRADO. Con un rango sin cotizaciones
 * (un fin de semana, un fondo recién lanzado), una cotización sin precios: no
 * es un error, es que no hay.
 */
export async function descargarHistorico(
  simbolo: string,
  desde: string,
  opciones: OpcionesRed & { hasta?: string } = {},
): Promise<Cotizacion> {
  if (typeof simbolo !== "string" || !SIMBOLO_VALIDO.test(simbolo)) {
    throw new ErrorPrecios("SIMBOLO_NO_VALIDO", "Ese símbolo no es válido");
  }
  if (!ISO.test(desde) || (opciones.hasta !== undefined && !ISO.test(opciones.hasta))) {
    throw new ErrorPrecios("FORMATO", "Fecha no válida");
  }

  // Un día de margen por delante: una bolsa asiática abre cuando en UTC aún es
  // el día anterior. Lo que sobre se filtra después por la fecha de mercado.
  const p1 = segundosUtc(addDays(desde, -1));
  const p2 = opciones.hasta
    ? segundosUtc(opciones.hasta) + 2 * 86400
    : Math.floor(Date.now() / 1000) + 86400;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}` +
    `?period1=${p1}&period2=${p2}&interval=1d&events=history`;

  const respuesta = await pedir(url, opciones, "application/json");
  if (respuesta.status === 404) {
    throw new ErrorPrecios("NO_ENCONTRADO", `Yahoo no conoce el símbolo ${simbolo}`);
  }
  if (!respuesta.ok) {
    throw new ErrorPrecios("HTTP", `Yahoo ha respondido ${respuesta.status}`, respuesta.status);
  }

  const cuerpo = (await leerJson(respuesta)) as {
    chart?: { result?: unknown; error?: { code?: unknown; description?: unknown } | null };
  };
  const chart = cuerpo?.chart;
  if (!chart || typeof chart !== "object") {
    throw new ErrorPrecios("FORMATO", "Respuesta de Yahoo sin gráfico");
  }
  if (chart.error) {
    if (chart.error.code === "Not Found") {
      throw new ErrorPrecios("NO_ENCONTRADO", `Yahoo no conoce el símbolo ${simbolo}`);
    }
    throw new ErrorPrecios("HTTP", `Yahoo ha respondido con un error: ${String(chart.error.code ?? "")}`);
  }
  const resultado = Array.isArray(chart.result) ? chart.result[0] : null;
  if (!resultado || typeof resultado !== "object") {
    throw new ErrorPrecios("NO_ENCONTRADO", `Yahoo no tiene datos de ${simbolo}`);
  }

  const r = resultado as {
    meta?: MetaYahoo;
    timestamp?: unknown;
    indicators?: { quote?: Array<{ close?: unknown }> };
  };
  const meta: MetaYahoo = r.meta ?? {};

  const divisaYahoo = texto(meta.currency);
  if (!divisaYahoo) throw new ErrorPrecios("FORMATO", `Yahoo no dice en qué divisa cotiza ${simbolo}`);
  const divisa = SUBDIVISIONES[divisaYahoo] ?? divisaYahoo.toUpperCase();
  const entre = SUBDIVISIONES[divisaYahoo] ? 100 : 1;
  if (!/^[A-Z]{3}$/.test(divisa) || !DIVISAS_BCE.has(divisa)) {
    throw new ErrorPrecios("FORMATO", `Divisa desconocida o sin cambio del BCE: ${divisaYahoo}`);
  }

  const tiempos = Array.isArray(r.timestamp) ? r.timestamp : [];
  const cierres = Array.isArray(r.indicators?.quote?.[0]?.close)
    ? (r.indicators?.quote?.[0]?.close as unknown[])
    : [];
  const zona = texto(meta.exchangeTimezoneName) ?? undefined;
  const desfase = typeof meta.gmtoffset === "number" ? meta.gmtoffset : undefined;
  const limite = opciones.hasta ?? "9999-12-31";

  // Por fecha, el último que llegue: el día en curso de una acción puede venir
  // dos veces (la vela del día y el precio del momento).
  const porFecha = new Map<string, string>();
  for (let i = 0; i < tiempos.length; i++) {
    const t = tiempos[i];
    if (typeof t !== "number") continue;
    // Un cierre a null (el último día de un fondo, a menudo) no es un precio.
    const bruto = cierres[i];
    if (typeof bruto !== "number") continue;
    const cierre = aDecimal(bruto, entre);
    if (cierre === null) continue;
    const fecha = fechaEnZona(t, zona, desfase);
    if (!fecha || fecha < desde || fecha > limite) continue;
    porFecha.set(fecha, cierre);
  }

  const precios = [...porFecha.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([fecha, cierre]) => ({ fecha, cierre }));

  return {
    simbolo: texto(meta.symbol) ?? simbolo,
    nombre: texto(meta.longName) ?? texto(meta.shortName) ?? simbolo,
    tipo: TIPOS_YAHOO[texto(meta.instrumentType) ?? ""] ?? null,
    divisa,
    mercado: texto(meta.fullExchangeName) ?? texto(meta.exchangeName),
    precios,
  };
}

/** Los cierres de los últimos `dias` días naturales (para la actualización diaria). */
export function descargarUltimos(
  simbolo: string,
  dias = 10,
  opciones: OpcionesRed = {},
): Promise<Cotizacion> {
  return descargarHistorico(simbolo, addDays(hoyMadrid(), -dias), opciones);
}

// ---------------------------------------------------------------------------
// Yahoo · búsqueda de candidatos
// ---------------------------------------------------------------------------

/**
 * Busca instrumentos por ISIN, por nombre o por símbolo, y devuelve cada
 * candidato con su divisa, su último precio y la FECHA de ese precio: un fondo
 * tiene varias clases (LC, LD, FC, USD…) con precios distintos y el nombre no
 * siempre basta para elegir; el precio y la divisa, sí.
 *
 * La búsqueda de Yahoo no da ni precio ni divisa, así que se pide el gráfico de
 * los últimos días de cada candidato (en paralelo). Los que no son fondos, ETF
 * ni acciones (índices, futuros, divisas) se descartan, y también los que
 * fallan al pedir el gráfico. Si se ha escrito un símbolo exacto que la
 * búsqueda no devuelve (pasa con algunos fondos), se prueba directamente.
 *
 * Ojo: la búsqueda por ISIN de Yahoo no siempre encuentra el fondo (no
 * encuentra el DWS Gold LC por LU0273159177, por nombre sí). Quien llama
 * debería sugerir buscar por nombre si no sale nada.
 */
export async function buscarCandidatos(
  consulta: string,
  opciones: OpcionesRed & { max?: number } = {},
): Promise<Candidato[]> {
  const q = typeof consulta === "string" ? consulta.trim() : "";
  if (q.length < 2 || q.length > 80) return [];
  const max = Math.min(Math.max(opciones.max ?? 8, 1), 10);

  const url =
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}` +
    `&quotesCount=${max * 2}&newsCount=0&listsCount=0`;
  const respuesta = await pedir(url, opciones, "application/json");
  if (!respuesta.ok) throw new ErrorPrecios("HTTP", `La búsqueda de Yahoo ha respondido ${respuesta.status}`, respuesta.status);
  const cuerpo = (await leerJson(respuesta)) as { quotes?: unknown };
  const quotes = Array.isArray(cuerpo?.quotes) ? cuerpo.quotes : [];

  type Encontrado = { simbolo: string; nombre: string | null; tipo: TipoInstrumento; mercado: string | null };
  const encontrados: Encontrado[] = [];
  const vistos = new Set<string>();
  for (const bruto of quotes) {
    const quote = bruto as Record<string, unknown>;
    const simbolo = texto(quote?.symbol);
    const tipo = TIPOS_YAHOO[texto(quote?.quoteType) ?? ""];
    if (!simbolo || !tipo || !SIMBOLO_VALIDO.test(simbolo) || vistos.has(simbolo)) continue;
    vistos.add(simbolo);
    encontrados.push({
      simbolo,
      nombre: texto(quote.longname) ?? texto(quote.shortname),
      tipo,
      mercado: texto(quote.exchDisp),
    });
    if (encontrados.length >= max) break;
  }

  // ¿Han escrito un símbolo que la búsqueda no ha devuelto? Se prueba tal cual.
  const pareceSimbolo = SIMBOLO_VALIDO.test(q) && !vistos.has(q) && ![...vistos].some((s) => s.toUpperCase() === q.toUpperCase());

  const cotizaciones = await Promise.allSettled(
    encontrados.map((e) => descargarUltimos(e.simbolo, 10, opciones)),
  );
  const candidatos: Candidato[] = [];
  encontrados.forEach((e, i) => {
    const c = cotizaciones[i];
    if (c.status !== "fulfilled") return;
    const ultimo = c.value.precios[c.value.precios.length - 1] ?? null;
    candidatos.push({
      simbolo: e.simbolo,
      nombre: e.nombre ?? c.value.nombre,
      tipo: e.tipo,
      divisa: c.value.divisa,
      mercado: e.mercado ?? c.value.mercado,
      ultimoPrecio: ultimo?.cierre ?? null,
      fechaUltimoPrecio: ultimo?.fecha ?? null,
    });
  });

  if (pareceSimbolo) {
    try {
      const directo = await descargarUltimos(q, 10, opciones);
      if (directo.tipo) {
        const ultimo = directo.precios[directo.precios.length - 1] ?? null;
        candidatos.unshift({
          simbolo: directo.simbolo,
          nombre: directo.nombre,
          tipo: directo.tipo,
          divisa: directo.divisa,
          mercado: directo.mercado,
          ultimoPrecio: ultimo?.cierre ?? null,
          fechaUltimoPrecio: ultimo?.fecha ?? null,
        });
      }
    } catch {
      // No era un símbolo: con los resultados de la búsqueda basta.
    }
  }

  return candidatos;
}

// ---------------------------------------------------------------------------
// BCE · tipos de cambio de referencia
// ---------------------------------------------------------------------------

/** Parte una línea CSV respetando las comillas (el BCE mete comas en los títulos). */
function camposCsv(linea: string): string[] {
  const campos: string[] = [];
  let actual = "";
  let entreComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (entreComillas) {
      if (c === '"' && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (c === '"') {
        entreComillas = false;
      } else {
        actual += c;
      }
    } else if (c === '"') {
      entreComillas = true;
    } else if (c === ",") {
      campos.push(actual);
      actual = "";
    } else {
      actual += c;
    }
  }
  campos.push(actual);
  return campos;
}

/**
 * Los tipos de referencia diarios del BCE para `divisa` desde `desde`:
 * unidades de la divisa por 1 EUR (USD 1.1269), como texto decimal exacto.
 *
 * El BCE responde 404 cuando no hay observaciones en el rango (un fin de
 * semana, un festivo) y también cuando no conoce la divisa: en los dos casos se
 * devuelve una lista vacía y quien llama decide. Para validar una divisa nueva,
 * pide un rango de al menos una semana.
 */
export async function descargarTiposDeCambio(
  divisa: string,
  desde: string,
  opciones: OpcionesRed = {},
): Promise<TipoDeCambio[]> {
  if (!/^[A-Z]{3}$/.test(divisa) || divisa === "EUR") {
    throw new ErrorPrecios("FORMATO", `Divisa no válida para el BCE: ${divisa}`);
  }
  if (!ISO.test(desde)) throw new ErrorPrecios("FORMATO", "Fecha no válida");

  const url =
    `https://data-api.ecb.europa.eu/service/data/EXR/D.${divisa}.EUR.SP00.A` +
    `?startPeriod=${desde}&format=csvdata`;
  const respuesta = await pedir(url, opciones, "text/csv");
  if (respuesta.status === 404) return [];
  if (!respuesta.ok) throw new ErrorPrecios("HTTP", `El BCE ha respondido ${respuesta.status}`, respuesta.status);

  let cuerpo: string;
  try {
    cuerpo = await respuesta.text();
  } catch {
    throw new ErrorPrecios("FORMATO", "El BCE ha devuelto algo que no se entiende");
  }

  const lineas = cuerpo.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lineas.length === 0) return [];
  const cabecera = camposCsv(lineas[0]).map((c) => c.trim());
  const iFecha = cabecera.indexOf("TIME_PERIOD");
  const iValor = cabecera.indexOf("OBS_VALUE");
  if (iFecha === -1 || iValor === -1) {
    throw new ErrorPrecios("FORMATO", "El CSV del BCE no trae TIME_PERIOD y OBS_VALUE");
  }

  const porFecha = new Map<string, string>();
  for (const linea of lineas.slice(1)) {
    const campos = camposCsv(linea);
    const fecha = campos[iFecha]?.trim();
    const valor = campos[iValor]?.trim();
    if (!fecha || !ISO.test(fecha) || !valor) continue;
    // Texto decimal tal cual, sin pasar por un número. El BCE publica como
    // mucho 6 decimales; la columna admite 8.
    const m = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(valor);
    if (!m) continue;
    const decimales = (m[2] ?? "").replace(/0+$/, "");
    const tasa = decimales ? `${m[1]}.${decimales}` : m[1];
    if (/^0+(\.0*)?$/.test(tasa)) continue;
    porFecha.set(fecha, tasa);
  }

  return [...porFecha.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([fecha, tasa]) => ({ fecha, tasa }));
}
