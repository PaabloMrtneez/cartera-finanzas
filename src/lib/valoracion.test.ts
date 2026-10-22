import { describe, expect, it } from "vitest";
import { MINUS } from "./money";
import { applyPercent, baseDeValoracion, parsePercent } from "./valoracion";

describe("parsePercent", () => {
  it("lee enteros y decimales con coma o con punto, exactos", () => {
    expect(parsePercent("5")).toEqual({ n: 5, decimales: 0 });
    expect(parsePercent("5,2")).toEqual({ n: 52, decimales: 1 });
    expect(parsePercent("12,5")).toEqual({ n: 125, decimales: 1 });
    expect(parsePercent("+12.5")).toEqual({ n: 125, decimales: 1 });
    expect(parsePercent("0,01")).toEqual({ n: 1, decimales: 2 });
    expect(parsePercent(",5")).toEqual({ n: 5, decimales: 1 });
    expect(parsePercent("100")).toEqual({ n: 100, decimales: 0 });
  });

  it("acepta el menos de teclado y el tipográfico, y el % y los espacios", () => {
    expect(parsePercent("-3,25")).toEqual({ n: -325, decimales: 2 });
    expect(parsePercent(`${MINUS}3,25`)).toEqual({ n: -325, decimales: 2 });
    expect(parsePercent(" -3,25 % ")).toEqual({ n: -325, decimales: 2 });
  });

  it("«-0» es 0, no −0", () => {
    expect(parsePercent("-0")).toEqual({ n: 0, decimales: 0 });
  });

  it("no inventa nada con lo que no es un número limpio", () => {
    for (const malo of ["", " ", "-", ",", "abc", "5,2,1", "1.234,5", "1e3", "5 %%x", "--5"]) {
      expect(parsePercent(malo), malo).toBeNull();
    }
  });

  it("rechaza más de cuatro decimales y más de seis cifras enteras", () => {
    expect(parsePercent("5,1234")).toEqual({ n: 51234, decimales: 4 });
    expect(parsePercent("5,12345")).toBeNull();
    expect(parsePercent("1234567")).toBeNull();
  });
});

describe("applyPercent", () => {
  const pct = (texto: string) => {
    const p = parsePercent(texto);
    if (!p) throw new Error(`porcentaje inválido en la prueba: ${texto}`);
    return p;
  };

  it("12,5 %", () => {
    expect(applyPercent(100_000, pct("12,5"))).toBe(112_500);
    // 123,45 € × 1,125 = 138,88125 € → 138,88 €
    expect(applyPercent(12_345, pct("12,5"))).toBe(13_888);
  });

  it("−3,25 %", () => {
    expect(applyPercent(100_000, pct("-3,25"))).toBe(96_750);
    // 123,45 € × 0,9675 = 119,437875 € → 119,44 €
    expect(applyPercent(12_345, pct(`${MINUS}3,25`))).toBe(11_944);
  });

  it("0,01 %", () => {
    expect(applyPercent(100_000, pct("0,01"))).toBe(100_010);
    // 123,45 € × 1,0001 = 123,462345 € → 123,46 €
    expect(applyPercent(12_345, pct("0,01"))).toBe(12_346);
  });

  it("100 % dobla y −100 % deja a cero; por debajo de −100 % no hay valor", () => {
    expect(applyPercent(12_345, pct("100"))).toBe(24_690);
    expect(applyPercent(12_345, pct("-100"))).toBe(0);
    expect(applyPercent(12_345, pct("-100,01"))).toBeNull();
  });

  it("0 % deja la base tal cual", () => {
    expect(applyPercent(12_345, pct("0"))).toBe(12_345);
  });

  it("el empate exacto de medio céntimo sube (mitad hacia arriba)", () => {
    // 50,00 € × 1,0029 = 50,145 € exactos → 50,15 €.
    // Con coma flotante, Math.round(5000 * (1 + 0.29 / 100)) da 5014: el
    // binario guarda 1,0029 un pelo por debajo y el empate se va hacia abajo.
    // Es el fallo que motivó este módulo.
    expect(applyPercent(5_000, pct("0,29"))).toBe(5_015);
    expect(Math.round(5000 * (1 + 0.29 / 100))).toBe(5014);
    // 100,00 € × 1,01005 = 101,005 € → 101,01 € (la flotante da 101,00).
    expect(applyPercent(10_000, pct("1,005"))).toBe(10_101);
    // También con porcentaje negativo: 0,10 € × 0,95 = 0,095 € → 0,10 €.
    expect(applyPercent(10, pct("-5"))).toBe(10);
    // 0,05 € × 0,9 = 0,045 € → 0,05 €.
    expect(applyPercent(5, pct("-10"))).toBe(5);
  });

  it("bases grandes, sin perder un céntimo", () => {
    // 10.000 millones de euros × 1,123456 = exacto.
    expect(applyPercent(1_000_000_000_000, pct("12,3456"))).toBe(1_123_456_000_000);
    // El mayor entero seguro como base: base × numerador pasa de 2^53 y solo
    // sale bien porque el producto se hace en BigInt.
    expect(applyPercent(Number.MAX_SAFE_INTEGER, pct("0"))).toBe(Number.MAX_SAFE_INTEGER);
    expect(applyPercent(900_719_925_474_099, pct("0,0001"))).toBe(900_720_826_194_024);
    expect(applyPercent(900_719_925_474_099, pct("100"))).toBe(1_801_439_850_948_198);
  });

  it("devuelve null si el resultado no cabe en un entero seguro", () => {
    expect(applyPercent(Number.MAX_SAFE_INTEGER, pct("100"))).toBeNull();
  });

  it("rechaza una base que no es un entero de céntimos no negativo", () => {
    expect(applyPercent(-1, pct("5"))).toBeNull();
    expect(applyPercent(12.5, pct("5"))).toBeNull();
    expect(applyPercent(Number.NaN, pct("5"))).toBeNull();
  });
});

