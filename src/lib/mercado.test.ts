import { describe, expect, it } from "vitest";
import {
  aportadoHasta,
  formatCambio,
  formatDecimalTexto,
  formatParticipaciones,
  formatPrecio,
  valorEnCentimos,
} from "./mercado";

const NBSP = " ";

describe("formatDecimalTexto", () => {
  it("coma decimal y sin ceros sobrantes", () => {
    expect(formatDecimalTexto("1234.56789000")).toBe("1234,56789");
    expect(formatDecimalTexto("14.659200")).toBe("14,6592");
    expect(formatDecimalTexto("12.00000000")).toBe("12");
  });

  it("no agrupa los millares hasta las cinco cifras, como money.ts", () => {
    expect(formatDecimalTexto("1234.5")).toBe("1234,5");
    expect(formatDecimalTexto("12345.5")).toBe("12.345,5");
    expect(formatDecimalTexto("1234567")).toBe("1.234.567");
  });

  it("rellena hasta el mínimo de decimales", () => {
    expect(formatDecimalTexto("350.5", { min: 2 })).toBe("350,50");
    expect(formatDecimalTexto("306", { min: 2 })).toBe("306,00");
  });

  it("recorta al máximo redondeando la mitad hacia arriba, sin coma flotante", () => {
    expect(formatDecimalTexto("1.11775", { max: 4 })).toBe("1,1178");
    expect(formatDecimalTexto("1.11774", { max: 4 })).toBe("1,1177");
    expect(formatDecimalTexto("9.999995", { max: 5 })).toBe("10");
    expect(formatDecimalTexto("0.004", { max: 2, min: 2 })).toBe("0,00");
    // 0,1 + 0,2 no existe aquí: los dígitos se tratan como enteros.
    expect(formatDecimalTexto("0.30000000000000004", { max: 8 })).toBe("0,3");
  });

  it("deja tal cual lo que no es un decimal", () => {
    expect(formatDecimalTexto("abc")).toBe("abc");
  });
});

describe("formatos de mercado", () => {
  it("precio con su divisa", () => {
    expect(formatPrecio("14.659200", "EUR")).toBe(`14,6592${NBSP}€`);
    expect(formatPrecio("350.5", "USD")).toBe(`350,50${NBSP}$`);
  });

  it("participaciones de un fondo y acciones de una acción", () => {
    expect(formatParticipaciones("1234.56789", "FONDO")).toBe(`1234,56789${NBSP}part.`);
    expect(formatParticipaciones("12", "ACCION")).toBe(`12${NBSP}acc.`);
  });

  it("el cambio del BCE, unidades por euro", () => {
    expect(formatCambio("1.11770000", "USD")).toBe(`1${NBSP}€ = 1,1177${NBSP}$`);
  });
});

describe("valorEnCentimos", () => {
  it("participaciones × precio, exacto y redondeado al céntimo", () => {
    // 1234,56789 × 14,6592 = 18097,7775… → 18097,78 €
    expect(valorEnCentimos("1234.56789", "14.659200")).toBe(1_809_778);
    // La mitad exacta sube: 1 × 0,005 € = 0,5 céntimos → 1.
    expect(valorEnCentimos("1", "0.005")).toBe(1);
    expect(valorEnCentimos("1", "0.004999")).toBe(0);
  });

  it("divide entre el cambio cuando no cotiza en euros", () => {
    // 10 acciones × 350,50 $ / 1,1177 = 3135,90… €
    expect(valorEnCentimos("10", "350.5", "1.1177")).toBe(313_590);
  });

  it("null si algo no es un decimal o el cambio es cero", () => {
    expect(valorEnCentimos("1,5", "10")).toBeNull();
    expect(valorEnCentimos("1", "10", "0")).toBeNull();
  });
});

describe("aportadoHasta", () => {
  it("suma en céntimos lo aportado hasta la fecha incluida", () => {
    const aportes = [
      { fecha: "2026-01-10", cents: 40_000 },
      { fecha: "2026-03-01", cents: 12_345 },
      { fecha: "2026-05-01", cents: 1 },
    ];
    expect(aportadoHasta(aportes, "2026-03-01")).toBe(52_345);
    expect(aportadoHasta(aportes, "2025-12-31")).toBe(0);
  });
});
