import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  apilar,
  cascada,
  diferenciasDiarias,
  escalaBonita,
  indiceColumna,
  indiceLinea,
  mediaEntera,
  nivelCalor,
  proyeccionLineal,
  sectorEnAngulo,
  sectoresAnillo,
  tasaAgregada,
} from "./graficos";

/**
 * Propiedades de la aritmética de los gráficos (fase 1: robustez). Lo que es
 * dinero entra y sale en céntimos ENTEROS; la geometría puede ser flotante.
 * Semilla fija.
 */

const SEMILLA = { seed: 20261019, numRuns: 1000 };
const cents = fc.integer({ min: -10_000_000_000, max: 10_000_000_000 });

// Propiedades con miles de casos: con toda la batería en paralelo pasan de los
// 5 s por defecto en una máquina cargada. Plazo holgado, como en préstamos.
describe("dinero en los gráficos: enteros y cuadrando al céntimo", { timeout: 30_000 }, () => {
  it("cascada: el final es EXACTAMENTE inicio + Σ pasos, y min/max envuelven todas las barras", () => {
    fc.assert(
      fc.property(cents, fc.array(cents, { maxLength: 40 }), (inicio, deltas) => {
        const r = cascada(inicio, deltas);
        expect(r.final).toBe(inicio + deltas.reduce((s, d) => s + d, 0));
        expect(Number.isSafeInteger(r.final)).toBe(true);
        for (const p of r.pasos) {
          expect(p.hasta - p.desde).toBe(p.delta);
          expect(Math.min(p.desde, p.hasta)).toBeGreaterThanOrEqual(r.min);
          expect(Math.max(p.desde, p.hasta)).toBeLessThanOrEqual(r.max);
        }
      }),
      SEMILLA,
    );
  });

  it("diferenciasDiarias: sumando las diferencias se recupera el acumulado (y null sigue siendo null)", () => {
    fc.assert(
      fc.property(fc.array(fc.option(cents, { nil: null }), { maxLength: 31 }), (acumulado) => {
        const d = diferenciasDiarias(acumulado);
        let suma = 0;
        acumulado.forEach((v, i) => {
          if (v === null) return expect(d[i]).toBeNull();
          suma += d[i] as number;
          expect(suma).toBe(v);
        });
      }),
      SEMILLA,
    );
  });

  it("proyeccionLineal: extremos exactos, enteros y monótona entre ellos", () => {
    fc.assert(
      fc.property(cents, cents, fc.integer({ min: 0, max: 400 }), (desde, hasta, pasos) => {
        const r = proyeccionLineal(desde, hasta, pasos);
        expect(r[r.length - 1]).toBe(hasta);
        if (pasos > 0) expect(r[0]).toBe(desde);
        expect(r.every(Number.isSafeInteger)).toBe(true);
        for (let k = 1; k < r.length; k++) {
          if (hasta >= desde) expect(r[k]).toBeGreaterThanOrEqual(r[k - 1]);
          else expect(r[k]).toBeLessThanOrEqual(r[k - 1]);
        }
      }),
      SEMILLA,
    );
  });

  it("mediaEntera: entera y entre el mínimo y el máximo", () => {
    fc.assert(
      fc.property(fc.array(cents, { minLength: 1, maxLength: 60 }), (v) => {
        const m = mediaEntera(v) as number;
        expect(Number.isSafeInteger(m)).toBe(true);
        expect(m).toBeGreaterThanOrEqual(Math.min(...v));
        expect(m).toBeLessThanOrEqual(Math.max(...v));
      }),
      SEMILLA,
    );
    expect(mediaEntera([])).toBeNull();
  });

  it("apilar: el techo de la última capa positiva es la suma de lo positivo, y no se solapan", () => {
    fc.assert(
      fc.property(fc.array(fc.array(cents, { minLength: 5, maxLength: 5 }), { minLength: 1, maxLength: 4 }), (capas) => {
        const r = apilar(capas);
        for (let i = 0; i < 5; i++) {
          const positivos = capas.reduce((s, c) => s + Math.max(c[i], 0), 0);
          const negativos = capas.reduce((s, c) => s + Math.min(c[i], 0), 0);
          const techos = r.map((c) => c[i].techo);
          expect(Math.max(0, ...techos)).toBe(positivos);
          expect(Math.min(0, ...techos)).toBe(negativos);
          capas.forEach((c, k) => expect(r[k][i].techo - r[k][i].base).toBe(c[i]));
        }
      }),
      SEMILLA,
    );
  });

  it("tasaAgregada pondera por ingreso (no es la media de las tasas)", () => {
    expect(tasaAgregada([{ saved_cents: 100, income_cents: 1000 }, { saved_cents: 0, income_cents: 100_000 }])).toBeCloseTo(0.0990099, 5);
    expect(tasaAgregada([{ saved_cents: 5, income_cents: 0 }])).toBeNull();
  });
});

