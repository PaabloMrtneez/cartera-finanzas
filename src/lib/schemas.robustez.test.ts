import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  accountDeleteSchema,
  accountSchema,
  ajustarParticipacionesSchema,
  amountCents,
  buscarInstrumentosSchema,
  cardSchema,
  categorySchema,
  dejarDeSeguirSchema,
  firstIssue,
  loanCreateSchema,
  loanDeleteSchema,
  loanPreviewSchema,
  loanSettleSchema,
  loanUpdateSchema,
  loanPrepaymentSchema,
  merchantRuleSchema,
  participacionesAportacionSchema,
  positionDeleteSchema,
  positiveAmountCents,
  seguirInstrumentoSchema,
  transactionSchema,
} from "./schemas";

/**
 * Validación de entradas de las server actions (fase 1: robustez). Un cliente
 * manipulado puede mandar CUALQUIER cosa en un FormData o en los argumentos de
 * una acción. Aquí se comprueba, para cada esquema Zod:
 *
 *   1. que con entradas hostiles (vacías, enormes, NaN, Infinity, 10 000
 *      caracteres, fechas imposibles, ids que no son uuid…) `safeParse` NUNCA
 *      lanza: siempre devuelve éxito o un error que se puede enseñar;
 *   2. que el mensaje que llega a la persona está en español.
 *
 * Los `it.fails` son fallos reales documentados en docs/pruebas/informe-robustez.md.
 */

const SEMILLA = { seed: 20261019, numRuns: 400 };
const UUID = "6f1c1b7e-4a7a-4c1e-9b1a-1a2b3c4d5e6f";
const UUID2 = "0b8f3a0e-2b1c-4d5e-8f9a-112233445566";

/** Valores hostiles que puede colar un cliente manipulado. */
const hostil = fc.oneof(
  fc.constantFrom<unknown>(
    "",
    " ",
    "\u0000",
    "x".repeat(10_000),
    "9".repeat(400),
    "NaN",
    "Infinity",
    "-Infinity",
    "-1",
    "1e308",
    "2026-02-30",
    "2026-13-45",
    "0000-00-00",
    "99:99",
    "no-es-un-uuid",
    "<script>alert(1)</script>",
    "'; drop table transaction; --",
    "🙂",
    null,
    undefined,
    NaN,
    Infinity,
    -1,
    0,
    1.5,
    true,
    {},
    [],
  ),
  fc.string({ maxLength: 30 }),
  fc.double(),
);

/** Un objeto con las claves del esquema y valores hostiles en todas ellas. */
function objetoHostil(claves: string[]) {
  return fc.record(Object.fromEntries(claves.map((k) => [k, hostil])) as Record<string, fc.Arbitrary<unknown>>);
}

/** ¿El mensaje parece el inglés por defecto de Zod en lugar de uno nuestro? */
function esInglesDeZod(mensaje: string): boolean {
  return /\b(Invalid|Expected|expected|Too (big|small)|must|received|Required|Unrecognized)\b/.test(mensaje);
}

type Caso = { nombre: string; esquema: z.ZodType; claves: string[] };

const CASOS: Caso[] = [
  { nombre: "accountSchema", esquema: accountSchema, claves: ["name", "type", "initial_balance_cents", "color"] },
  { nombre: "accountDeleteSchema", esquema: accountDeleteSchema, claves: ["id", "confirm_name"] },
  { nombre: "positionDeleteSchema", esquema: positionDeleteSchema, claves: ["id", "confirm_name"] },
  { nombre: "cardSchema", esquema: cardSchema, claves: ["account_id", "last4", "type", "nickname"] },
  { nombre: "categorySchema", esquema: categorySchema, claves: ["name", "type", "color", "icon"] },
  { nombre: "merchantRuleSchema", esquema: merchantRuleSchema, claves: ["match_text", "category_id", "apply_retroactively"] },
  {
    nombre: "transactionSchema",
    esquema: transactionSchema,
    claves: [
      "type",
      "amount_cents",
      "description",
      "occurred_on",
      "occurred_time",
      "account_id",
      "to_account_id",
      "category_id",
      "note",
      "reimburses_id",
      "position_id",
      "position_units",
    ],
  },
  { nombre: "buscarInstrumentosSchema", esquema: buscarInstrumentosSchema, claves: ["q"] },
  {
    nombre: "seguirInstrumentoSchema",
    esquema: seguirInstrumentoSchema,
    claves: ["position_id", "nueva", "simbolo", "isin", "participaciones", "aportado", "fecha"],
  },
  { nombre: "ajustarParticipacionesSchema", esquema: ajustarParticipacionesSchema, claves: ["position_id", "participaciones", "fecha", "nota"] },
  { nombre: "dejarDeSeguirSchema", esquema: dejarDeSeguirSchema, claves: ["position_id", "fecha"] },
  { nombre: "participacionesAportacionSchema", esquema: participacionesAportacionSchema, claves: ["transaction_id", "participaciones"] },
  {
    nombre: "loanPreviewSchema",
    esquema: loanPreviewSchema,
    claves: ["principal_cents", "term_months", "tin", "fee_mode", "fee", "charge_day", "start_on", "first_charge_on", "disbursed"],
  },
  { nombre: "loanCreateSchema", esquema: loanCreateSchema, claves: ["name", "tae", "category_id", "counts_full_installment", "terms"] },
  { nombre: "loanUpdateSchema", esquema: loanUpdateSchema, claves: ["id", "name", "tae", "category_id", "counts_full_installment"] },
  { nombre: "loanSettleSchema", esquema: loanSettleSchema, claves: ["id", "on", "fee_cents"] },
  { nombre: "loanPrepaymentSchema", esquema: loanPrepaymentSchema, claves: ["id", "on", "amount_cents", "mode", "fee_cents"] },
  { nombre: "loanDeleteSchema", esquema: loanDeleteSchema, claves: ["id", "confirm_name"] },
];

