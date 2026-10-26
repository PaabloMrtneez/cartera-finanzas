import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR_GENERICO, NO_ENCONTRADO, exigirLecturas, mensajeErrorDb } from "./errores-db";

afterEach(() => vi.restoreAllMocks());

describe("mensajeErrorDb", () => {
  it("las traducciones propias de la acción mandan", () => {
    expect(
      mensajeErrorDb({ message: 'violates check constraint "tx_date_sane"' }, [[/tx_date_sane/, "Fecha fuera de lo razonable."]]),
    ).toBe("Fecha fuera de lo razonable.");
  });

  it("los mensajes en español de nuestras funciones SQL pasan tal cual", () => {
    const m = "Este préstamo ya tiene cuotas cobradas: sus condiciones no se pueden cambiar";
    expect(mensajeErrorDb({ message: m, code: "23514" })).toBe(m);
    expect(mensajeErrorDb("El nombre no coincide con el de la cuenta")).toBe("El nombre no coincide con el de la cuenta");
  });

  it("los reembolsos (55000, 23514) traen su mensaje de la base y no se pisan, ni con traducciones propias", () => {
    const propias: Array<[RegExp, string]> = [[/23514|check/i, "Otra cosa"]];
    for (const [message, code] of [
      ["Este gasto tiene un reembolso (12,40 €). Bórralos o quítales el enlace antes de borrar el gasto: si no, ese dinero pasaría a contar como ingreso.", "55000"],
      ["Un reembolso no puede ser mayor que el gasto que reembolsa (12,40 €).", "23514"],
      ["Ese gasto ya tiene 5,00 € reembolsados de 12,40 €: este reembolso puede ser, como mucho, de 7,40 €.", "23514"],
      ["Este gasto tiene 5,00 € en reembolsos: su importe no puede bajar de ahí.", "23514"],
    ]) {
      expect(mensajeErrorDb({ message, code }, propias)).toBe(message);
    }
    // Un CHECK de verdad (forma técnica) sí se traduce.
    expect(mensajeErrorDb({ message: 'violates check constraint "tx_amount_positive"', code: "23514" }, propias)).toBe(
      "Otra cosa",
    );
  });

  it("lo técnico se traduce sin nombres internos", () => {
    expect(mensajeErrorDb({ message: 'invalid input syntax for type uuid: "x"', code: "22P02" })).toBe(NO_ENCONTRADO);
    expect(mensajeErrorDb({ message: 'date/time field value out of range: "2026-02-30"' })).toBe("Esa fecha no es válida.");
    expect(mensajeErrorDb({ message: 'duplicate key value violates unique constraint "account_name_uq"' })).toBe(
      "Ya existe uno igual.",
    );
    expect(mensajeErrorDb({ message: "insert or update violates foreign key constraint", code: "23503" })).toMatch(
      /ya no existe/,
    );
    expect(mensajeErrorDb({ message: 'new row violates row-level security policy for table "budget"' })).toMatch(
      /permiso/,
    );
  });

  it("lo desconocido es el mensaje genérico, y el detalle va al registro", () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(mensajeErrorDb({ message: "something odd happened in relation goal_x" })).toBe(ERROR_GENERICO);
    expect(mensajeErrorDb({ message: "no rows returned" })).toBe(ERROR_GENERICO);
    expect(consola).toHaveBeenCalled();
  });
});

describe("exigirLecturas", () => {
  it("sin errores no hace nada (tampoco con lecturas que no traen `error`)", () => {
    expect(() => exigirLecturas([{ data: [], error: null }, { count: 5 }], "Resumen")).not.toThrow();
  });

  it("un timeout en cualquier lectura lanza, en vez de dejar que se pinte un 0", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const timeout = { code: "57014", message: "canceling statement due to statement timeout" };
    expect(() => exigirLecturas([{ data: [], error: null }, { data: null, error: timeout }], "Resumen")).toThrow(
      "No se han podido leer los datos de Resumen",
    );
    expect(console.error).toHaveBeenCalled();
  });
});
