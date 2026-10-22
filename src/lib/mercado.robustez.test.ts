import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatDecimalTexto, valorEnCentimos } from "./mercado";
import { parseParticipaciones } from "./participaciones";
import { applyPercent, parsePercent } from "./valoracion";

/**
 * Valoración de participaciones (fase 1: robustez). participaciones × precio
 * (÷ cambio del BCE) → céntimos, en enteros. Se compara contra la definición
 * exacta en racionales: el resultado es el céntimo más cercano y, en el
 * empate, hacia arriba. Semilla fija.
 */

const SEMILLA = { seed: 20261019, numRuns: 3000 };

/** Un decimal en texto con hasta `dec` decimales, sin signo. */
const decimal = (maxEntero: number, dec: number) =>
  fc
    .tuple(fc.integer({ min: 0, max: maxEntero }), fc.integer({ min: 0, max: 10 ** dec - 1 }), fc.integer({ min: 0, max: dec }))
    .map(([e, f, d]) => (d === 0 ? String(e) : `${e}.${String(f % 10 ** d).padStart(d, "0")}`));

/** n/10^escala de un decimal en texto, como racional de BigInt. */
function racional(texto: string): [bigint, bigint] {
  const [e, f = ""] = texto.split(".");
  return [BigInt(e + f), BigInt(10) ** BigInt(f.length)];
}

describe("valorEnCentimos · el céntimo más cercano, en racionales exactos", () => {
  it("participaciones (8 dec) × precio (6 dec) en EUR", () => {
    fc.assert(
      fc.property(decimal(10_000_000, 8), decimal(100_000, 6), (u, p) => {
        const c = valorEnCentimos(u, p);
        const [un, ud] = racional(u);
        const [pn, pd] = racional(p);
        const num = un * pn * BigInt(100);
        const den = ud * pd;
        if (c === null) {
          // Solo se rinde si no cabe en un entero seguro.
          expect(num / den > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
          return;
        }
        const dif = BigInt(2) * BigInt(c) * den - BigInt(2) * num; // 2·(c − exacto)·den
        expect(dif <= den && dif > -den).toBe(true);
      }),
      SEMILLA,
    );
  });

  it("con divisa: se divide por el cambio del BCE (unidades por euro) y sigue siendo exacto", () => {
    fc.assert(
      fc.property(decimal(1_000_000, 8), decimal(10_000, 6), decimal(200, 6), (u, p, fx) => {
        fc.pre(!/^0+(\.0*)?$/.test(fx));
        const c = valorEnCentimos(u, p, fx);
        const [un, ud] = racional(u);
        const [pn, pd] = racional(p);
        const [fn, fd] = racional(fx);
        const num = un * pn * BigInt(100) * fd;
        const den = ud * pd * fn;
        if (c === null) {
          // Un cambio diminuto dispara el valor: solo se rinde si no cabe.
          expect(num / den > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
          return;
        }
        const dif = BigInt(2) * BigInt(c as number) * den - BigInt(2) * num;
        expect(dif <= den && dif > -den).toBe(true);
      }),
      SEMILLA,
    );
  });

  it("monótono: más participaciones o más precio nunca valen menos", () => {
    fc.assert(
      fc.property(decimal(100_000, 6), decimal(100_000, 6), decimal(1_000, 4), (a, b, p) => {
        const [x, y] = Number(a) <= Number(b) ? [a, b] : [b, a];
        const vx = valorEnCentimos(x, p) as number;
        const vy = valorEnCentimos(y, p) as number;
        expect(vx).toBeLessThanOrEqual(vy);
      }),
      SEMILLA,
    );
  });

  it("los ceros a la derecha no cambian nada («1.5» = «1.500000»)", () => {
    fc.assert(
      fc.property(decimal(100_000, 6), decimal(10_000, 4), fc.integer({ min: 1, max: 6 }), (u, p, ceros) => {
        const conCeros = u.includes(".") ? u + "0".repeat(ceros) : `${u}.${"0".repeat(ceros)}`;
        expect(valorEnCentimos(conCeros, p)).toBe(valorEnCentimos(u, p));
      }),
      SEMILLA,
    );
  });

  it("casos concretos con 6+ decimales y precios de 4", () => {
    expect(valorEnCentimos("123.456789", "14.6592")).toBe(180_978); // 1809,7777… → 1809,78 €
    expect(valorEnCentimos("0.00000001", "1")).toBe(0);
    expect(valorEnCentimos("0.005", "1")).toBe(1); // medio céntimo: empate hacia arriba
    expect(valorEnCentimos("100", "350.5", "1.1269")).toBe(3_110_303); // 35050/1,1269 = 31103,027…
  });

  it("entradas que no son decimales limpios: null, nunca NaN ni excepción", () => {
    for (const [u, p, fx] of [
      ["-1", "10", null],
      ["1e5", "10", null],
      ["1,5", "10", null], // con coma no: llega ya normalizado de la base
      ["", "10", null],
      ["NaN", "10", null],
      ["1", "Infinity", null],
      ["1", "10", "0"],
      ["1", "10", "0.000"],
      ["1", "10", "-1.1"],
    ] as Array<[string, string, string | null]>) {
      expect(valorEnCentimos(u, p, fx)).toBeNull();
    }
  });
});

describe("participaciones · ida y vuelta con el formateo de la pantalla", () => {
  it("formatDecimalTexto («1.234,5678») → parseParticipaciones devuelve el decimal canónico", () => {
    fc.assert(
      fc.property(decimal(9_999_999_999, 8), (texto) => {
        fc.pre(!/^0+(\.0*)?$/.test(texto));
        const canonico = texto.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
        const lectura = parseParticipaciones(formatDecimalTexto(texto));
        // Ambigüedad documentada: «1.234» de cuatro cifras sin millares no se da,
        // porque formatDecimalTexto no agrupa por debajo de 5 cifras.
        expect(lectura).toEqual({ ok: true, valor: canonico });
      }),
      SEMILLA,
    );
  });

  it("con texto arbitrario nunca revienta y, si acepta, devuelve un decimal limpio ≤ 8 decimales", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), (texto) => {
        const r = parseParticipaciones(texto);
        if (r.ok) expect(r.valor).toMatch(/^\d{1,16}(\.\d{1,8})?$/);
        else expect(r.error.length).toBeGreaterThan(0);
      }),
      { ...SEMILLA, numRuns: 5000 },
    );
  });

  it("10 000 caracteres: error, no un cuelgue", () => {
    expect(parseParticipaciones("1".repeat(10_000)).ok).toBe(false);
    expect(parseParticipaciones(`0,${"1".repeat(10_000)}`).ok).toBe(false);
  });
});

