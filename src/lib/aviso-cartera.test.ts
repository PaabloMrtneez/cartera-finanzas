import { describe, expect, it } from "vitest";
import { idDeAviso, isoDesdeMadrid, leerAvisoCartera, leerFechaAviso, limpiarComercio } from "./aviso-cartera";

describe("leerAvisoCartera: los avisos reales", () => {
  it("una recarga de Revolut con la tarjeta de Santander", () => {
    const r = leerAvisoCartera({ tarjeta: "Santander", comercio: "Revolut", importe: "24,00 €", fecha: "27 oct 2026, 10:00" });
    expect(r).toEqual({
      ok: true,
      cents: 2400,
      tarjeta: "Santander",
      comercio: "Revolut",
      occurredAt: "2026-10-27T10:00:00+01:00",
    });
  });

  it("un café con la de Revolut: el comercio sin la ciudad", () => {
    const r = leerAvisoCartera({ tarjeta: "Revolut", comercio: "Cafeteria. Madrid, Madrid", importe: "2,00 €" });
    expect(r.ok && r.comercio).toBe("Cafeteria");
    expect(r.ok && r.cents).toBe(200);
    expect(r.ok && r.occurredAt).toBeNull();
  });

  it("importes con millares, sin decimales y con espacio duro", () => {
    expect(leerAvisoCartera({ importe: "1.234,56 €" })).toMatchObject({ ok: true, cents: 123_456 });
    expect(leerAvisoCartera({ importe: "99 €" })).toMatchObject({ ok: true, cents: 9_900 });
    expect(leerAvisoCartera({ importe: "29,95 €" })).toMatchObject({ ok: true, cents: 2_995 });
  });
});

describe("leerAvisoCartera: lo que no es un cargo en euros", () => {
  it("otra moneda", () => {
    expect(leerAvisoCartera({ importe: "$12.00" })).toMatchObject({ ok: false, error: "currency_not_supported" });
    expect(leerAvisoCartera({ importe: "12,00 USD" })).toMatchObject({ ok: false, error: "currency_not_supported" });
  });

  it("una devolución o un abono (con signo) no se apunta como gasto", () => {
    expect(leerAvisoCartera({ importe: "−24,00 €" })).toMatchObject({ ok: false, error: "not_a_charge" });
    expect(leerAvisoCartera({ importe: "+5,00 €" })).toMatchObject({ ok: false, error: "not_a_charge" });
    expect(leerAvisoCartera({ importe: "Reembolso de 5,00 €" })).toMatchObject({ ok: false, error: "not_a_charge" });
  });

  it("vacío o el nombre de la variable escrito: importe no válido, con pista", () => {
    const vacio = leerAvisoCartera({ importe: "" });
    expect(vacio).toMatchObject({ ok: false, error: "invalid_amount" });
    expect(leerAvisoCartera({ importe: "0,00 €" })).toMatchObject({ ok: false, error: "invalid_amount" });
  });
});

describe("limpiarComercio", () => {
  it("quita solo el «. Ciudad, Provincia» del final", () => {
    expect(limpiarComercio("Cafeteria. Madrid, Madrid")).toBe("Cafeteria");
    expect(limpiarComercio("Dr. Oetker")).toBe("Dr. Oetker");
    expect(limpiarComercio("Amazon.es")).toBe("Amazon.es");
    expect(limpiarComercio("Uber")).toBe("Uber");
    expect(limpiarComercio("  ")).toBeNull();
    expect(limpiarComercio(null)).toBeNull();
  });
});

describe("leerFechaAviso", () => {
  it("el formato español de iOS, en hora de Madrid (invierno y verano)", () => {
    expect(leerFechaAviso("27 oct 2026, 10:00")).toBe("2026-10-27T10:00:00+01:00");
    expect(leerFechaAviso("15 jul 2026 9:05")).toBe("2026-07-15T09:05:00+02:00");
    expect(leerFechaAviso("3/1/2026 23:59")).toBe("2026-01-03T23:59:00+01:00");
  });

  it("ISO pasa tal cual; lo que no se entiende, null (la base pone la hora de llegada)", () => {
    expect(leerFechaAviso("2026-10-27T10:00:23+01:00")).toBe("2026-10-27T10:00:23+01:00");
    expect(leerFechaAviso("ayer")).toBeNull();
    expect(leerFechaAviso("31 feb 2026, 10:00")).toBeNull();
    expect(leerFechaAviso("")).toBeNull();
  });

  it("el cambio de hora de octubre: antes y después", () => {
    expect(isoDesdeMadrid(2026, 10, 25, 1, 30)).toBe("2026-10-25T01:30:00+02:00");
    expect(isoDesdeMadrid(2026, 10, 25, 4, 0)).toBe("2026-10-25T04:00:00+01:00");
  });
});

describe("idDeAviso", () => {
  const aviso = { tarjeta: "Santander", comercio: "Revolut", importe: "24,00 €", fecha: "27 oct 2026, 10:00" };

  it("el mismo aviso da el mismo id; otro minuto u otro importe, otro", () => {
    expect(idDeAviso(aviso, 2400)).toBe(idDeAviso({ ...aviso }, 2400));
    expect(idDeAviso(aviso, 2400)).toMatch(/^cartera_[0-9a-f]{40}$/);
    expect(idDeAviso({ ...aviso, fecha: "27 oct 2026, 10:01" }, 2400)).not.toBe(idDeAviso(aviso, 2400));
    expect(idDeAviso(aviso, 2401)).not.toBe(idDeAviso(aviso, 2400));
  });

  it("sin fecha, cuenta el minuto de llegada", () => {
    const sin = { ...aviso, fecha: null };
    const a = new Date("2026-10-27T09:00:10Z");
    const b = new Date("2026-10-27T09:00:50Z");
    const c = new Date("2026-10-27T09:01:05Z");
    expect(idDeAviso(sin, 2400, a)).toBe(idDeAviso(sin, 2400, b));
    expect(idDeAviso(sin, 2400, a)).not.toBe(idDeAviso(sin, 2400, c));
  });
});
