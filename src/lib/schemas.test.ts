import { describe, expect, it } from "vitest";
import { transactionSchema } from "./schemas";

const traspaso = {
  type: "TRANSFER",
  amount_cents: "150,00",
  occurred_on: "2026-10-08",
  account_id: "11111111-1111-4111-8111-111111111111",
  to_account_id: "22222222-2222-4222-8222-222222222222",
  position_id: "33333333-3333-4333-8333-333333333333",
};

describe("transactionSchema · participaciones de una aportación", () => {
  it("las lee como decimal exacto en texto, con coma española", () => {
    const r = transactionSchema.safeParse({ ...traspaso, position_units: "1.234,567891" });
    expect(r.success && r.data.position_units).toBe("1234.567891");
  });

  it("vacío es null: se estimarán con el precio del día", () => {
    const r = transactionSchema.safeParse({ ...traspaso, position_units: "  " });
    expect(r.success && r.data.position_units).toBeNull();
    const sin = transactionSchema.safeParse(traspaso);
    expect(sin.success && sin.data.position_units).toBeNull();
  });

  it("rechaza lo ambiguo y lo que no va a una posición", () => {
    expect(transactionSchema.safeParse({ ...traspaso, position_units: "1.234" }).success).toBe(false);
    expect(
      transactionSchema.safeParse({ ...traspaso, position_id: null, position_units: "12,5" }).success,
    ).toBe(false);
  });
});
