import { describe, expect, it } from "vitest";
import {
  type PositionDeletePreview,
  fraseBorradoFondo,
  frasePatrimonio,
  frasesSaldos,
  fraseValorFondo,
  nombreConfirma,
  parsePositionDeletePreview,
} from "./eliminar-fondo";

/** Un preview como el que devuelve la base (el de la prueba de BD sembrada). */
const crudo = {
  position_id: "11111111-1111-1111-1111-111111111111",
  name: "Fondo Índice Ñ",
  archived: false,
  follows_instrument: true,
  account_id: "22222222-2222-2222-2222-222222222222",
  account_name: "MyInvestor",
  value_cents: 330000,
  valuations: 2,
  unit_events: 2,
  contributions: { count: 3, cents: 352000, discarded: 1 },
  balance_effects: [
    {
      account_id: "a",
      name: "BBVA Nómina",
      archived: false,
      transfers: 2,
      balance_delta_cents: 298000,
    },
    {
      account_id: "b",
      name: "Hucha",
      archived: false,
      transfers: 1,
      balance_delta_cents: 50000,
    },
    {
      account_id: "c",
      name: "MyInvestor",
      archived: false,
      transfers: 3,
      balance_delta_cents: -348000,
    },
  ],
  net_worth_delta_cents: 22000,
};

const preview = parsePositionDeletePreview(crudo) as PositionDeletePreview;
// El € de Intl va tras un espacio duro.
const sinNbsp = (s: string | null) => s?.replace(/[  ]/g, " ") ?? null;

describe("parsePositionDeletePreview", () => {
  it("acepta el JSON de la base", () => {
    expect(preview).not.toBeNull();
    expect(preview.contributions.cents).toBe(352000);
    expect(preview.balance_effects[2].balance_delta_cents).toBe(-348000);
  });

  it("rechaza cualquier importe con decimales: los céntimos son enteros", () => {
    expect(parsePositionDeletePreview({ ...crudo, value_cents: 3300.5 })).toBeNull();
    expect(
      parsePositionDeletePreview({
        ...crudo,
        contributions: { ...crudo.contributions, cents: 3520.01 },
      }),
    ).toBeNull();
    expect(
      parsePositionDeletePreview({
        ...crudo,
        balance_effects: [{ ...crudo.balance_effects[0], balance_delta_cents: 2980.5 }],
      }),
    ).toBeNull();
    expect(parsePositionDeletePreview({ ...crudo, net_worth_delta_cents: 0.1 })).toBeNull();
  });

  it("rechaza formas inesperadas en vez de inventar cifras", () => {
    expect(parsePositionDeletePreview(null)).toBeNull();
    expect(parsePositionDeletePreview([])).toBeNull();
    expect(parsePositionDeletePreview({ ...crudo, valuations: "2" })).toBeNull();
    expect(parsePositionDeletePreview({ ...crudo, balance_effects: {} })).toBeNull();
    expect(parsePositionDeletePreview({ ...crudo, follows_instrument: "sí" })).toBeNull();
    expect(parsePositionDeletePreview({ ...crudo, contributions: undefined })).toBeNull();
  });
});

describe("nombreConfirma", () => {
  it("igual exacto tras quitar espacios de los extremos, como la base", () => {
    expect(nombreConfirma("Fondo Índice Ñ", "Fondo Índice Ñ")).toBe(true);
    expect(nombreConfirma("  Fondo Índice Ñ ", "Fondo Índice Ñ")).toBe(true);
  });
  it("mayúsculas, tildes y vacío no confirman", () => {
    expect(nombreConfirma("fondo índice ñ", "Fondo Índice Ñ")).toBe(false);
    expect(nombreConfirma("Fondo Indice Ñ", "Fondo Índice Ñ")).toBe(false);
    expect(nombreConfirma("", "Fondo Índice Ñ")).toBe(false);
  });
});

describe("frases", () => {
  it("qué se borra, con singulares, plurales y el importe aportado", () => {
    expect(sinNbsp(fraseBorradoFondo(preview))).toBe(
      "Se borrarán 2 valoraciones, 2 registros de participaciones, 3 aportaciones (3520,00 €) y 1 aportación descartada.",
    );
    const una = {
      ...preview,
      valuations: 1,
      unit_events: 0,
      contributions: { count: 1, cents: 300000, discarded: 0 },
    };
    expect(sinNbsp(fraseBorradoFondo(una))).toBe("Se borrarán 1 valoración y 1 aportación (3000,00 €).");
  });

  it("sin nada colgado, solo se borra el fondo", () => {
    const vacio = {
      ...preview,
      valuations: 0,
      unit_events: 0,
      contributions: { count: 0, cents: 0, discarded: 0 },
      balance_effects: [],
    };
    expect(fraseBorradoFondo(vacio)).toMatch(/solo se borrará el fondo/);
    expect(frasesSaldos(vacio)).toEqual([]);
  });

  it("cada cuenta dice cuánto sube o baja su saldo", () => {
    expect(frasesSaldos(preview).map(sinNbsp)).toEqual([
      "El saldo de BBVA Nómina subirá 2980,00 €.",
      "El saldo de Hucha subirá 500,00 €.",
      "El saldo de MyInvestor bajará 3480,00 €.",
    ]);
    const conCero = {
      ...preview,
      balance_effects: [{ ...preview.balance_effects[0], balance_delta_cents: 0 }],
    };
    expect(frasesSaldos(conCero)).toEqual([]);
  });

  it("el patrimonio sube, baja o no cambia", () => {
    expect(sinNbsp(frasePatrimonio(preview))).toMatch(/^Tu patrimonio subirá 220,00 €/);
    expect(sinNbsp(frasePatrimonio({ ...preview, net_worth_delta_cents: -12345 }))).toMatch(
      /^Tu patrimonio bajará 123,45 €: el fondo vale más/,
    );
    expect(frasePatrimonio({ ...preview, net_worth_delta_cents: 0 })).toMatch(/no cambia/);
    expect(
      frasePatrimonio({
        ...preview,
        archived: true,
        net_worth_delta_cents: 352000,
      }),
    ).toMatch(/archivado ya no contaba/);
  });

  it("el valor que deja de contar", () => {
    expect(sinNbsp(fraseValorFondo(preview))).toBe("Vale 3300,00 €, que dejarán de contar en tu patrimonio.");
    expect(fraseValorFondo({ ...preview, archived: true })).toMatch(/ya no contaba/);
  });
});
