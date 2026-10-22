import { describe, expect, it } from "vitest";
import {
  MINUS,
  NBSP,
  formatCents,
  formatCentsPlain,
  formatCentsRounded,
  formatPercent,
  formatShare,
  formatSignedCents,
  parseAmountToCents,
  percentChange,
} from "./money";

describe("formatCents", () => {
  it("usa coma decimal y espacio duro antes del símbolo", () => {
    expect(formatCents(48735)).toBe(`487,35${NBSP}€`);
  });

  it("no agrupa los millares hasta los 5 dígitos, como manda el es-ES", () => {
    // Estos dos conviven en el prototipo y no es una incoherencia:
    // en español no se separan los números de cuatro cifras.
    expect(formatCents(980000)).toBe(`9800,00${NBSP}€`);
    expect(formatCents(1337455)).toBe(`13.374,55${NBSP}€`);
  });

  it("pinta el patrimonio del prototipo tal cual", () => {
    expect(formatCents(1423855)).toBe(`14.238,55${NBSP}€`);
  });

  it("mantiene los dos decimales en cifras redondas", () => {
    expect(formatCents(0)).toBe(`0,00${NBSP}€`);
    expect(formatCents(200000)).toBe(`2000,00${NBSP}€`);
  });

  it("acepta negativos, que es como está una tarjeta de crédito", () => {
    expect(formatCents(-43200)).toBe(`-432,00${NBSP}€`);
  });
});

describe("formatCentsRounded", () => {
  it("quita los céntimos", () => {
    expect(formatCentsRounded(1423855)).toBe(`14.239${NBSP}€`);
    expect(formatCentsRounded(48735)).toBe(`487${NBSP}€`);
  });
});

describe("formatCentsPlain", () => {
  it("no lleva símbolo, para los campos de formulario", () => {
    expect(formatCentsPlain(4320)).toBe("43,20");
    expect(formatCentsPlain(1337455)).toBe("13.374,55");
  });
});

describe("formatSignedCents", () => {
  it("el signo lo pone el tipo, no el importe guardado", () => {
    expect(formatSignedCents(4320, "EXPENSE")).toBe(`-43,20${NBSP}€`);
    expect(formatSignedCents(8000, "INCOME")).toBe(`+80,00${NBSP}€`);
  });

  it("un traspaso no lleva signo: no es ni gasto ni ingreso", () => {
    expect(formatSignedCents(20000, "TRANSFER")).toBe(`200,00${NBSP}€`);
  });

  it("ignora el signo del importe y usa siempre el del tipo", () => {
    expect(formatSignedCents(-4320, "EXPENSE")).toBe(`-43,20${NBSP}€`);
  });
});

