import { describe, expect, it } from "vitest";
import { ingresoMedio } from "./ingresos";

describe("ingresoMedio", () => {
  const filas = [
    { period_month: "2026-10-01", income_cents: 5_000 }, // mes en curso: fuera
    { period_month: "2026-09-01", income_cents: 200_000 },
    { period_month: "2026-08-01", income_cents: 210_000 },
    { period_month: "2026-07-01", income_cents: 400_000 }, // paga extra
    { period_month: "2026-06-01", income_cents: 999_999 }, // hace cuatro meses: fuera
  ];

  it("es la media de los tres últimos meses CERRADOS, sin el mes en curso", () => {
    expect(ingresoMedio(filas, "2026-10-05")).toEqual({ mediaCents: 270_000, meses: 3 });
  });

  it("no depende del día del mes en que se mira", () => {
    expect(ingresoMedio(filas, "2026-10-01")).toEqual(ingresoMedio(filas, "2026-10-31"));
  });

  it("redondea al céntimo con mitad hacia arriba, en enteros", () => {
    const tres = [
      { period_month: "2026-09-01", income_cents: 100 },
      { period_month: "2026-08-01", income_cents: 100 },
      { period_month: "2026-07-01", income_cents: 101 },
    ];
    // 301 / 3 = 100,33… → 100
    expect(ingresoMedio(tres, "2026-10-05")?.mediaCents).toBe(100);
    const dos = [
      { period_month: "2026-09-01", income_cents: 100 },
      { period_month: "2026-08-01", income_cents: 101 },
    ];
    // 201 / 2 = 100,5 → 101
    expect(ingresoMedio(dos, "2026-10-05")).toEqual({ mediaCents: 101, meses: 2 });
  });

  it("un mes sin movimientos no cuenta; uno con gastos y sin ingresos, sí (como 0)", () => {
    const recien = [
      { period_month: "2026-10-01", income_cents: 0 },
      { period_month: "2026-09-01", income_cents: 0 }, // tuvo gastos, no ingresos
      { period_month: "2026-08-01", income_cents: null }, // la suma de la vista llega a null
      { period_month: "2026-07-01", income_cents: 300_000 },
    ];
    expect(ingresoMedio(recien, "2026-10-05")).toEqual({ mediaCents: 100_000, meses: 3 });
    expect(ingresoMedio(filas.slice(0, 2), "2026-10-05")).toEqual({
      mediaCents: 200_000,
      meses: 1,
    });
  });

  it("sin ningún mes cerrado no hay base", () => {
    expect(ingresoMedio([{ period_month: "2026-10-01", income_cents: 5_000 }], "2026-10-05")).toBeNull();
    expect(ingresoMedio([], "2026-10-05")).toBeNull();
  });

  it("cruza el cambio de año", () => {
    const enero = [
      { period_month: "2026-12-01", income_cents: 300 },
      { period_month: "2026-11-01", income_cents: 300 },
      { period_month: "2026-10-01", income_cents: 300 },
      { period_month: "2026-09-01", income_cents: 9_000 },
    ];
    expect(ingresoMedio(enero, "2027-01-10")).toEqual({ mediaCents: 300, meses: 3 });
  });
});