describe("geometría: nunca fuera de rango", () => {
  it("escalaBonita: cubre [min, max], pasos 1-2-5 × 10^k, marcas equiespaciadas y pocas", () => {
    fc.assert(
      fc.property(cents, cents, fc.integer({ min: 1, max: 10 }), (a, b, marcas) => {
        const [min, max] = a <= b ? [a, b] : [b, a];
        const e = escalaBonita(min, max, marcas, 100);
        expect(e.desde).toBeLessThanOrEqual(min);
        expect(e.hasta).toBeGreaterThanOrEqual(max);
        expect(e.hasta).toBeGreaterThan(e.desde);
        const mant = e.paso / 10 ** Math.floor(Math.log10(e.paso));
        expect([1, 2, 5, 10]).toContain(Math.round(mant));
        expect(e.ticks.length).toBeLessThanOrEqual(2 * marcas + 3);
        for (let k = 1; k < e.ticks.length; k++) expect(e.ticks[k] - e.ticks[k - 1]).toBe(e.paso);
      }),
      SEMILLA,
    );
  });

  it("indiceLinea e indiceColumna: siempre un índice válido para posiciones finitas", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: -100, max: 2000, noNaN: true }),
        fc.integer({ min: 0, max: 400 }),
        (x, ancho, total) => {
          const l = indiceLinea(x, ancho, total, 10, 10);
          const c = indiceColumna(x, ancho, total);
          for (const i of [l, c]) {
            expect(Number.isInteger(i)).toBe(true);
            expect(i).toBeGreaterThanOrEqual(0);
            expect(i).toBeLessThanOrEqual(Math.max(total - 1, 0));
          }
        },
      ),
      SEMILLA,
    );
  });

  // H-20 (bajo): una posición NaN (un evento de puntero sin coordenadas, una
  // caja sin medir) se propaga: el índice sale NaN y la lectura, undefined.
  it("indiceColumna e indiceLinea con x = NaN devuelven un índice, no NaN", () => {
    expect(Number.isInteger(indiceColumna(Number.NaN, 300, 12))).toBe(true);
    expect(Number.isInteger(indiceLinea(Number.NaN, 300, 12, 10, 10))).toBe(true);
  });

  it("escalaBonita con Infinity o NaN no se cuelga y devuelve una escala finita", () => {
    for (const [min, max] of [
      [0, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 100],
      [Number.NaN, Number.NaN],
    ]) {
      const e = escalaBonita(min, max, 4, 100);
      expect(Number.isFinite(e.desde) && Number.isFinite(e.hasta) && e.hasta > e.desde).toBe(true);
      expect(e.ticks.length).toBeGreaterThan(0);
    }
  });

  it("sectoresAnillo: fracciones que suman 1, arcos dentro de la vuelta y sin solaparse", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1_000_000 }), { minLength: 1, maxLength: 12 }), (valores) => {
        const s = sectoresAnillo(valores, { hueco: 1.4, remate: 2 });
        const total = s.reduce((t, x) => t + x.fraccion, 0);
        if (valores.some((v) => v > 0)) expect(total).toBeCloseTo(1, 9);
        const n = valores.filter((v) => v > 0).length;
        const descuento = n > 1 ? 1.4 + 2 : 0;
        let acumulado = 0;
        s.forEach((x, i) => {
          if (valores[i] <= 0) return expect(x.largo).toBe(0);
          const tramo = x.fraccion * 100;
          // Cada arco visible cabe en su propia cuña [acumulado, acumulado + tramo].
          // Un sector más pequeño que el hueco queda como un punto de 0,01 % (a
          // propósito) y puede caer fuera de su cuña: no se comprueba.
          if (tramo >= descuento) {
            expect(x.desde).toBeGreaterThanOrEqual(acumulado - 1e-9);
            expect(x.desde + x.largo).toBeLessThanOrEqual(acumulado + tramo + 1e-9);
          }
          acumulado += tramo;
        });
      }),
      SEMILLA,
    );
  });

  it("sectorEnAngulo: el sector devuelto contiene el ángulo", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 10 }), fc.double({ min: 0, max: 99.999, noNaN: true }), (v, vuelta) => {
        const total = v.reduce((a, b) => a + b, 0);
        const fr = v.map((x) => x / total);
        const i = sectorEnAngulo(fr, vuelta);
        const desde = fr.slice(0, i).reduce((a, b) => a + b, 0) * 100;
        expect(vuelta).toBeGreaterThanOrEqual(desde - 1e-9);
      }),
      SEMILLA,
    );
  });

  it("nivelCalor: 0 para nada o devoluciones; 1..niveles para cualquier gasto", () => {
    fc.assert(
      fc.property(cents, fc.integer({ min: 1, max: 10_000_000 }), (v, max) => {
        const n = nivelCalor(Math.min(v, max), max);
        if (v <= 0) expect(n).toBe(0);
        else expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(4);
      }),
      SEMILLA,
    );
  });
});
