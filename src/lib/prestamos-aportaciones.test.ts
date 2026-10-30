import { describe, expect, it } from "vitest";
import {
  APORTACION_MINIMA,
  CuadroInvalido,
  cuadroAmortizacion,
  cuadroConAportaciones,
  efectoAportacion,
  planParaTerminar,
  type Aportacion,
  type CuotaConAportacion,
  type EntradaCuadro,
} from "./prestamos";

/**
 * El cuadro con aportaciones extra (amortización anticipada parcial). La
 * comparación al céntimo con `public.loan_cuadro` de la base va en
 * scripts/test-aportaciones.mjs; aquí, los casos a mano, las comparaciones
 * cruzadas con el cuadro original y las invariantes en una rejilla aleatoria.
 */

const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** 10.000 € a 52 meses al 7 %: el ejemplo del plan. */
const EJEMPLO: EntradaCuadro = { principalCents: 1_000_000, plazoMeses: 52, tin: 70_000, primeraCuota: "2026-12-01" };

/**
 * Las invariantes de cualquier cuadro con aportaciones. Lo aportado antes de
 * la primera cuota (tras la 0) no tiene fila propia: se suma aparte.
 */
function compruebaInvariantes(e: EntradaCuadro, c: CuotaConAportacion[], aps: Aportacion[] = []) {
  const antesDeLaPrimera = suma(aps.filter((a) => a.despuesDe === 0).map((a) => a.importe));
  expect(suma(c.map((f) => f.capital)) + suma(c.map((f) => f.aportado)) + antesDeLaPrimera).toBe(e.principalCents);
  expect(c.every((f) => f.pendiente >= 0 && f.capital > 0 && f.intereses >= 0)).toBe(true);
  expect(c[c.length - 1].pendiente).toBe(0);
  expect(c[c.length - 1].aportado).toBe(0);
  expect(c.length).toBeLessThanOrEqual(e.plazoMeses);
  c.forEach((f, i) => expect(f.periodo).toBe(i + 1));
  for (let i = 1; i < c.length; i++) {
    expect(c[i].pendiente).toBeLessThan(c[i - 1].pendiente);
  }
}

describe("cuadroConAportaciones · sin aportaciones", () => {
  it("es el cuadro original, fila a fila", () => {
    for (const e of [
      EJEMPLO,
      { principalCents: 10_000, plazoMeses: 1, tin: 0, primeraCuota: "2026-01-31" },
      { principalCents: 2_000_000, plazoMeses: 360, tin: 32_500, primeraCuota: "2026-03-15" },
      { principalCents: 123_457, plazoMeses: 13, tin: 0, primeraCuota: "2026-02-28" },
    ]) {
      const original = cuadroAmortizacion(e);
      expect(cuadroConAportaciones(e, [])).toEqual(original.map((f) => ({ ...f, aportado: 0 })));
    }
  });
});

describe("cuadroConAportaciones · reducir plazo", () => {
  const original = cuadroAmortizacion(EJEMPLO);
  const c = cuadroConAportaciones(EJEMPLO, [{ despuesDe: 6, importe: 300_000, modo: "PLAZO" }]);

  it("hasta la cuota 6, idéntico; la aportación baja el pendiente tras ella", () => {
    expect(c.slice(0, 5)).toEqual(original.slice(0, 5).map((f) => ({ ...f, aportado: 0 })));
    expect(c[5].aportado).toBe(300_000);
    expect(c[5].pendiente).toBe(original[5].pendiente - 300_000);
  });

  it("la cuota no cambia (salvo la última, que ajusta) y termina antes", () => {
    const cuota = original[0].cuota;
    expect(c.slice(0, -1).every((f) => f.cuota === cuota)).toBe(true);
    expect(c[c.length - 1].cuota).toBeLessThanOrEqual(cuota);
    expect(c.length).toBe(36);
    compruebaInvariantes(EJEMPLO, c);
  });

  it("paga menos intereses que sin aportar", () => {
    expect(suma(c.map((f) => f.intereses))).toBeLessThan(suma(original.map((f) => f.intereses)));
  });
});