describe("parseAmountToCents", () => {
  it("interpreta la coma como decimal, que es lo que escribe una persona aquí", () => {
    expect(parseAmountToCents("43,20")).toBe(4320);
    expect(parseAmountToCents("23,45")).toBe(2345);
    expect(parseAmountToCents("80,00")).toBe(8000);
  });

  it("entiende el punto como millares cuando le siguen tres cifras", () => {
    expect(parseAmountToCents("1.234")).toBe(123400);
    expect(parseAmountToCents("1.234,56")).toBe(123456);
    expect(parseAmountToCents("13.374,55")).toBe(1337455);
  });

  it("entiende el punto como decimal cuando le siguen una o dos cifras", () => {
    // Es lo que manda un iPhone configurado en inglés.
    expect(parseAmountToCents("23.45")).toBe(2345);
    expect(parseAmountToCents("1234.5")).toBe(123450);
  });

  it("completa un solo decimal a dos", () => {
    expect(parseAmountToCents("5,5")).toBe(550);
  });

  it("acepta enteros sin decimales", () => {
    expect(parseAmountToCents("23")).toBe(2300);
  });

  it("se quita de encima símbolos y espacios, incluido el duro de Intl", () => {
    expect(parseAmountToCents("23,45 €")).toBe(2345);
    expect(parseAmountToCents(`23,45${NBSP}€`)).toBe(2345);
    expect(parseAmountToCents("  EUR 23,45  ")).toBe(2345);
  });

  it("entiende los dos menos, el normal y el tipográfico", () => {
    expect(parseAmountToCents("-23,45")).toBe(-2345);
    expect(parseAmountToCents(`${MINUS}23,45`)).toBe(-2345);
  });

  it("devuelve null antes que inventarse un importe", () => {
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("   ")).toBeNull();
    expect(parseAmountToCents("no es un importe")).toBeNull();
    expect(parseAmountToCents("€")).toBeNull();
  });

  it("no pierde precisión con importes grandes", () => {
    expect(parseAmountToCents("999.999,99")).toBe(99999999);
  });

  it("el signo vale delante (también tras el símbolo), detrás o entre paréntesis", () => {
    expect(parseAmountToCents("€ -45,00")).toBe(-4500);
    expect(parseAmountToCents("-€45")).toBe(-4500);
    expect(parseAmountToCents("45,00-")).toBe(-4500);
    expect(parseAmountToCents("45,00 €-")).toBe(-4500);
    expect(parseAmountToCents("(45,00)")).toBe(-4500);
    expect(parseAmountToCents("(45,00 €)")).toBe(-4500);
    expect(parseAmountToCents("+45,00")).toBe(4500);
  });

  it("dos signos o un menos entre cifras no se adivinan", () => {
    expect(parseAmountToCents("-45,00-")).toBeNull();
    expect(parseAmountToCents("(-45,00)")).toBeNull();
    expect(parseAmountToCents("4-5")).toBeNull();
    expect(parseAmountToCents("--5")).toBeNull();
  });

  it("más de dos decimales no se leen como millares", () => {
    expect(parseAmountToCents("0,295")).toBeNull();
    expect(parseAmountToCents("0.295")).toBeNull();
    expect(parseAmountToCents("12,3456")).toBeNull();
    expect(parseAmountToCents("1234,567")).toBeNull();
    expect(parseAmountToCents("1.234,567")).toBeNull();
    expect(parseAmountToCents("1.234.56")).toBeNull();
  });

  it("millares bien agrupados con punto, coma, espacio o apóstrofo", () => {
    expect(parseAmountToCents("1.234.567")).toBe(123456700);
    expect(parseAmountToCents("1,234,567.89")).toBe(123456789);
    expect(parseAmountToCents("1 234,56")).toBe(123456);
    expect(parseAmountToCents("1'234.56")).toBe(123456);
    expect(parseAmountToCents("12 34")).toBeNull();
  });

  it("letras o exponentes entre las cifras son null", () => {
    expect(parseAmountToCents("1e5")).toBeNull();
    expect(parseAmountToCents("2x 3,50")).toBeNull();
    expect(parseAmountToCents("USD 3,50")).toBeNull();
    expect(parseAmountToCents("23,45EUR")).toBe(2345);
  });

  it("menos cero es cero", () => {
    expect(Object.is(parseAmountToCents("-0,00"), 0)).toBe(true);
  });
});

describe("formatPercent", () => {
  it("fuerza el signo y usa el menos tipográfico", () => {
    expect(formatPercent(6)).toBe(`+6,0${NBSP}%`);
    expect(formatPercent(-6)).toBe(`${MINUS}6,0${NBSP}%`);
  });

  it("devuelve una raya cuando no hay con qué comparar", () => {
    expect(formatPercent(null)).toBe("—");
  });
});

describe("formatShare", () => {
  it("no fuerza signo: un reparto siempre es positivo", () => {
    expect(formatShare(38)).toBe(`38${NBSP}%`);
    expect(formatShare(50, 1)).toBe(`50,0${NBSP}%`);
  });
});

describe("percentChange", () => {
  it("calcula la variación contra el periodo anterior", () => {
    // El ejemplo de la tabla comparativa del prototipo: 56,00 → 96,50.
    expect(percentChange(9650, 5600)).toBeCloseTo(72.32, 2);
  });

  it("no divide entre cero: devuelve null", () => {
    expect(percentChange(100, 0)).toBeNull();
  });
});
