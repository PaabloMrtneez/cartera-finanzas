import { describe, expect, it } from "vitest";
import { leerVistaFijos, netoFijo } from "./fijos";

describe("leerVistaFijos", () => {
  it("lee los dos grupos", () => {
    expect(leerVistaFijos("gastos")).toBe("gastos");
    expect(leerVistaFijos("ingresos")).toBe("ingresos");
  });

  it("sin valor, o con uno que no existe, abre los gastos", () => {
    expect(leerVistaFijos(undefined)).toBe("gastos");
    expect(leerVistaFijos("")).toBe("gastos");
    expect(leerVistaFijos("suscripciones")).toBe("gastos");
    expect(leerVistaFijos("INGRESOS")).toBe("gastos");
  });

  it("con el parámetro repetido, manda el primero", () => {
    expect(leerVistaFijos(["ingresos", "gastos"])).toBe("ingresos");
  });
});

describe("netoFijo", () => {
  it("resta en céntimos enteros y solo cuenta lo activo", () => {
    const r = netoFijo(
      [
        { monthly_cents: 1399, active: true },
        { monthly_cents: 2999, active: true },
        { monthly_cents: 50000, active: false },
      ],
      [
        { monthly_cents: 180000, active: true },
        { monthly_cents: 999999, active: false },
      ],
    );
    expect(r).toEqual({ gastosCents: 4398, ingresosCents: 180000, netoCents: 175602 });
    expect(Number.isInteger(r.netoCents)).toBe(true);
  });

  it("sin ingresos fijos, el neto es lo que sale, en negativo", () => {
    expect(netoFijo([{ monthly_cents: 1000, active: true }], []).netoCents).toBe(-1000);
  });

  it("sin nada, cero", () => {
    expect(netoFijo([], [])).toEqual({ gastosCents: 0, ingresosCents: 0, netoCents: 0 });
  });
});
