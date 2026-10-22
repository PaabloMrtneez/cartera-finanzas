import { describe, expect, it } from "vitest";
import {
  type AccountDeletePreview,
  bloqueadaPorPrestamo,
  desgloseMovimientos,
  enumerar,
  fraseAtajo,
  fraseBorrado,
  frasePrestamos,
  fraseSaldo,
  frasesReembolsos,
  frasesTraspasos,
  nombreConfirma,
  parseAccountDeletePreview,
} from "./eliminar-cuenta";

/** Un preview como el que devuelve la base (el de la prueba de BD sembrada). */
const crudo = {
  account_id: "11111111-1111-1111-1111-111111111111",
  name: "Bróker Prueba",
  type: "INVERSION",
  archived: false,
  balance_cents: 8001,
  worth_cents: 20001,
  transactions: { total: 11, expenses: 5, incomes: 2, transfers: 4 },
  external_transfers: [
    {
      account_id: "22222222-2222-2222-2222-222222222222",
      name: "Revolut",
      archived: false,
      transfers: 4,
      balance_delta_cents: -30000,
    },
  ],
  cards: 2,
  positions: 1,
  valuations: 3,
  subscriptions: 1,
  recurring_incomes: 0,
  goals: 1,
  cross_reimbursements: {
    incomes_elsewhere: { count: 1, cents: 4000 },
    expenses_elsewhere: { count: 2, cents: 2550 },
  },
  shortcut_default: true,
  active_devices: 1,
};

const preview = parseAccountDeletePreview(crudo) as AccountDeletePreview;
// El € de Intl va tras un espacio duro.
const sinNbsp = (s: string | null) => s?.replace(/ /g, " ") ?? null;

describe("parseAccountDeletePreview", () => {
  it("acepta el JSON de la base", () => {
    expect(preview).not.toBeNull();
    expect(preview.external_transfers[0].balance_delta_cents).toBe(-30000);
  });

  it("rechaza cualquier importe con decimales: los céntimos son enteros", () => {
    expect(parseAccountDeletePreview({ ...crudo, balance_cents: 80.01 })).toBeNull();
    expect(
      parseAccountDeletePreview({
        ...crudo,
        external_transfers: [{ ...crudo.external_transfers[0], balance_delta_cents: -300.5 }],
      }),
    ).toBeNull();
  });

  it("rechaza formas inesperadas en vez de inventar recuentos", () => {
    expect(parseAccountDeletePreview(null)).toBeNull();
    expect(parseAccountDeletePreview({ ...crudo, cards: "2" })).toBeNull();
    expect(parseAccountDeletePreview({ ...crudo, type: "CREDITO" })).toBeNull();
    expect(parseAccountDeletePreview({ ...crudo, external_transfers: {} })).toBeNull();
  });
});

describe("nombreConfirma", () => {
  it("igual exacto tras quitar espacios de los extremos, como la base", () => {
    expect(nombreConfirma("Bróker Prueba", "Bróker Prueba")).toBe(true);
    expect(nombreConfirma("  Bróker Prueba ", "Bróker Prueba")).toBe(true);
  });
  it("mayúsculas, tildes y vacío no confirman", () => {
    expect(nombreConfirma("bróker prueba", "Bróker Prueba")).toBe(false);
    expect(nombreConfirma("Broker Prueba", "Bróker Prueba")).toBe(false);
    expect(nombreConfirma("   ", "   ")).toBe(false);
  });
});