describe("valoración por porcentaje · applyPercent", () => {
  it("0 % deja la base igual; −100 % la deja en cero; nunca negativa", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000_000 }), (base) => {
        expect(applyPercent(base, { n: 0, decimales: 0 })).toBe(base);
        expect(applyPercent(base, { n: -100, decimales: 0 })).toBe(0);
        if (base > 0) expect(applyPercent(base, { n: -10_001, decimales: 2 })).toBeNull();
      }),
      SEMILLA,
    );
  });

  it("es el céntimo más cercano de base · (1 + pct/100), con el empate hacia arriba", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), fc.integer({ min: -9999, max: 99_999 }), fc.integer({ min: 0, max: 4 }), (base, n, dec) => {
        const r = applyPercent(base, { n, decimales: dec });
        const escala = BigInt(100) * BigInt(10) ** BigInt(dec);
        const num = BigInt(base) * (escala + BigInt(n));
        if (num < BigInt(0)) {
          expect(r).toBeNull();
          return;
        }
        const dif = BigInt(2) * BigInt(r as number) * escala - BigInt(2) * num;
        expect(dif <= escala && dif > -escala).toBe(true);
      }),
      SEMILLA,
    );
  });

  it("parsePercent: ida y vuelta con coma o punto, signo tipográfico, y nada raro aceptado", () => {
    fc.assert(
      fc.property(fc.integer({ min: -999_999, max: 999_999 }), fc.integer({ min: 0, max: 4 }), fc.constantFrom(",", "."), (n, dec, sep) => {
        const abs = String(Math.abs(n)).padStart(dec + 1, "0");
        const texto = (n < 0 ? "−" : "") + (dec ? `${abs.slice(0, -dec)}${sep}${abs.slice(-dec)}` : abs) + " %";
        const r = parsePercent(texto);
        expect(r).not.toBeNull();
        expect((r as { n: number }).n).toBe(n === 0 ? 0 : n);
      }),
      SEMILLA,
    );
    for (const raro of ["", "%", "--5", "5,5,5", "1e3", "NaN", "12,34567", "1234567"]) {
      expect(parsePercent(raro)).toBeNull();
    }
  });
});
