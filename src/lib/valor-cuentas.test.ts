import { describe, expect, it } from "vitest";
import { explicacionValor, totalPorMes, valorDeCadaCuenta, valoresPorCuenta } from "./valor-cuentas";

const BANCO = "11111111-1111-1111-1111-111111111111";
const BROKER = "22222222-2222-2222-2222-222222222222";

describe("valoresPorCuenta", () => {
  it("una cuenta de inversión sin efectivo vale lo que sus fondos, no su saldo 0", () => {
    // El caso del bug: fondos dados de alta con lo ya aportado fuera de la app.
    const v = valoresPorCuenta(
      [
        { account_id: BANCO, balance_cents: 250000 },
        { account_id: BROKER, balance_cents: 0 },
      ],
      [
        { account_id: BANCO, worth_cents: 250000 },
        { account_id: BROKER, worth_cents: 133878 },
      ],
      [
        { account_id: BROKER, value_cents: 80000 },
        { account_id: BROKER, value_cents: 53878 },
      ],
    );
    expect(v.get(BROKER)).toEqual({
      valorCents: 133878,
      fondos: 2,
      enFondosCents: 133878,
      sinInvertirCents: 0,
    });
    expect(v.get(BANCO)).toEqual({
      valorCents: 250000,
      fondos: 0,
      enFondosCents: 0,
      sinInvertirCents: 250000,
    });
  });

  it("separa el efectivo sin invertir del valor de los fondos", () => {
    const v = valoresPorCuenta(
      [{ account_id: BROKER, balance_cents: 612000 }],
      [{ account_id: BROKER, worth_cents: 650000 }],
      [{ account_id: BROKER, value_cents: 638000 }],
    );
    expect(v.get(BROKER)?.sinInvertirCents).toBe(12000);
  });

  it("sin fila de valor, se queda con el saldo", () => {
    const v = valoresPorCuenta([{ account_id: BANCO, balance_cents: -1500 }], [], []);
    expect(v.get(BANCO)?.valorCents).toBe(-1500);
  });
});

describe("valorDeCadaCuenta", () => {
  it("lee el valor de la vista tal cual, sin recalcular lo aportado", () => {
    // Saldo 612000 con 650000 de valor: la vista ya ha descontado lo traspasado
    // a TODOS los fondos (también a uno archivado) y sumado los activos. Aquí
    // no se vuelve a hacer esa cuenta: la cifra es la de la vista.
    const v = valorDeCadaCuenta(
      [
        { account_id: BANCO, balance_cents: -1500 },
        { account_id: BROKER, balance_cents: 612000 },
      ],
      [
        { account_id: BANCO, worth_cents: -1500 },
        { account_id: BROKER, worth_cents: 650000 },
      ],
    );
    expect(v.get(BROKER)).toBe(650000);
    expect(v.get(BANCO)).toBe(-1500);
    // La suma de las filas es la suma de la vista: lo que da v_net_worth.
    expect([...v.values()].reduce((a, b) => a + b, 0)).toBe(648500);
  });

  it("sin fila de valor, se queda con el saldo", () => {
    expect(valorDeCadaCuenta([{ account_id: BANCO, balance_cents: 900 }], []).get(BANCO)).toBe(900);
  });
});

describe("explicacionValor", () => {
  const base = { valorCents: 0, fondos: 0, enFondosCents: 0, sinInvertirCents: 0 };

  it("sin fondos no explica nada: la cifra es el saldo", () => {
    expect(explicacionValor({ ...base, valorCents: 1000, sinInvertirCents: 1000 })).toBeNull();
  });

  it("singular y plural", () => {
    expect(explicacionValor({ ...base, fondos: 1 })?.que).toBe("Valor de su fondo");
    expect(explicacionValor({ ...base, fondos: 2 })?.que).toBe("Valor de 2 fondos");
  });

  it("menciona el efectivo sin invertir solo si lo hay", () => {
    expect(explicacionValor({ ...base, fondos: 2 })?.sinInvertir).toBeNull();
    expect(explicacionValor({ ...base, fondos: 2, sinInvertirCents: 12000 })?.sinInvertir).toBe(
      "Incluye 120,00 € sin invertir",
    );
  });

  it("un saldo negativo no se llama «sin invertir»", () => {
    const texto = explicacionValor({ ...base, fondos: 1, sinInvertirCents: -500 })?.sinInvertir;
    expect(texto).toMatch(/^Incluye un saldo de /);
  });
});

describe("totalPorMes", () => {
  it("suma el valor de las activas por mes, en orden, y se queda con los últimos", () => {
    const filas = [
      { archived: false, period_month: "2026-09-01", worth_cents: 100 },
      { archived: false, period_month: "2026-08-01", worth_cents: 10 },
      { archived: true, period_month: "2026-09-01", worth_cents: 99999 },
      { archived: false, period_month: "2026-09-01", worth_cents: 133878 },
      { archived: false, period_month: "2026-10-01", worth_cents: 7 },
      { archived: false, period_month: "2026-07-01", worth_cents: 1 },
    ];
    expect(totalPorMes(filas, 3)).toEqual([
      { period_month: "2026-08-01", cents: 10 },
      { period_month: "2026-09-01", cents: 133978 },
      { period_month: "2026-10-01", cents: 7 },
    ]);
  });
});