describe("frases", () => {
  it("enumera en español", () => {
    expect(enumerar([])).toBe("");
    expect(enumerar(["a"])).toBe("a");
    expect(enumerar(["a", "b"])).toBe("a y b");
    expect(enumerar(["a", "b", "c"])).toBe("a, b y c");
  });

  it("qué se borra, con singulares y plurales", () => {
    expect(fraseBorrado(preview)).toBe(
      "Se borrarán 11 movimientos, 2 tarjetas, 1 posición con 3 valoraciones, 1 gasto fijo y 1 meta.",
    );
    expect(desgloseMovimientos(preview)).toMatch(
      /^Entre los movimientos: 5 gastos, 2 ingresos y 4 traspasos\./,
    );
  });

  it("sin nada colgado, solo se borra la cuenta", () => {
    const vacia = {
      ...preview,
      transactions: { total: 0, expenses: 0, incomes: 0, transfers: 0 },
      cards: 0,
      positions: 0,
      valuations: 0,
      subscriptions: 0,
      goals: 0,
    };
    expect(fraseBorrado(vacia)).toMatch(/solo se borrará la cuenta/);
    expect(desgloseMovimientos(vacia)).toBeNull();
  });

  it("los traspasos dicen cuánto sube o baja cada otra cuenta", () => {
    expect(frasesTraspasos(preview).map(sinNbsp)).toEqual([
      "El saldo de Revolut bajará 300,00 € (4 traspasos).",
    ]);
    const sube = {
      ...preview,
      external_transfers: [
        {
          ...preview.external_transfers[0],
          transfers: 1,
          balance_delta_cents: 12345,
        },
        {
          ...preview.external_transfers[0],
          name: "Caja",
          transfers: 2,
          balance_delta_cents: 0,
        },
      ],
    };
    expect(frasesTraspasos(sube).map(sinNbsp)).toEqual([
      "El saldo de Revolut subirá 123,45 € (1 traspaso).",
      "Se borrarán 2 traspasos con Caja; su saldo no cambia.",
    ]);
  });

  it("los reembolsos cruzados se avisan en los dos sentidos", () => {
    const [ingreso, gasto] = frasesReembolsos(preview).map(sinNbsp);
    expect(ingreso).toBe(
      "Un ingreso de otra cuenta (40,00 €) reembolsaba un gasto de esta: dejará de ser un reembolso y contará como ingreso.",
    );
    expect(gasto).toMatch(/^2 gastos de otras cuentas tenían su reembolso en esta \(25,50 € en total\)/);
  });

  it("el Atajo y el saldo", () => {
    expect(fraseAtajo(preview)).toMatch(/cuenta por defecto del Atajo/);
    expect(fraseAtajo({ ...preview, shortcut_default: false })).toBeNull();
    // En una cuenta de inversión manda el valor (caja + posiciones), no el saldo.
    expect(sinNbsp(fraseSaldo(preview))).toBe("Vale 200,01 €, que dejarán de contar en tu patrimonio.");
    expect(sinNbsp(fraseSaldo({ ...preview, type: "BANCO" }))).toBe(
      "Tiene 80,01 €, que dejarán de contar en tu patrimonio.",
    );
  });
});

describe("préstamos que usan la cuenta (B1)", () => {
  const prestamo = (role: "PAGO" | "PASIVO", name = "Hipoteca") => ({
    loan_id: "33333333-3333-3333-3333-333333333333",
    name,
    status: "ACTIVO",
    role,
  });

  it("sin el campo (base anterior a la migración): sin préstamos y nada bloquea", () => {
    expect(preview.loans).toEqual([]);
    expect(bloqueadaPorPrestamo(preview)).toBe(false);
    expect(frasePrestamos(preview)).toBeNull();
  });

  it("con un préstamo que paga desde ella: lo dice y bloquea", () => {
    const p = parseAccountDeletePreview({ ...crudo, loans: [prestamo("PAGO")] }) as AccountDeletePreview;
    expect(p.loans).toHaveLength(1);
    expect(bloqueadaPorPrestamo(p)).toBe(true);
    expect(frasePrestamos(p)).toBe(
      "El préstamo «Hipoteca» usa esta cuenta: no se puede eliminar mientras exista. Bórralo o cambia su cuenta de pago antes.",
    );
  });

  it("la cuenta-pasivo de dos préstamos: plural y «llevan su deuda»", () => {
    const p = parseAccountDeletePreview({
      ...crudo,
      loans: [prestamo("PASIVO", "Coche"), prestamo("PASIVO", "Moto")],
    }) as AccountDeletePreview;
    expect(frasePrestamos(p)).toMatch(
      /^Los préstamos «Coche» y «Moto» llevan su deuda en esta cuenta: no se puede eliminar mientras existan/,
    );
  });

  it("un papel desconocido invalida el preview entero", () => {
    expect(parseAccountDeletePreview({ ...crudo, loans: [{ ...prestamo("PAGO"), role: "OTRO" }] })).toBeNull();
    expect(parseAccountDeletePreview({ ...crudo, loans: "no" })).toBeNull();
  });
});