describe("todos los esquemas: con entradas hostiles nunca lanzan", () => {
  for (const { nombre, esquema, claves } of CASOS) {
    it(`${nombre}: safeParse devuelve éxito o un error con mensaje, nunca una excepción`, () => {
      fc.assert(
        fc.property(fc.oneof(objetoHostil(claves), hostil), (entrada) => {
          const r = esquema.safeParse(entrada);
          if (!r.success) expect(firstIssue(r.error).length).toBeGreaterThan(0);
        }),
        SEMILLA,
      );
    });
  }
});

describe("mensajes: lo que ve la persona está en español", () => {
  /** El primer mensaje de error para una entrada concreta. */
  const mensaje = (esquema: z.ZodType, entrada: unknown) => {
    const r = esquema.safeParse(entrada);
    expect(r.success).toBe(false);
    return firstIssue((r as { error: z.ZodError }).error);
  };

  const movimientoValido = {
    type: "EXPENSE",
    amount_cents: "12,40",
    occurred_on: "2026-10-19",
    account_id: UUID,
  };

  it("los campos con mensaje propio responden en español", () => {
    for (const [esquema, entrada] of [
      [transactionSchema, { ...movimientoValido, amount_cents: "abc" }],
      [transactionSchema, { ...movimientoValido, amount_cents: "-5" }],
      [transactionSchema, { ...movimientoValido, occurred_on: "ayer" }],
      [transactionSchema, { ...movimientoValido, account_id: "1" }],
      [accountSchema, { name: "x".repeat(10_000), type: "BANCO", initial_balance_cents: "0", color: "#000000" }],
      [accountDeleteSchema, { id: "no-uuid", confirm_name: "x" }],
      [loanPreviewSchema, { principal_cents: "1000", term_months: "NaN", tin: "5", start_on: "2026-10-01", disbursed: true }],
      [loanPreviewSchema, { principal_cents: "1000", term_months: "Infinity", tin: "5", start_on: "2026-10-01", disbursed: true }],
    ] as Array<[z.ZodType, unknown]>) {
      expect(esInglesDeZod(mensaje(esquema, entrada))).toBe(false);
    }
  });

  // H-11: varios campos no llevan mensaje propio y Zod responde en INGLÉS
  // («Invalid option: expected one of…», «Too big: expected string to have
  // <=200 characters»…). Lo ve quien manda un formulario raro o un cliente
  // desactualizado, y la app entera está en español.
  it("transactionSchema: tipo desconocido, descripción de 10 000 caracteres, nota larga, hora o destino raros → en español", () => {
    for (const entrada of [
      { ...movimientoValido, type: "GASTO" },
      { ...movimientoValido, description: "x".repeat(10_000) },
      { ...movimientoValido, note: "x".repeat(501) },
      { ...movimientoValido, occurred_time: "mediodía" },
      { ...movimientoValido, type: "TRANSFER", to_account_id: "no-uuid" },
      { ...movimientoValido, category_id: "no-uuid" },
    ]) {
      expect(esInglesDeZod(mensaje(transactionSchema, entrada))).toBe(false);
    }
  });

  it("categorySchema y cardSchema: tipo desconocido o icono vacío → en español", () => {
    expect(esInglesDeZod(mensaje(categorySchema, { name: "Casa", type: "OTRO", color: "#000000", icon: "x" }))).toBe(false);
    expect(esInglesDeZod(mensaje(categorySchema, { name: "Casa", type: "EXPENSE", color: "#000000", icon: "" }))).toBe(false);
    expect(esInglesDeZod(mensaje(cardSchema, { account_id: UUID, last4: "1234", type: "AMEX" }))).toBe(false);
  });
});

