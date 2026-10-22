import { describe, expect, it } from "vitest";
import { NBSP } from "./money";
import { cuadroAmortizacion, resumenPrestamo } from "./prestamos";
import {
  fechaCuota,
  formatTipo,
  fraseBorradoPrestamo,
  frasePatrimonioPrestamo,
  frasesSaldosPrestamo,
  leerPlazo,
  origenMovimientoPrestamo,
  parteDevuelta,
  primerasCuotasPosibles,
  puntosPasados,
  serieCapital,
  tipoParaCampo,
  vistaPreviaPrestamo,
  type EntradaVistaPrevia,
  type FilaCuadro,
} from "./prestamos-vista";

const base: EntradaVistaPrevia = {
  principal: "12.000,00",
  plazo: "5",
  unidad: "ANIOS",
  tin: "6,5",
  modoComision: "IMPORTE",
  comision: "",
  diaCobro: 1,
  inicio: "2026-10-13",
  primera: null,
  desembolso: true,
  hoy: "2026-10-13",
};

describe("los tipos se pintan desde el texto de la base", () => {
  it("quita los ceros de numeric y usa coma", () => {
    expect(formatTipo("6.5000")).toBe(`6,5${NBSP}%`);
    expect(formatTipo("4.1250")).toBe(`4,125${NBSP}%`);
    expect(formatTipo("0.0000")).toBe(`0${NBSP}%`);
    expect(formatTipo(null)).toBe("—");
    expect(tipoParaCampo("12.0000")).toBe("12");
  });
});

describe("el plazo", () => {
  it("se lee en meses o en años, solo con dígitos", () => {
    expect(leerPlazo("60", "MESES")).toBe(60);
    expect(leerPlazo("5", "ANIOS")).toBe(60);
    expect(leerPlazo("2,5", "ANIOS")).toBeNull();
    expect(leerPlazo("0", "MESES")).toBeNull();
    expect(leerPlazo("41", "ANIOS")).toBeNull();
  });
});

describe("la primera cuota", () => {
  it("cae siempre en el día de cobro y después del inicio", () => {
    const fechas = primerasCuotasPosibles("2026-10-13", 20);
    expect(fechas[0]).toBe("2026-10-20");
    expect(fechas).toHaveLength(13);
    expect(primerasCuotasPosibles("2026-10-13", 1)[0]).toBe("2026-11-01");
    expect(primerasCuotasPosibles("2026-10-13", 13)[0]).toBe("2026-11-13");
    expect(primerasCuotasPosibles("2026-12-13", 1)[0]).toBe("2027-01-01");
  });
});

describe("la vista previa", () => {
  it("da la misma cuota que el cuadro de la base", () => {
    const v = vistaPreviaPrestamo(base);
    expect(v.estado).toBe("ok");
    if (v.estado !== "ok") return;
    const r = resumenPrestamo({
      principalCents: 1_200_000,
      plazoMeses: 60,
      tin: 65_000,
      primeraCuota: "2026-11-01",
      comisionCents: 0,
    });
    expect(v.resumen.cuota).toBe(r.cuota);
    expect(v.plazoMeses).toBe(60);
    expect(v.primera).toBe("2026-11-01");
    expect(v.vencidas).toBe(0);
  });

  it("la comisión en % se redondea al céntimo", () => {
    const v = vistaPreviaPrestamo({ ...base, modoComision: "PORCENTAJE", comision: "1,5" });
    expect(v.estado === "ok" && v.comisionCents).toBe(18_000);
  });

  it("«ya lo tenía apuntado» no lleva comisión y arranca a hoy", () => {
    const v = vistaPreviaPrestamo({
      ...base,
      desembolso: false,
      inicio: "2025-01-10",
      comision: "150",
      hoy: "2026-10-13",
    });
    expect(v.estado).toBe("ok");
    if (v.estado !== "ok") return;
    expect(v.comisionCents).toBe(0);
    expect(v.arranque?.primerPeriodo).toBe(22);
  });

  it("con fecha pasada y el dinero entrando ahora, cuenta las vencidas", () => {
    const v = vistaPreviaPrestamo({ ...base, inicio: "2026-06-15", hoy: "2026-10-13" });
    expect(v.estado === "ok" && v.vencidas).toBe(4);
  });

  it("pide lo que falta y explica lo que no vale", () => {
    expect(vistaPreviaPrestamo({ ...base, tin: "" }).estado).toBe("incompleto");
    expect(vistaPreviaPrestamo({ ...base, principal: "50" }).estado).toBe("error");
    expect(vistaPreviaPrestamo({ ...base, tin: "6,12345" }).estado).toBe("error");
    expect(vistaPreviaPrestamo({ ...base, comision: "12000" }).estado).toBe("error");
  });
});

describe("la serie del capital", () => {
  it("arranca con todo el principal y marca lo pasado", () => {
    const cuadro = cuadroAmortizacion({
      principalCents: 300_000,
      plazoMeses: 3,
      tin: 60_000,
      primeraCuota: "2026-11-01",
    });
    const filas: FilaCuadro[] = cuadro.map((f, i) => ({
      period: f.periodo,
      due_on: f.fecha,
      payment_cents: f.cuota,
      interest_cents: f.intereses,
      principal_cents: f.capital,
      balance_after_cents: f.pendiente,
      state: i === 0 ? "COBRADA" : "PENDIENTE",
    }));
    const serie = serieCapital(300_000, "2026-10-13", filas);
    expect(serie).toHaveLength(4);
    expect(serie[0]).toMatchObject({ periodo: 0, pendiente: 300_000, pasado: true });
    expect(serie[3].pendiente).toBe(0);
    expect(puntosPasados(serie)).toBe(2);
    expect(parteDevuelta(100_000, 300_000)).toBeCloseTo(33.33, 1);
  });
});

describe("las frases", () => {
  it("dicen de qué cuota es un movimiento", () => {
    expect(origenMovimientoPrestamo({ parte: "INTERESES", periodo: 3, plazo: 60, nombre: "Coche" })).toBe(
      "Cuota 3 de 60 del préstamo Coche · intereses",
    );
    expect(origenMovimientoPrestamo({ parte: "DESEMBOLSO", periodo: null, plazo: 60, nombre: "Coche" })).toBe(
      "El dinero del préstamo Coche, al entrar",
    );
  });

  it("cuentan qué se borra", () => {
    const p = {
      name: "Coche",
      status: "ACTIVO",
      transactions: 10,
      installments: 4,
      expense_cents: 25_000,
      balance_effects: [{ account_id: "a", account_name: "Nomina", balance_delta_cents: -1_000_000 }],
      net_worth_delta_cents: 25_000,
    };
    expect(fraseBorradoPrestamo(p)).toBe(
      "Se borrarán 10 movimientos (entre ellos, 4 cuotas cobradas) y la cuenta del préstamo.",
    );
    expect(frasesSaldosPrestamo(p)).toEqual([`El saldo de Nomina bajará 10.000,00${NBSP}€.`]);
    expect(frasePatrimonioPrestamo(p)).toBe(`Tu patrimonio subirá 250,00${NBSP}€.`);
    expect(fechaCuota("2026-11-01")).toBe("1 nov 2026");
  });
});