describe("cuadroConAportaciones · reducir cuota", () => {
  const original = cuadroAmortizacion(EJEMPLO);
  const c = cuadroConAportaciones(EJEMPLO, [{ despuesDe: 6, importe: 300_000, modo: "CUOTA" }]);

  it("mantiene el fin y, desde la 7, es un préstamo nuevo por lo que queda a 46 meses", () => {
    expect(c.length).toBe(52);
    const nuevo = cuadroAmortizacion({
      principalCents: c[5].pendiente,
      plazoMeses: 46,
      tin: EJEMPLO.tin,
      primeraCuota: c[6].fecha,
    });
    expect(c.slice(6).map(({ aportado, periodo, ...f }) => (void aportado, void periodo, f))).toEqual(
      nuevo.map(({ periodo, ...f }) => (void periodo, f)),
    );
    expect(c[6].cuota).toBeLessThan(original[6].cuota);
    compruebaInvariantes(EJEMPLO, c);
  });
});

describe("cuadroConAportaciones · casos límite", () => {
  it("antes de la primera cuota (tras la 0)", () => {
    const aps: Aportacion[] = [{ despuesDe: 0, importe: 500_000, modo: "CUOTA" }];
    const c = cuadroConAportaciones(EJEMPLO, aps);
    const nuevo = cuadroAmortizacion({ ...EJEMPLO, principalCents: 500_000 });
    expect(c.map(({ aportado, ...f }) => (void aportado, f))).toEqual(nuevo);
    compruebaInvariantes(EJEMPLO, c, aps);
  });

  it("varias en el mismo mes y modos mezclados: en orden", () => {
    const aps: Aportacion[] = [
      { despuesDe: 3, importe: 100_000, modo: "PLAZO" },
      { despuesDe: 3, importe: 50_000, modo: "CUOTA" },
      { despuesDe: 10, importe: 200_000, modo: "PLAZO" },
      { despuesDe: 20, importe: 10_000, modo: "CUOTA" },
    ];
    const c = cuadroConAportaciones(EJEMPLO, aps);
    expect(c[2].aportado).toBe(150_000);
    compruebaInvariantes(EJEMPLO, c, aps);
    // Tras la última en CUOTA, el fin es el que había cuando se hizo.
    const finTrasPlazo = cuadroConAportaciones(EJEMPLO, aps.slice(0, 3)).length;
    expect(c.length).toBe(finTrasPlazo);
  });

  it("una aportación que deja una sola cuota", () => {
    const original = cuadroAmortizacion(EJEMPLO);
    const pend = original[49].pendiente; // tras la 50, quedan 2
    const c = cuadroConAportaciones(EJEMPLO, [{ despuesDe: 50, importe: pend - 100, modo: "PLAZO" }]);
    expect(c.length).toBe(51);
    compruebaInvariantes(EJEMPLO, c);
  });

  it("rechaza lo que no cabe", () => {
    const pend6 = cuadroAmortizacion(EJEMPLO)[5].pendiente;
    for (const aps of [
      [{ despuesDe: 6, importe: APORTACION_MINIMA - 1, modo: "PLAZO" }],
      [{ despuesDe: 6, importe: pend6, modo: "PLAZO" }],
      [{ despuesDe: 6, importe: pend6 + 1, modo: "CUOTA" }],
      [{ despuesDe: 52, importe: 100, modo: "PLAZO" }],
      [{ despuesDe: 60, importe: 100, modo: "PLAZO" }],
      [{ despuesDe: -1, importe: 100, modo: "PLAZO" }],
      [{ despuesDe: 1.5, importe: 100, modo: "PLAZO" }],
      [{ despuesDe: 2, importe: 100.5, modo: "PLAZO" }],
    ] as Aportacion[][]) {
      expect(() => cuadroConAportaciones(EJEMPLO, aps)).toThrow(CuadroInvalido);
    }
  });

  it("una aportación tras una cuota que ya no existe (el plazo se acortó antes) se rechaza", () => {
    const corto = cuadroConAportaciones(EJEMPLO, [{ despuesDe: 2, importe: 800_000, modo: "PLAZO" }]);
    expect(() =>
      cuadroConAportaciones(EJEMPLO, [
        { despuesDe: 2, importe: 800_000, modo: "PLAZO" },
        { despuesDe: corto.length + 1, importe: 100, modo: "PLAZO" },
      ]),
    ).toThrow(CuadroInvalido);
  });
});

