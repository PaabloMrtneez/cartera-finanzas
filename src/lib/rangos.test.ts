import { describe, expect, it } from "vitest";
import { diasDeRango, diasEntre, esDiario, leerRango, mesesDeRango, mesesEntre } from "./rangos";

describe("rangos de patrimonio", () => {
  it("un rango inventado cae en un año", () => {
    expect(leerRango(undefined)).toBe("1a");
    expect(leerRango("bandera")).toBe("1a");
    expect(leerRango("6m")).toBe("6m");
  });

  it("los enlaces viejos siguen abriendo lo que abrían", () => {
    expect(leerRango("12")).toBe("1a");
    expect(leerRango("60")).toBe("todo");
  });

  it("cuenta los meses con los dos extremos dentro", () => {
    expect(mesesEntre("2026-01-15", "2026-10-05")).toBe(10);
    expect(mesesEntre("2025-12-01", "2026-01-31")).toBe(2);
  });

  it("«Todo» va desde el primer movimiento, con mínimo y tope", () => {
    expect(mesesDeRango("6m", null, "2026-10-05")).toBe(6);
    expect(mesesDeRango("todo", "2026-03-02", "2026-10-05")).toBe(8);
    expect(mesesDeRango("todo", "2026-10-01", "2026-10-05")).toBe(2);
    expect(mesesDeRango("todo", "1990-01-01", "2026-10-05")).toBe(120);
    expect(mesesDeRango("todo", null, "2026-10-05")).toBe(12);
  });

  it("1M y 3M son diarios y traen su periodo anterior", () => {
    expect(leerRango("1m")).toBe("1m");
    expect(esDiario("1m")).toBe(true);
    expect(esDiario("6m")).toBe(false);
    const r = diasDeRango("1m", "2026-10-05");
    expect(r).toEqual({
      desde: "2026-09-06",
      hasta: "2026-10-05",
      previoDesde: "2026-08-07",
      dias: 30,
    });
    const t = diasDeRango("3m", "2026-05-31");
    // El 31 de febrero no existe: se recorta al 28, y se arranca al día siguiente.
    expect(t.desde).toBe("2026-03-01");
    expect(diasEntre(t.previoDesde, t.desde)).toBe(t.dias);
  });
});
