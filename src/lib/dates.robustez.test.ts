import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  cargosVencidos,
  cobroSiguiente,
  daysInMonth,
  longDate,
  monthEnd,
  nextCharge,
  shiftDateMonths,
  todayIso,
} from "./dates";
import { leerVistaFijos, netoFijo } from "./fijos";
import { hoyEnMadrid, sumarMeses } from "./prestamos";
import { PERIODICITIES } from "./types";

/**
 * Fechas y periodicidades (fase 1: robustez): fin de mes, 29 de febrero,
 * cambios de hora en Europe/Madrid y el «día 31» en meses cortos. Semilla fija.
 */

const SEMILLA = { seed: 20261019, numRuns: 2000 };

/** Una fecha ISO real entre 2000 y 2100. */
const fechaIso = fc
  .integer({ min: Date.UTC(2000, 0, 1) / 86_400_000, max: Date.UTC(2100, 11, 31) / 86_400_000 })
  .map((dias) => new Date(dias * 86_400_000).toISOString().slice(0, 10));

const diasEntre = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

describe("aritmética de fechas", () => {
  it("addDays es exacta e invertible (también a través de los cambios de hora)", () => {
    fc.assert(
      fc.property(fechaIso, fc.integer({ min: -3000, max: 3000 }), (iso, n) => {
        const r = addDays(iso, n);
        expect(diasEntre(iso, r)).toBe(n);
        expect(addDays(r, -n)).toBe(iso);
      }),
      SEMILLA,
    );
  });

  it("shiftDateMonths (dates.ts) y sumarMeses (prestamos.ts) son la misma función", () => {
    // Son dos copias de la misma lógica (ver el informe, «duplicaciones»): si
    // un día divergen, el préstamo y las suscripciones pondrían fechas distintas.
    fc.assert(
      fc.property(fechaIso, fc.integer({ min: -600, max: 600 }), (iso, n) => {
        expect(shiftDateMonths(iso, n)).toBe(sumarMeses(iso, n));
      }),
      SEMILLA,
    );
  });

  it("monthEnd y daysInMonth: 28/29/30/31 con la regla gregoriana completa", () => {
    fc.assert(
      fc.property(fechaIso, (iso) => {
        const [a, m] = iso.split("-").map(Number);
        const esperado = new Date(Date.UTC(a, m, 0)).getUTCDate();
        expect(daysInMonth(iso)).toBe(esperado);
        expect(monthEnd(iso)).toBe(`${iso.slice(0, 7)}-${String(esperado).padStart(2, "0")}`);
      }),
      SEMILLA,
    );
    expect(daysInMonth("2000-02-10")).toBe(29); // divisible entre 400
    expect(daysInMonth("2100-02-10")).toBe(28); // divisible entre 100, no entre 400
  });

  it("longDate pone el día de la semana correcto (Sakamoto contra Date)", () => {
    const dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
    fc.assert(
      fc.property(fechaIso, (iso) => {
        const dia = new Date(`${iso}T00:00:00Z`).getUTCDay();
        expect(longDate(iso).startsWith(`${dias[dia]},`)).toBe(true);
      }),
      SEMILLA,
    );
  });

  // H-12: el esquema de las acciones solo comprueba el FORMATO de la fecha, y
  // las funciones de fechas no la validan: «30 de febrero» se pinta tal cual.
  it("una fecha imposible (2026-02-30) no se pinta como si existiera", () => {
    expect(longDate("2026-02-30")).not.toBe("lunes, 30 de febrero");
  });
});