/** Un generador pseudoaleatorio con semilla, para que la rejilla sea siempre la misma. */
function semilla(n: number) {
  let s = n;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

describe("cuadroConAportaciones · rejilla aleatoria de invariantes", () => {
  it("300 préstamos con aportaciones al azar cumplen todo", () => {
    const azar = semilla(42);
    let probados = 0;
    for (let caso = 0; caso < 300; caso++) {
      const e: EntradaCuadro = {
        principalCents: 10_000 + Math.floor(azar() * 5_000_000),
        plazoMeses: 2 + Math.floor(azar() * 120),
        tin: Math.floor(azar() * 150_000),
        primeraCuota: "2026-01-28",
      };
      let original;
      try {
        original = cuadroAmortizacion(e);
      } catch {
        continue; // condiciones que la base también rechaza
      }
      const aps: Aportacion[] = [];
      let c = cuadroConAportaciones(e, aps);
      let soloPlazo = true;
      for (let n = 0; n < 4; n++) {
        const k = Math.floor(azar() * (c.length - 1));
        const pend = k === 0 ? e.principalCents - suma(aps.filter((a) => a.despuesDe === 0).map((a) => a.importe)) : c[k - 1].pendiente;
        if (pend <= APORTACION_MINIMA + 1) continue;
        const modo = azar() < 0.5 ? "PLAZO" : "CUOTA";
        const nueva: Aportacion = { despuesDe: k, importe: APORTACION_MINIMA + Math.floor(azar() * (pend - APORTACION_MINIMA - 1)), modo };
        // Solo al final del todo: una aportación anterior a otra ya hecha cambiaría las siguientes.
        if (aps.some((a) => a.despuesDe > k)) continue;
        aps.push(nueva);
        const finAntes = c.length;
        c = cuadroConAportaciones(e, aps);
        // Ninguna aportación alarga el fin que ya había (tampoco CUOTA tras PLAZO).
        expect(c.length).toBeLessThanOrEqual(finAntes);
        if (modo === "CUOTA") soloPlazo = false;
        compruebaInvariantes(e, c, aps);
        // Nunca termina más tarde que el original.
        expect(c.length).toBeLessThanOrEqual(original.length);
      }
      if (soloPlazo && aps.length > 0) {
        // Solo en PLAZO, la cuota no cambia nunca (salvo la última).
        expect(c.slice(0, -1).every((f) => f.cuota === original[0].cuota)).toBe(true);
      }
      probados++;
    }
    expect(probados).toBeGreaterThan(200);
  });
});

describe("efectoAportacion", () => {
  it("reducir plazo ahorra más que reducir cuota con el mismo importe", () => {
    const plazo = efectoAportacion(EJEMPLO, [], { despuesDe: 6, importe: 300_000, modo: "PLAZO" });
    const cuota = efectoAportacion(EJEMPLO, [], { despuesDe: 6, importe: 300_000, modo: "CUOTA" });
    expect(plazo.ahorro).toBeGreaterThan(cuota.ahorro);
    expect(cuota.ahorro).toBeGreaterThan(0);
    expect(plazo.cuotasAntes).toBe(46);
    expect(plazo.cuotasDespues).toBe(30);
    expect(plazo.cuotaDespues).toBe(plazo.cuotaAntes);
    expect(cuota.cuotasDespues).toBe(46);
    expect(cuota.cuotaDespues).toBeLessThan(cuota.cuotaAntes);
    expect(plazo.finDespues < plazo.finAntes).toBe(true);
    expect(cuota.finDespues).toBe(cuota.finAntes);
  });
});

/** El simulador mensual, rehecho a mano con el cuadro de verdad: una aportación por mes. */
function mensualConElMotor(e: EntradaCuadro, desde: number, extra: number) {
  const aps: Aportacion[] = [];
  let c = cuadroConAportaciones(e, aps);
  for (let k = desde; ; k++) {
    const pend = k === 0 ? e.principalCents : c[k - 1].pendiente;
    if (k > desde && c[k - 1].periodo === c.length) break; // ya era la última
    if (extra >= pend) {
      // Esa aportación liquida lo que queda: el préstamo acaba en la cuota k.
      return { cuotas: k - desde, intereses: suma(c.slice(desde, k).map((f) => f.intereses)) };
    }
    aps.push({ despuesDe: k, importe: extra, modo: "PLAZO" });
    c = cuadroConAportaciones(e, aps);
  }
  return { cuotas: c.length - desde, intereses: suma(c.slice(desde).map((f) => f.intereses)) };
}

describe("planParaTerminar", () => {
  it("de 52 a 20 meses: las dos respuestas, mínimas al céntimo y coherentes con el cuadro", () => {
    const plan = planParaTerminar(EJEMPLO, [], 0, 20);
    const base = suma(cuadroAmortizacion(EJEMPLO).map((f) => f.intereses));

    expect(plan.unica).not.toBeNull();
    const u = plan.unica!;
    const cuotasCon = (x: number) => cuadroConAportaciones(EJEMPLO, [{ despuesDe: 0, importe: x, modo: "PLAZO" }]).length;
    expect(cuotasCon(u.importe)).toBeLessThanOrEqual(20);
    expect(cuotasCon(u.importe - 1)).toBeGreaterThan(20);

    expect(plan.mensual).not.toBeNull();
    const m = plan.mensual!;
    const con = mensualConElMotor(EJEMPLO, 0, m.extra);
    expect(con.cuotas).toBeLessThanOrEqual(20);
    expect(mensualConElMotor(EJEMPLO, 0, m.extra - 1).cuotas).toBeGreaterThan(20);
    // El simulador rápido da los mismos intereses que el cuadro mes a mes.
    expect(m.ahorro).toBe(base - con.intereses);
    expect(m.pagoMes).toBe(cuadroAmortizacion(EJEMPLO)[0].cuota + m.extra);
    expect(u.ahorro).toBeGreaterThan(0);
  });

  it("a mitad de préstamo y tras otra aportación, igual de coherente", () => {
    const aps: Aportacion[] = [{ despuesDe: 4, importe: 120_000, modo: "CUOTA" }];
    const plan = planParaTerminar(EJEMPLO, aps, 9, 12);
    expect(plan.unica).not.toBeNull();
    expect(plan.mensual).not.toBeNull();
    const conUnica = cuadroConAportaciones(EJEMPLO, [...aps, { despuesDe: 9, importe: plan.unica!.importe, modo: "PLAZO" }]);
    expect(conUnica.filter((f) => f.periodo > 9).length).toBeLessThanOrEqual(12);
  });

  it("si ya terminas en esos meses, o el plazo no tiene sentido, no hay plan", () => {
    expect(planParaTerminar(EJEMPLO, [], 0, 52)).toEqual({ meses: 52, mensual: null, unica: null });
    expect(planParaTerminar(EJEMPLO, [], 0, 60).mensual).toBeNull();
    expect(planParaTerminar(EJEMPLO, [], 0, 0).unica).toBeNull();
    expect(planParaTerminar(EJEMPLO, [], 0, 2.5).unica).toBeNull();
  });
});
