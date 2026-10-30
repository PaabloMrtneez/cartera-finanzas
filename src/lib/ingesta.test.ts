import { describe, expect, it } from "vitest";
import {
  avisoDePago,
  centimosDeNumero,
  esErrorDeDatos,
  esInstanteIso,
  ultimosCuatro,
} from "./ingesta";

describe("centimosDeNumero", () => {
  it("un número con hasta dos decimales da los céntimos exactos", () => {
    expect(centimosDeNumero(0.29)).toBe(29);
    expect(centimosDeNumero(1.15)).toBe(115);
    expect(centimosDeNumero(12.5)).toBe(1250);
    expect(centimosDeNumero(1234.56)).toBe(123_456);
    expect(centimosDeNumero(7)).toBe(700);
  });

  it("negativos, cero, más de dos decimales, exponentes o no finitos son null", () => {
    for (const n of [-12.5, 0, -0, 1.005, 0.001, 1e21, 1e-7, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(centimosDeNumero(n)).toBeNull();
    }
  });
});

describe("ultimosCuatro", () => {
  it("se queda con las 4 últimas cifras o con nada", () => {
    expect(ultimosCuatro("1234")).toBe("1234");
    expect(ultimosCuatro("**** 9876")).toBe("9876");
    expect(ultimosCuatro("123")).toBeNull();
    expect(ultimosCuatro("")).toBeNull();
    expect(ultimosCuatro(null)).toBeNull();
    expect(ultimosCuatro(undefined)).toBeNull();
  });
});

describe("esInstanteIso", () => {
  it("acepta fechas y horas ISO 8601 que existen", () => {
    for (const t of ["2026-10-19", "2026-10-19T14:32", "2026-10-19T14:32:05Z", "2026-10-19T14:32:05.123+02:00", "2028-02-29T00:00:00+0100"]) {
      expect(esInstanteIso(t)).toBe(true);
    }
  });

  it("rechaza lo que Postgres no entendería o no existe", () => {
    for (const t of ["ayer", "19 oct 2026, 14:32", "2026-02-30", "2026-13-01", "2026-10-19T24:00", "2026-10-19T12:60", ""]) {
      expect(esInstanteIso(t)).toBe(false);
    }
  });
});

describe("esErrorDeDatos", () => {
  it("distingue un dato malo (22xxx, 23xxx) de una base caída", () => {
    expect(esErrorDeDatos({ code: "23514", message: "x" })).toBe(true);
    expect(esErrorDeDatos({ code: "22007", message: "x" })).toBe(true);
    expect(esErrorDeDatos({ message: 'new row violates check constraint "tx_card_last4_fmt"' })).toBe(true);
    expect(esErrorDeDatos({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(false);
    expect(esErrorDeDatos({ message: "fetch failed" })).toBe(false);
  });
});

/** `Intl` separa el «€» con un espacio duro (no se parte de línea). */
const sinEspacioDuro = (t: string) => t.replace(/ /g, " ");

describe("avisoDePago", () => {
  it("con categoría por regla: cuánto, dónde y a qué se ha asignado", () => {
    const a = avisoDePago({ id: "tx-1", cents: 420, merchant: "Mercadona", account: "Santander", category: "Alimentación", status: "CONFIRMED" });
    expect(sinEspacioDuro(a.title)).toBe("Has pagado 4,20 € en Mercadona");
    expect(a.body).toBe("Asignado a Alimentación · Santander.");
    expect(a.url).toBe("/movimientos/tx-1");
  });

  it("con categoría heredada: lo dice y deja corregirla", () => {
    const a = avisoDePago({ id: "tx-2", cents: 350, merchant: "Bar Pepe", category: "Restaurantes", status: "CONFIRMED", inherited: true });
    expect(a.body).toBe("Asignado a Restaurantes, como otras veces.");
  });

  it("sin categoría: invita a entrar a asignarla, y tocar abre ese movimiento", () => {
    const a = avisoDePago({ id: "tx-3", cents: 1599, merchant: "Amazon", account: "Santander", category: null, status: "PENDING" });
    expect(sinEspacioDuro(a.title)).toBe("Has pagado 15,99 € en Amazon");
    expect(a.body).toBe("Sin categoría todavía. Entra para asignarle una.");
    expect(a.url).toBe("/movimientos/tx-3");
  });

  it("una recarga (aviso de Cartera): traspaso, no gasto", () => {
    const a = avisoDePago({ id: "tx-4", cents: 2400, merchant: "Revolut", account: "Santander", to_account: "Revoult", kind: "TRANSFER", status: "CONFIRMED" });
    expect(sinEspacioDuro(a.title)).toBe("Recarga de 24,00 € en Revoult");
    expect(a.body).toBe("Apuntada como traspaso desde Santander: no cuenta como gasto.");
    expect(a.url).toBe("/movimientos/tx-4");
  });

  it("con nota de la base: lo que hay que revisar, no la categoría", () => {
    const repetido = avisoDePago({ id: "tx-5", cents: 200, merchant: "Cafeteria", category: "Café", status: "PENDING", note: "¿Repetido? En esos minutos…" });
    expect(repetido.body).toBe("Puede que ya estuviera apuntado. Entra para revisarlo.");
    const sinCuenta = avisoDePago({ id: "tx-6", cents: 200, merchant: "Cafeteria", status: "PENDING", note: "La tarjeta «Revolut» de Cartera no tiene cuenta…" });
    expect(sinCuenta.body).toBe("Falta elegir la cuenta de esta tarjeta. Entra para revisarlo.");
  });

  it("sin comercio ni id no se rompe", () => {
    const a = avisoDePago({ cents: 100, merchant: "  ", category: null });
    expect(sinEspacioDuro(a.title)).toBe("Has pagado 1,00 € en un comercio");
    expect(a.url).toBe("/movimientos");
  });
});