describe("baseDeValoracion", () => {
  const valoraciones = [
    { date: "2026-07-31", value_cents: 90_000 },
    { date: "2026-09-30", value_cents: 100_000 },
    { date: "2026-08-31", value_cents: 95_000 },
  ];
  const aportaciones = [
    { occurred_on: "2026-08-15", amount_cents: 1_000 }, // antes de la previa: ya está en ella
    { occurred_on: "2026-09-30", amount_cents: 2_000 }, // mismo día que la previa: incluida en ella
    { occurred_on: "2026-10-02", amount_cents: 50_000 }, // después: suma al coste
    { occurred_on: "2026-10-06", amount_cents: 7_000 }, // después de la fecha nueva: no
  ];

  it("parte de la última valoración de un mes anterior y suma lo aportado después, al coste", () => {
    expect(baseDeValoracion("2026-10-05", valoraciones, aportaciones)).toEqual({
      valorPrevio: 100_000,
      fechaPrevia: "2026-09-30",
      aportado: 50_000,
      base: 150_000,
    });
  });

  it("una aportación del mismo día que la valoración nueva cuenta como aportada", () => {
    expect(baseDeValoracion("2026-10-06", valoraciones, aportaciones)?.aportado).toBe(57_000);
  });

  it("no parte de una valoración del MISMO mes, que es la que se va a sustituir", () => {
    const conUnaDeOctubre = [...valoraciones, { date: "2026-10-03", value_cents: 999_999 }];
    // Corregir la de octubre tiene que dar lo mismo que valorarla la primera vez.
    expect(baseDeValoracion("2026-10-05", conUnaDeOctubre, aportaciones)).toEqual(
      baseDeValoracion("2026-10-05", valoraciones, aportaciones),
    );
  });

  it("al valorar un mes pasado, ignora las valoraciones posteriores", () => {
    expect(baseDeValoracion("2026-09-30", valoraciones, aportaciones)).toEqual({
      valorPrevio: 95_000,
      fechaPrevia: "2026-08-31",
      aportado: 2_000,
      base: 97_000,
    });
  });

  it("sin valoración de un mes anterior no hay base", () => {
    expect(baseDeValoracion("2026-07-31", valoraciones, aportaciones)).toBeNull();
    expect(baseDeValoracion("2026-10-05", [], aportaciones)).toBeNull();
  });

  it("y con el porcentaje aplicado: +5 % sobre lo que de verdad hay invertido", () => {
    const b = baseDeValoracion("2026-10-05", valoraciones, aportaciones);
    expect(b && applyPercent(b.base, { n: 5, decimales: 0 })).toBe(157_500);
  });
});
