import { beforeEach, describe, expect, it } from "vitest";
import {
  borrarBorrador,
  CLAVE_BORRADOR_MOVIMIENTO,
  guardarBorrador,
  leerBorrador,
  tieneContenido,
  type BorradorMovimiento,
} from "./borrador";

const vacio: BorradorMovimiento = {
  type: "EXPENSE",
  categoryId: null,
  fecha: "2026-10-20",
  reembolsa: null,
  seRepite: false,
  periodicidad: "MENSUAL",
  destino: "",
  posicionId: "",
  campos: { amount: "", description: "", occurred_time: "00:00", account_id: "", note: "", position_units: "" },
};

beforeEach(() => sessionStorage.clear());

describe("borrador de «Nuevo movimiento»", () => {
  it("un formulario recién abierto no deja borrador", () => {
    expect(tieneContenido(vacio)).toBe(false);
    guardarBorrador(vacio);
    expect(sessionStorage.getItem(CLAVE_BORRADOR_MOVIMIENTO)).toBeNull();
  });

  it("cambiar solo el tipo o la cuenta no cuenta como contenido", () => {
    expect(tieneContenido({ ...vacio, type: "INCOME", campos: { ...vacio.campos, account_id: "a" } })).toBe(
      false,
    );
  });

  it("guarda y recupera lo escrito, con el importe como texto", () => {
    const b = { ...vacio, categoryId: "c1", campos: { ...vacio.campos, amount: "12,40", description: "Pan" } };
    guardarBorrador(b);
    expect(leerBorrador()).toEqual(b);
  });

  it("vaciar el formulario borra el borrador", () => {
    guardarBorrador({ ...vacio, campos: { ...vacio.campos, description: "Pan" } });
    guardarBorrador(vacio);
    expect(leerBorrador()).toBeNull();
  });

  it("caduca a las 12 horas", () => {
    guardarBorrador({ ...vacio, campos: { ...vacio.campos, note: "x" } });
    expect(leerBorrador(Date.now() + 13 * 60 * 60 * 1000)).toBeNull();
    expect(sessionStorage.getItem(CLAVE_BORRADOR_MOVIMIENTO)).toBeNull();
  });

  it("un valor corrupto no rompe nada", () => {
    sessionStorage.setItem(CLAVE_BORRADOR_MOVIMIENTO, "{no es json");
    expect(leerBorrador()).toBeNull();
    borrarBorrador();
    expect(sessionStorage.getItem(CLAVE_BORRADOR_MOVIMIENTO)).toBeNull();
  });
});