describe("periodicidades de los fijos (nextCharge, espejo de private.next_charge)", () => {
  it("cada cargo cae estrictamente después del anterior y en el mes que toca", () => {
    fc.assert(
      fc.property(fechaIso, fc.constantFrom(...PERIODICITIES), (iso, p) => {
        const r = nextCharge(iso, p);
        expect(r > iso).toBe(true);
        const meses = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7));
        if (p === "SEMANAL") expect(diasEntre(iso, r)).toBe(7);
        if (p === "MENSUAL") expect(meses(r) - meses(iso)).toBe(1);
        if (p === "TRIMESTRAL") expect(meses(r) - meses(iso)).toBe(3);
        if (p === "ANUAL") expect(meses(r) - meses(iso)).toBe(12);
      }),
      SEMILLA,
    );
  });

  it("el día 31 en meses cortos se recorta al último día (31 ene → 28 feb; bisiesto → 29)", () => {
    expect(nextCharge("2026-01-31", "MENSUAL")).toBe("2026-02-28");
    expect(nextCharge("2028-01-31", "MENSUAL")).toBe("2028-02-29");
    expect(nextCharge("2026-03-31", "MENSUAL")).toBe("2026-04-30");
    expect(nextCharge("2028-02-29", "ANUAL")).toBe("2029-02-28");
    expect(nextCharge("2026-11-30", "TRIMESTRAL")).toBe("2027-02-28");
  });

  // H-09: el cargo siguiente se calculaba desde el ANTERIOR, no desde el día de
  // alta: un fijo del día 31 pasaba al 28 en febrero y se quedaba en el 28 para
  // siempre. Con el día ancla (el del alta) vuelve al 31 en marzo.
  it("una suscripción mensual del día 31 vuelve al 31 en marzo", () => {
    const feb = nextCharge("2026-01-31", "MENSUAL", 31);
    expect(feb).toBe("2026-02-28");
    expect(nextCharge(feb, "MENSUAL", 31)).toBe("2026-03-31");
    expect(nextCharge("2026-03-31", "MENSUAL", 31)).toBe("2026-04-30");
    expect(nextCharge("2026-11-30", "TRIMESTRAL", 31)).toBe("2027-02-28");
    expect(nextCharge("2027-02-28", "TRIMESTRAL", 31)).toBe("2027-05-31");
  });

  it("cobroSiguiente usa el anchor_day de la fila, como private.next_charge de tres argumentos", () => {
    // El fijo del 31 que la base guarda con próximo cobro el 28 de febrero.
    expect(cobroSiguiente({ proxima: "2026-02-28", periodicity: "MENSUAL", anchor_day: 31 })).toBe("2026-03-31");
    // El anual del 29 de febrero vuelve al 29 en el bisiesto.
    expect(cobroSiguiente({ proxima: "2027-02-28", periodicity: "ANUAL", anchor_day: 29 })).toBe("2028-02-29");
    expect(cobroSiguiente({ proxima: "2026-10-20", periodicity: "SEMANAL", anchor_day: 20 })).toBe("2026-10-27");
    // Sin ancla (fila anterior a la columna), como la versión de dos argumentos.
    expect(cobroSiguiente({ proxima: "2026-02-28", periodicity: "MENSUAL", anchor_day: null })).toBe("2026-03-28");
    // Y con el ancla de la fila, los cargos atrasados tampoco derivan.
    expect(cargosVencidos("2026-02-28", "MENSUAL", "2026-04-30", 31)).toBe(2); // 31 mar y 30 abr
  });

  it("cargosVencidos no deriva: un fijo del 31 de enero cuenta el 31 de marzo", () => {
    expect(cargosVencidos("2026-01-31", "MENSUAL", "2026-03-30")).toBe(1); // solo el 28 feb
    expect(cargosVencidos("2026-01-31", "MENSUAL", "2026-03-31")).toBe(2);
  });

  it("cargosVencidos cuenta exactamente los cargos hasta hoy y se detiene en 400", () => {
    fc.assert(
      fc.property(fechaIso, fc.constantFrom(...PERIODICITIES), fechaIso, (desde, p, hoy) => {
        const n = cargosVencidos(desde, p, hoy);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(400);
        // Recalcular a mano: n pasos caen en o antes de hoy; el siguiente, después.
        const ancla = Number(desde.slice(8, 10));
        let f = desde;
        for (let i = 0; i < n; i++) f = nextCharge(f, p, ancla);
        if (n < 400) expect(nextCharge(f, p, ancla) > hoy).toBe(true);
        if (n > 0) expect(f <= hoy).toBe(true);
      }),
      { ...SEMILLA, numRuns: 300 },
    );
  });

  it("netoFijo: entero, ignora lo pausado y neto = ingresos − gastos", () => {
    const fila = fc.record({ monthly_cents: fc.integer({ min: 0, max: 10_000_000 }), active: fc.boolean() });
    fc.assert(
      fc.property(fc.array(fila, { maxLength: 30 }), fc.array(fila, { maxLength: 30 }), (g, i) => {
        const r = netoFijo(g, i);
        const suma = (xs: typeof g) => xs.filter((x) => x.active).reduce((s, x) => s + x.monthly_cents, 0);
        expect(r.gastosCents).toBe(suma(g));
        expect(r.ingresosCents).toBe(suma(i));
        expect(r.netoCents).toBe(r.ingresosCents - r.gastosCents);
      }),
      SEMILLA,
    );
  });

  it("leerVistaFijos: cualquier ?ver= raro abre la vista por defecto, nunca revienta", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.array(fc.string()), fc.constant(undefined)), (v) => {
        expect(["gastos", "ingresos"]).toContain(leerVistaFijos(v));
      }),
      SEMILLA,
    );
  });
});

describe("«hoy» en el servidor (Vercel corre en UTC)", () => {
  const tzOriginal = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = tzOriginal;
  });

  it("hoyEnMadrid ya da el día de Madrid aunque el servidor esté en UTC", () => {
    process.env.TZ = "UTC";
    expect(hoyEnMadrid(new Date("2026-10-31T23:30:00Z"))).toBe("2026-11-01");
  });

  // H-07: `todayIso()` usa la hora LOCAL del proceso. En Vercel es UTC, así que
  // entre las 00:00 y las 01:00/02:00 de Madrid el servidor cree que es AYER:
  // el día 1 a las 00:30, Resumen y /api/informe enseñan el mes anterior como
  // «mes actual», y Inversiones rechaza la fecha de hoy por «futura».
  it("en un servidor UTC, todayIso() del 1 de noviembre a las 00:30 de Madrid es 2026-11-01", () => {
    process.env.TZ = "UTC";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T23:30:00Z")); // 00:30 CET del día 1
    expect(todayIso()).toBe("2026-11-01");
  });
});
