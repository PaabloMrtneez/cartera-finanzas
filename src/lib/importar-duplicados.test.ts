import { describe, expect, it } from "vitest";
import type { FilaLeida } from "./csv";
import { contarDuplicadas, type Existente } from "./importar-duplicados";

const fila = (linea: number, amount_cents: number, description = "BUS", occurred_on = "2026-10-01"): FilaLeida => ({
  linea,
  occurred_on,
  description,
  amount_cents,
});
const guardado = (amount_cents: number, type: string, description = "BUS", occurred_on = "2026-10-01"): Existente => ({
  occurred_on,
  description,
  amount_cents,
  type,
});

describe("contarDuplicadas (H-10)", () => {
  it("dos cargos idénticos en el mismo fichero son dos gastos, no un duplicado", () => {
    const r = contarDuplicadas([fila(1, -150), fila(2, -150)], []);
    expect(r.nuevas).toHaveLength(2);
    expect(r.duplicadas).toBe(0);
  });

  it("cuenta ocurrencias contra la base: uno guardado y dos en el extracto → entra uno", () => {
    const r = contarDuplicadas([fila(1, -150), fila(2, -150)], [guardado(150, "EXPENSE")]);
    expect(r.nuevas.map((f) => f.linea)).toEqual([2]);
    expect(r.duplicadas).toBe(1);
  });

  it("si la base ya tiene tantos o más, no entra ninguno", () => {
    const r = contarDuplicadas([fila(1, -150)], [guardado(150, "EXPENSE"), guardado(150, "EXPENSE")]);
    expect(r.nuevas).toHaveLength(0);
    expect(r.duplicadas).toBe(1);
  });

  it("el tipo, el concepto, la fecha y el importe cuentan: un ingreso no es duplicado de un gasto", () => {
    const r = contarDuplicadas(
      [fila(1, 150), fila(2, -150, "TREN"), fila(3, -150, "BUS", "2026-10-02"), fila(4, -151)],
      [guardado(150, "EXPENSE"), guardado(150, "TRANSFER")],
    );
    expect(r.nuevas).toHaveLength(4);
    expect(r.duplicadas).toBe(0);
  });
});
