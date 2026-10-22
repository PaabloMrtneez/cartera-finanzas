/**
 * Participaciones de un fondo (o acciones) escritas por una persona, a decimal
 * EXACTO. Sin coma flotante.
 *
 * Módulo NEUTRAL a propósito (ni "use client" ni "use server", y sin imports):
 * lo usan el esquema Zod de las server actions y, cuando llegue la interfaz, la
 * vista previa del formulario. Lo que se enseña es lo que se guarda.
 *
 * ── POR QUÉ TEXTO Y NO NÚMERO ──────────────────────────────────────────────
 *
 * Las participaciones viajan hasta Postgres como TEXTO decimal («123.456789»)
 * y allí se guardan en `numeric(24,8)`. Nunca pasan por un `number`:
 * `Number("123,456789")` es NaN, `parseFloat("1.234,5")` da 1.234, y un doble no
 * representa 0,1 exacto. Aquí solo se valida y se normaliza la cadena.
 *
 * ── LA COMA, EL PUNTO Y LA AMBIGÜEDAD ──────────────────────────────────────
 *
 * MyInvestor (y cualquier web en español) escribe «1.234,567891»: punto de
 * millares y coma decimal. Una web en inglés, «1,234.567891». Las reglas:
 *
 *   · Con los dos separadores, el ÚLTIMO es el decimal y el otro tiene que ser
 *     de millares bien puesto (grupos de tres).
 *   · Solo comas: una coma es el decimal. Varias, ambiguo.
 *   · Solo puntos: varios son millares («1.234.567»). Uno solo es el decimal…
 *     salvo si delante hay de una a tres cifras y detrás EXACTAMENTE tres
 *     («1.234»): en español eso es
 *     mil doscientos treinta y cuatro y en inglés uno coma dos tres cuatro. Una
 *     diferencia de mil veces en el patrimonio no se adivina: se pide que se
 *     escriba con coma decimal.
 *
 * Igual que con los importes, la regla es no inventar nunca una cifra.
 */

/** La precisión de la columna `numeric(24,8)`. */
export const MAX_DECIMALES_PARTICIPACIONES = 8;
/** 24 cifras en total menos 8 decimales. */
const MAX_ENTEROS = 16;

export type LecturaParticipaciones =
  | { ok: true; valor: string }
  | { ok: false; error: string };

const ERROR_FORMATO = "Escribe las participaciones con números, por ejemplo 123,456789";

/**
 * Lee las participaciones que escribe una persona. Devuelve el decimal
 * normalizado con punto y sin ceros sobrantes («0123,4500» → «123.45»).
 *
 * `permitirCero`: un ajuste puede dejar la posición a cero (lo has vendido
 * todo); un alta o una aportación, no.
 */
export function parseParticipaciones(
  input: string,
  { permitirCero = false }: { permitirCero?: boolean } = {},
): LecturaParticipaciones {
  if (typeof input !== "string") return { ok: false, error: ERROR_FORMATO };

  // Espacios normales, duros y finos: a veces separan los millares.
  const limpio = input.replace(/[\s  ]/g, "");
  if (limpio === "") return { ok: false, error: "Escribe las participaciones" };
  if (/^[-−]/.test(limpio)) {
    return { ok: false, error: "Las participaciones no pueden ser negativas" };
  }
  if (!/^\d[\d.,]*$|^[.,]\d+$/.test(limpio)) return { ok: false, error: ERROR_FORMATO };

  const comas = (limpio.match(/,/g) ?? []).length;
  const puntos = (limpio.match(/\./g) ?? []).length;

  let entero: string;
  let fraccion = "";

  if (comas > 0 && puntos > 0) {
    const decimal = limpio.lastIndexOf(",") > limpio.lastIndexOf(".") ? "," : ".";
    const millares = decimal === "," ? "." : ",";
    const partes = limpio.split(decimal);
    if (partes.length !== 2) return { ok: false, error: ERROR_FORMATO };
    const [conMillares, frac] = partes;
    if (frac.includes(millares)) return { ok: false, error: ERROR_FORMATO };
    const grupos = conMillares.split(millares);
    if (!/^\d{1,3}$/.test(grupos[0]) || grupos.slice(1).some((g) => !/^\d{3}$/.test(g))) {
      return { ok: false, error: ERROR_FORMATO };
    }
    entero = grupos.join("");
    fraccion = frac;
  } else if (comas > 0) {
    if (comas > 1) {
      return { ok: false, error: "Usa la coma solo para los decimales, por ejemplo 1234,56" };
    }
    [entero, fraccion] = limpio.split(",");
  } else if (puntos > 1) {
    const grupos = limpio.split(".");
    if (!/^\d{1,3}$/.test(grupos[0]) || grupos.slice(1).some((g) => !/^\d{3}$/.test(g))) {
      return { ok: false, error: ERROR_FORMATO };
    }
    entero = grupos.join("");
  } else if (puntos === 1) {
    [entero, fraccion] = limpio.split(".");
    // «1.234» es ambiguo; «1234.567» no (con millares serían «1.234.567»), ni
    // «0.123» (nadie escribe un millar empezando por cero).
    if (/^\d{3}$/.test(fraccion) && /^\d{1,3}$/.test(entero) && /[1-9]/.test(entero)) {
      return {
        ok: false,
        error: `«${input.trim()}» puede ser ${entero}${fraccion} o ${entero},${fraccion}. Escribe los decimales con coma.`,
      };
    }
  } else {
    entero = limpio;
  }

  if (!/^\d*$/.test(entero) || !/^\d*$/.test(fraccion)) return { ok: false, error: ERROR_FORMATO };
  if (entero === "" && fraccion === "") return { ok: false, error: ERROR_FORMATO };

  entero = entero.replace(/^0+(?=\d)/, "") || "0";
  fraccion = fraccion.replace(/0+$/, "");

  if (fraccion.length > MAX_DECIMALES_PARTICIPACIONES) {
    return {
      ok: false,
      error: `Como mucho ${MAX_DECIMALES_PARTICIPACIONES} decimales`,
    };
  }
  if (entero.length > MAX_ENTEROS) return { ok: false, error: "Demasiadas participaciones" };

  const esCero = entero === "0" && fraccion === "";
  if (esCero && !permitirCero) {
    return { ok: false, error: "Las participaciones tienen que ser más que cero" };
  }

  return { ok: true, valor: fraccion ? `${entero}.${fraccion}` : entero };
}

/**
 * ¿Es un ISIN válido? Dos letras de país, nueve alfanuméricos y un dígito de
 * control que se comprueba (Luhn sobre las letras pasadas a número, A=10…Z=35).
 * Atrapa un dígito mal copiado antes de guardarlo en el catálogo.
 */
export function isinValido(input: string): boolean {
  if (typeof input !== "string") return false;
  const isin = input.trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false;

  const digitos = isin
    .split("")
    .map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c))
    .join("");

  let suma = 0;
  let doblar = false;
  for (let i = digitos.length - 1; i >= 0; i--) {
    let d = digitos.charCodeAt(i) - 48;
    if (doblar) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    suma += d;
    doblar = !doblar;
  }
  return suma % 10 === 0;
}