describe("límites que hoy se cuelan hasta la base", () => {
  const movimiento = (cambios: Record<string, unknown>) =>
    transactionSchema.safeParse({
      type: "EXPENSE",
      amount_cents: "12,40",
      occurred_on: "2026-10-19",
      account_id: UUID,
      ...cambios,
    });

  it("lo que sí se para: importes no positivos, ids que no son uuid, traspaso a sí mismo", () => {
    expect(movimiento({ amount_cents: "0" }).success).toBe(false);
    expect(movimiento({ amount_cents: "-12,40" }).success).toBe(false);
    expect(movimiento({ amount_cents: "9".repeat(20) }).success).toBe(false); // no cabe en un entero seguro
    expect(movimiento({ account_id: "1" }).success).toBe(false);
    expect(movimiento({ type: "TRANSFER", to_account_id: UUID }).success).toBe(false);
    expect(movimiento({ type: "TRANSFER", to_account_id: UUID2 }).success).toBe(true);
    expect(movimiento({ reimburses_id: UUID2 }).success).toBe(false); // solo un ingreso reembolsa
  });

  // H-12: `isoDate` solo mira el formato. El 30 de febrero llega a Postgres, que
  // responde con un error en inglés que la acción enseña tal cual.
  it("una fecha imposible (2026-02-30, 2026-13-45) se rechaza en el esquema", () => {
    expect(movimiento({ occurred_on: "2026-02-30" }).success).toBe(false);
    expect(movimiento({ occurred_on: "2026-13-45" }).success).toBe(false);
  });

  it("una hora imposible (99:99) se rechaza en el esquema", () => {
    expect(movimiento({ occurred_time: "99:99" }).success).toBe(false);
  });

  // H-13: el tope de la base (`tx_amount_positive`: ≤ 1.000 M€) no está en el
  // esquema, y la acción traduce ese CHECK como «tiene que ser mayor que cero».
  it("un importe por encima del tope de la base (1.000 M€) se rechaza en el esquema", () => {
    expect(positiveAmountCents.safeParse("1.000.000.000,01").success).toBe(false);
    // El tope exacto sí cabe: es el de los CHECK de 20261020090600_topes_de_importe.sql
    // (fijos, metas, límites y valoraciones usan este mismo esquema).
    expect(positiveAmountCents.safeParse("1.000.000.000,00").success).toBe(true);
    expect(amountCents.safeParse("-1.000.000.000,01").success).toBe(false);
  });

  it("amountCents con 10 000 caracteres: error, no excepción ni importe inventado", () => {
    expect(amountCents.safeParse("1".repeat(10_000)).success).toBe(false);
  });

  // Bajo: `z.coerce.number` acepta notación científica y hexadecimal.
  it("el plazo de un préstamo solo admite dígitos («1e2», «0x10» no son meses)", () => {
    const base = { principal_cents: "10000", tin: "5", start_on: "2026-10-01", disbursed: true };
    expect(loanPreviewSchema.safeParse({ ...base, term_months: "1e2" }).success).toBe(false);
    expect(loanPreviewSchema.safeParse({ ...base, term_months: "0x10" }).success).toBe(false);
  });

  // Con una fecha de inicio imposible, la primera cuota por defecto se calcula
  // con un mes 13 y sale una fecha «válida» de otro año: el error lo da la base.
  it("un préstamo con fecha de inicio imposible se rechaza en el esquema", () => {
    const r = loanPreviewSchema.safeParse({
      principal_cents: "10000",
      term_months: "12",
      tin: "5",
      start_on: "2026-13-45",
      disbursed: true,
    });
    expect(r.success).toBe(false);
  });

  it("la comisión en % se redondea al céntimo y no puede comerse el principal", () => {
    const base = { principal_cents: "10000,00", term_months: "12", tin: "5", start_on: "2026-10-01", disbursed: true };
    const r = loanPreviewSchema.safeParse({ ...base, fee_mode: "PORCENTAJE", fee: "1,255" });
    expect(r.success && r.data.opening_fee_cents).toBe(12_550);
    expect(loanPreviewSchema.safeParse({ ...base, fee_mode: "PORCENTAJE", fee: "100" }).success).toBe(false);
    expect(loanPreviewSchema.safeParse({ ...base, fee: "-5" }).success).toBe(false);
  });

  it("fechas: el día de cobro va de 1 a 28 y la primera cuota cae en él y después del inicio", () => {
    const base = { principal_cents: "10000", term_months: "12", tin: "5", start_on: "2026-10-01", disbursed: true };
    expect(loanPreviewSchema.safeParse({ ...base, charge_day: "31" }).success).toBe(false);
    expect(loanPreviewSchema.safeParse({ ...base, charge_day: "5", first_charge_on: "2026-11-06" }).success).toBe(false);
    expect(loanPreviewSchema.safeParse({ ...base, first_charge_on: "2026-10-01" }).success).toBe(false);
  });
});
