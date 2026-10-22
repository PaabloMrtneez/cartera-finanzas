import { describe, expect, it } from "vitest";
import {
  argumentosBusqueda,
  conCatalogo,
  filaLigera,
  leerConsulta,
  leerConsultaDeTexto,
  MAX_FILAS_INICIALES,
  PAGINA,
} from "./consulta-movimientos";

const HOY = "2026-10-20";
const UUID = "0b9a3c1e-5d2f-4a7b-9c8d-1e2f3a4b5c6d";

describe("leerConsulta", () => {
  it("sin nada, el mes en curso y la primera tanda", () => {
    const c = leerConsulta({}, HOY);
    expect(c).toMatchObject({ all: false, month: "2026-10-01", filas: PAGINA });
  });

  it("acota las filas pedidas por la dirección", () => {
    expect(leerConsulta({ filas: "5000" }, HOY).filas).toBe(MAX_FILAS_INICIALES);
    expect(leerConsulta({ filas: "3" }, HOY).filas).toBe(PAGINA);
    expect(leerConsulta({ filas: "150.7" }, HOY).filas).toBe(150);
    expect(leerConsulta({ filas: "abc" }, HOY).filas).toBe(PAGINA);
  });

  it("la página y «Cargar más» leen lo mismo de la misma dirección", () => {
    const params = { mes: "2026-08-14", q: "50%", tipo: "EXPENSE", categoria: UUID, auto: "1" };
    const texto = new URLSearchParams(params).toString();
    expect(leerConsultaDeTexto(texto, HOY)).toEqual(leerConsulta(params, HOY));
  });
});

describe("argumentosBusqueda", () => {
  it("traduce mes, filtros y límite; la búsqueda va literal", () => {
    const c = leerConsulta({ mes: "2026-02-10", q: "50%", categoria: "sin", pendientes: "1" }, HOY);
    expect(argumentosBusqueda(c, 150)).toEqual({
      p_from: "2026-02-01",
      p_to: "2026-02-28",
      p_type: null,
      p_account: null,
      p_category: null,
      p_uncategorized: true,
      p_only_shortcut: false,
      p_only_pending: true,
      p_q: "50\\%",
      p_limit: 150,
    });
  });

  it("«todo» quita el rango de fechas", () => {
    const a = argumentosBusqueda(leerConsulta({ mes: "todo" }, HOY), 100);
    expect(a.p_from).toBeNull();
    expect(a.p_to).toBeNull();
  });

  it("un id que no es uuid no llega a la base (haría fallar la RPC entera)", () => {
    const a = argumentosBusqueda(leerConsulta({ cuenta: "x'; drop", categoria: "nope" }, HOY), 100);
    expect(a.p_account).toBeNull();
    expect(a.p_category).toBeNull();
    const b = argumentosBusqueda(leerConsulta({ cuenta: UUID, categoria: UUID }, HOY), 100);
    expect(b.p_account).toBe(UUID);
    expect(b.p_category).toBe(UUID);
  });
});

describe("filaLigera y conCatalogo", () => {
  const fila = {
    id: "t1",
    type: "TRANSFER" as const,
    amount_cents: 12_345,
    description: "Ahorro",
    occurred_on: "2026-10-19",
    occurred_time: "09:30:00",
    status: "CONFIRMED",
    category_id: null,
    account_id: "a1",
    to_account_id: "a2",
  };

  it("se queda solo con lo que pinta la fila", () => {
    const conDeMas = { ...fila, note: "privada", merchant_raw: "X", total_count: 9 };
    expect(Object.keys(filaLigera(conDeMas)).sort()).toEqual(Object.keys(fila).sort());
  });

  it("resuelve categoría y cuentas contra el catálogo", () => {
    const v = conCatalogo(fila, {
      categorias: {},
      cuentas: { a1: { name: "Banco" }, a2: { name: "Hucha" } },
    });
    expect(v.account?.name).toBe("Banco");
    expect(v.toAccount?.name).toBe("Hucha");
    expect(v.category).toBeNull();
  });
});
