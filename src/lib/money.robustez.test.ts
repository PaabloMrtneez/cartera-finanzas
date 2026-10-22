import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatCents, formatCentsPlain, formatCentsRounded, parseAmountToCents } from "./money";

/**
 * Pruebas de PROPIEDADES de `parseAmountToCents` y del formateo (fase 1 del
 * cierre de la v1: robustez). Semilla fija: si algo falla, falla siempre igual
 * y el contraejemplo se puede reproducir.
 *
 * Las que llevan `it.fails` documentan un fallo REAL encontrado y aún sin
 * arreglar (ver docs/pruebas/informe-robustez.md). Cuando se arregle, Vitest
 * avisará de que «ya pasa» y habrá que quitarles el `.fails`.
 */

const SEMILLA = { seed: 20261019, numRuns: 2000 };

/** Céntimos de cualquier signo, hasta mil millones de euros (el tope de la base). */
const centimos = fc.integer({ min: -100_000_000_000, max: 100_000_000_000 });

/** Agrupa los millares con `sep`: 1234567 → "1.234.567". */
function agrupar(entero: string, sep: string): string {
  return entero.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

describe("parseAmountToCents · ida y vuelta con el formateo", () => {
  it("formatCentsPlain → parse devuelve los mismos céntimos", () => {
    fc.assert(
      fc.property(centimos, (c) => {
        expect(parseAmountToCents(formatCentsPlain(c))).toBe(c === 0 ? 0 : c);
      }),
      SEMILLA,
    );
  });

  it("formatCents (con € y espacio duro) → parse devuelve los mismos céntimos", () => {
    fc.assert(
      fc.property(centimos, (c) => {
        const vuelta = parseAmountToCents(formatCents(c));
        expect(vuelta === 0 ? 0 : vuelta).toBe(c);
      }),
      SEMILLA,
    );
  });

  it("cualquier convención de separadores (es-ES, en-US, suiza, francesa) da el mismo importe", () => {
    const convenciones: Array<[string, string]> = [
      [".", ","], // es-ES: 1.234,56
      [",", "."], // en-US: 1,234.56
      ["'", "."], // CH: 1'234.56
      [" ", ","], // FR con espacio duro: 1 234,56
      ["", ","], // sin millares: 1234,56
      ["", "."], // sin millares: 1234.56
    ];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), fc.constantFrom(...convenciones), (c, [mil, dec]) => {
        const entero = String(Math.floor(c / 100));
        const frac = String(c % 100).padStart(2, "0");
        const texto = `${agrupar(entero, mil)}${dec}${frac}`;
        expect(parseAmountToCents(texto)).toBe(c);
      }),
      SEMILLA,
    );
  });

  it("un decimal de una cifra son decenas de céntimo: «1.234,5» → 123450", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_999 }), fc.integer({ min: 0, max: 9 }), (e, d) => {
        expect(parseAmountToCents(`${agrupar(String(e), ".")},${d}`)).toBe(e * 100 + d * 10);
      }),
      SEMILLA,
    );
  });

  it("espacios alrededor, el menos tipográfico y el símbolo no cambian la magnitud", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.constantFrom("", " ", "  ", "\t", " "),
        fc.constantFrom("-", "−"),
        (c, esp, menos) => {
          const plano = formatCentsPlain(c);
          expect(parseAmountToCents(`${esp}${plano}${esp}`)).toBe(c);
          expect(parseAmountToCents(`${esp}${menos}${plano} €${esp}`)).toBe(-c);
        },
      ),
      SEMILLA,
    );
  });
});

describe("parseAmountToCents · nunca revienta ni devuelve un no-entero", () => {
  it("con texto arbitrario (unicode incluido) devuelve null o un entero seguro", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 60 }), (texto) => {
        const r = parseAmountToCents(texto);
        expect(r === null || Number.isSafeInteger(r)).toBe(true);
      }),
      { ...SEMILLA, numRuns: 5000 },
    );
  });

  it("con cadenas de 10 000 caracteres no se cuelga y no inventa importes gigantes", () => {
    const largo = "9".repeat(10_000);
    expect(parseAmountToCents(largo)).toBeNull();
    expect(parseAmountToCents("a".repeat(10_000))).toBeNull();
    expect(parseAmountToCents(`1${",".repeat(10_000)}5`)).toBeNull(); // separadores sin grupos: basura
  });

  it("valores que no son texto (lo que podría colar un cliente manipulado) son null", () => {
    for (const v of [undefined, null, 12, NaN, Infinity, {}, []]) {
      expect(parseAmountToCents(v as unknown as string)).toBeNull();
    }
  });

  it("dígitos no latinos (árabes, de ancho completo) se rechazan, no se adivinan", () => {
    expect(parseAmountToCents("١٢")).toBeNull();
    expect(parseAmountToCents("１２")).toBeNull();
  });
});

describe("parseAmountToCents · fallos conocidos (documentados en el informe)", () => {
  // H-03: tres o más cifras tras el último separador se leen como millares
  // aunque sea imposible que lo sean. «0,295» no puede ser «0.295» de miles.
  it("«0,295» no son 295 € (no hay millares detrás de un cero)", () => {
    expect(parseAmountToCents("0,295")).not.toBe(29_500);
  });

  it("«12,3456» (cuatro decimales) no se lee como 123.456 €", () => {
    expect(parseAmountToCents("12,3456")).toBeNull();
  });

  // H-04: el signo solo se mira en el PRIMER carácter.
  it("«€ -45,00» y «EUR -45,00» son negativos", () => {
    expect(parseAmountToCents("€ -45,00")).toBe(-4500);
    expect(parseAmountToCents("EUR -45,00")).toBe(-4500);
  });

  it("el menos al final de algunos extractos bancarios («45,00-») es negativo", () => {
    expect(parseAmountToCents("45,00-")).toBe(-4500);
  });

  // H-05: «nunca inventa un importe», pero junta los dígitos de cualquier texto.
  it("texto con basura entre los dígitos («1e5», «12abc34», «2x 3,50») es null", () => {
    expect(parseAmountToCents("1e5")).toBeNull();
    expect(parseAmountToCents("12abc34")).toBeNull();
    expect(parseAmountToCents("2x 3,50")).toBeNull();
  });

  it("«-0» es cero, no menos cero (formatCents(-0) pinta «-0,00 €»)", () => {
    expect(Object.is(parseAmountToCents("-0"), 0)).toBe(true);
  });
});

describe("formateo · propiedades", () => {
  it("formatCents nunca usa coma flotante visible (ni «e», ni más de 2 decimales)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }), (c) => {
        const texto = formatCents(c);
        expect(texto).not.toMatch(/e/i);
        expect(texto).toMatch(/^-?[\d.]+,\d{2} €$/);
      }),
      SEMILLA,
    );
  });

  it("formatCentsRounded está a menos de 1 € del importe exacto", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), (c) => {
        const euros = Number(formatCentsRounded(c).replace(/[^\d-]/g, ""));
        expect(Math.abs(euros * 100 - c)).toBeLessThanOrEqual(50);
      }),
      SEMILLA,
    );
  });

  // H-15: Math.round redondea el empate hacia +∞: −1,50 € → «−1 €» pero 1,50 € → «2 €».
  it("formatCentsRounded es simétrico con el signo (−1,50 € → «-2 €»)", () => {
    expect(formatCentsRounded(-150)).toBe(formatCentsRounded(150).replace(/^/, "-"));
  });
});
