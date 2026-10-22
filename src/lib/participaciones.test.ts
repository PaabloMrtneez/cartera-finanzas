import { describe, expect, it } from "vitest";
import { isinValido, parseParticipaciones } from "./participaciones";
import { ajustarParticipacionesSchema, participacionesAportacionSchema, seguirInstrumentoSchema } from "./schemas";

const valor = (texto: string, permitirCero = false) => {
  const r = parseParticipaciones(texto, { permitirCero });
  return r.ok ? r.valor : null;
};

describe("parseParticipaciones: texto → decimal exacto, sin coma flotante", () => {
  it("coma decimal, como lo escribe MyInvestor", () => {
    expect(valor("123,456789")).toBe("123.456789");
    expect(valor("1.234,5678")).toBe("1234.5678");
    expect(valor("12.345.678,12345678")).toBe("12345678.12345678");
    expect(valor(",5")).toBe("0.5");
  });

  it("punto decimal, como en una web en inglés", () => {
    expect(valor("12.5")).toBe("12.5");
    expect(valor("0.123")).toBe("0.123");
    expect(valor("1234.567")).toBe("1234.567");
    expect(valor("1,234.5678")).toBe("1234.5678");
  });

  it("solo puntos de millares", () => {
    expect(valor("1.234.567")).toBe("1234567");
  });

  it("normaliza: sin ceros sobrantes, sin espacios", () => {
    expect(valor("00012,3400")).toBe("12.34");
    expect(valor(" 1 234,5 ")).toBe("1234.5");
    expect(valor("1 234,5")).toBe("1234.5");
    expect(valor("7")).toBe("7");
    expect(valor("7,000")).toBe("7");
  });

  it("no pasa por un número: conserva los 8 decimales exactos", () => {
    // Como doble, 0.1 + 0.2 no es 0,3; como texto, cada cifra es la que es.
    expect(valor("0,12345678")).toBe("0.12345678");
    expect(valor("9999999999999999,99999999")).toBe("9999999999999999.99999999");
  });

  it("«1.234» es ambiguo (¿mil o uno coma dos?): se pide la coma decimal", () => {
    const r = parseParticipaciones("1.234");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/1234 o 1,234/);
  });

  it("rechaza lo que no es una cifra limpia, sin inventar", () => {
    for (const malo of ["", "abc", "12a", "1,2,3", "1.23.4", "1,234,5", "12,5.3", "1..2", "-3", "−3", "1.2,3.4"]) {
      expect(valor(malo)).toBeNull();
    }
  });

  it("como mucho 8 decimales y 16 cifras enteras (numeric(24,8))", () => {
    expect(valor("1,123456789")).toBeNull();
    expect(valor("12345678901234567")).toBeNull();
  });

  it("cero solo vale para un ajuste (lo has vendido todo)", () => {
    expect(valor("0")).toBeNull();
    expect(valor("0,000")).toBeNull();
    expect(valor("0", true)).toBe("0");
    expect(valor("0,000", true)).toBe("0");
  });
});

describe("isinValido", () => {
  it("acepta ISIN reales (dígito de control correcto)", () => {
    expect(isinValido("IE00BYX5NX33")).toBe(true); // Fidelity MSCI World P-ACC-EUR
    expect(isinValido("LU0273159177")).toBe(true); // DWS Invest Gold LC
    expect(isinValido("US0378331005")).toBe(true); // Apple
    expect(isinValido(" ie00byx5nx33 ")).toBe(true);
  });

  it("rechaza un dígito mal copiado o un formato que no es", () => {
    expect(isinValido("IE00BYX5NX34")).toBe(false);
    expect(isinValido("LU0273159178")).toBe(false);
    expect(isinValido("GOOGL")).toBe(false);
    expect(isinValido("")).toBe(false);
  });
});

describe("esquemas de las server actions", () => {
  const base = {
    position_id: "6f9619ff-8b86-4011-b42d-00cf4fc964ff",
    simbolo: "0P0001CLDK.F",
    participaciones: "1.234,5678",
    aportado: "15.000,00",
    fecha: "2026-10-01",
  };

  it("seguirInstrumento: participaciones a texto exacto y lo aportado a céntimos", () => {
    const r = seguirInstrumentoSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.participaciones).toBe("1234.5678");
      expect(r.data.aportado).toBe(1500000);
      expect(r.data.isin).toBeNull();
      expect(r.data.nueva).toBeNull();
    }
  });

  it("seguirInstrumento: el ISIN se valida y se pasa a mayúsculas", () => {
    const ok = seguirInstrumentoSchema.safeParse({ ...base, isin: "ie00byx5nx33" });
    expect(ok.success && ok.data.isin).toBe("IE00BYX5NX33");
    expect(seguirInstrumentoSchema.safeParse({ ...base, isin: "IE00BYX5NX34" }).success).toBe(false);
    const vacio = seguirInstrumentoSchema.safeParse({ ...base, isin: "" });
    expect(vacio.success && vacio.data.isin).toBeNull();
  });

  it("seguirInstrumento: una posición existente O una nueva, no las dos ni ninguna", () => {
    const nueva = { name: "MSCI World", account_id: "6f9619ff-8b86-4011-b42d-00cf4fc964ff", color: "#336699" };
    expect(seguirInstrumentoSchema.safeParse({ ...base, position_id: null, nueva }).success).toBe(true);
    expect(seguirInstrumentoSchema.safeParse({ ...base, nueva }).success).toBe(false);
    expect(seguirInstrumentoSchema.safeParse({ ...base, position_id: null }).success).toBe(false);
  });

  it("seguirInstrumento: rechaza símbolos raros, participaciones a cero y aportado negativo", () => {
    expect(seguirInstrumentoSchema.safeParse({ ...base, simbolo: "a b" }).success).toBe(false);
    expect(seguirInstrumentoSchema.safeParse({ ...base, participaciones: "0" }).success).toBe(false);
    expect(seguirInstrumentoSchema.safeParse({ ...base, aportado: "-5" }).success).toBe(false);
  });

  it("ajustarParticipaciones admite cero", () => {
    const r = ajustarParticipacionesSchema.safeParse({ position_id: base.position_id, participaciones: "0", fecha: "2026-10-01" });
    expect(r.success && r.data.participaciones).toBe("0");
  });

  it("participacionesDeAportacion: vacío borra (null), texto se convierte", () => {
    const id = base.position_id;
    const borrar = participacionesAportacionSchema.safeParse({ transaction_id: id, participaciones: "" });
    expect(borrar.success && borrar.data.participaciones).toBeNull();
    const poner = participacionesAportacionSchema.safeParse({ transaction_id: id, participaciones: "20,5" });
    expect(poner.success && poner.data.participaciones).toBe("20.5");
    expect(participacionesAportacionSchema.safeParse({ transaction_id: id, participaciones: "1.234" }).success).toBe(false);
  });
});
