import { describe, expect, it } from "vitest";
import {
  CuadroInvalido,
  arranqueYaApuntado,
  comisionPorPorcentaje,
  cuadroAmortizacion,
  hoyEnMadrid,
  leerTipo,
  parseLoanCreateResult,
  parseLoanDeletePreview,
  primeraCuotaPorDefecto,
  resumenPrestamo,
  sumarMeses,
  taeCalculada,
  textoAvisoCuota,
  tipoComoDecimal,
} from "./prestamos";
import { loanCreateSchema, loanPreviewSchema, loanSettleSchema, loanTermsSchema } from "./schemas";

/**
 * El cuadro se compara además, al céntimo y en una rejilla de 360 casos, con
 * `public.loan_plan` de la base en scripts/test-prestamos.mjs. Aquí van los
 * casos calculados a mano y las reglas de redondeo.
 */

const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe("leerTipo · el TIN como decimal exacto", () => {
  it("lee coma, punto, % y espacios, en diezmilésimas de punto", () => {
    expect(leerTipo("6,5")).toBe(65_000);
    expect(leerTipo("6.5 %")).toBe(65_000);
    expect(leerTipo(" 4,125 ")).toBe(41_250);
    expect(leerTipo("0")).toBe(0);
    expect(leerTipo(",75")).toBe(7_500);
    expect(leerTipo("0,0001")).toBe(1);
  });

  it("no pasa por coma flotante: 0,29 es exactamente 2.900", () => {
    // 0.29 * 10000 = 2899.9999999999995 en coma flotante.
    expect(leerTipo("0,29")).toBe(2_900);
    expect(leerTipo("7,99")).toBe(79_900);
  });

  it("rechaza lo que no es un tipo limpio o pasa del máximo", () => {
    for (const malo of ["", "abc", "6,5,1", "-3", "−3", "1,23456", "50,0001", "1.000,5"]) {
      expect(leerTipo(malo), malo).toBeNull();
    }
    expect(leerTipo("50")).toBe(500_000);
    expect(leerTipo("99", 100)).toBe(990_000);
  });

  it("tipoComoDecimal da el texto exacto que entiende numeric", () => {
    expect(tipoComoDecimal(65_000)).toBe("6.5");
    expect(tipoComoDecimal(41_250)).toBe("4.125");
    expect(tipoComoDecimal(1)).toBe("0.0001");
    expect(tipoComoDecimal(0)).toBe("0");
    expect(tipoComoDecimal(500_000)).toBe("50");
  });
});

describe("cuadroAmortizacion · sistema francés en céntimos", () => {
  const coche = cuadroAmortizacion({
    principalCents: 1_000_000,
    plazoMeses: 60,
    tin: leerTipo("6")!,
    primeraCuota: "2026-11-01",
  });

  it("10.000 € a 60 meses al 6 %: cuota 193,33 € (P·i / (1 − (1+i)^−n))", () => {
    // 1.000.000 · 0,005 / (1 − 1,005^−60) = 19.332,80 céntimos → 19.333.
    expect(coche[0].cuota).toBe(19_333);
    expect(coche[0].intereses).toBe(5_000);
    expect(coche[0].capital).toBe(14_333);
    expect(coche[1].intereses).toBe(4_928); // 985.667 · 0,005 = 4.928,335 → 4.928
  });

  it("el capital suma el principal exacto y el pendiente acaba en 0", () => {
    expect(suma(coche.map((f) => f.capital))).toBe(1_000_000);
    expect(coche.at(-1)!.pendiente).toBe(0);
    expect(coche.every((f) => f.cuota === f.intereses + f.capital)).toBe(true);
  });

  it("la última cuota ajusta el redondeo", () => {
    expect(coche.at(-1)!.cuota).toBe(19_321);
    expect(coche.slice(0, -1).every((f) => f.cuota === 19_333)).toBe(true);
  });

  it("el pendiente después de cada cuota baja exactamente su capital", () => {
    let pendiente = 1_000_000;
    for (const f of coche) {
      pendiente -= f.capital;
      expect(f.pendiente).toBe(pendiente);
    }
  });

  it("los intereses se redondean con el empate HACIA ARRIBA", () => {
    // 1.200 € al 12 %: i = 1 %. El 2.º mes, 109.338 · 0,01 = 1.093,38 → 1.093;
    // y un pendiente que acabe en 50 da medio céntimo exacto: sube.
    const b = cuadroAmortizacion({ principalCents: 120_000, plazoMeses: 12, tin: 120_000, primeraCuota: "2026-01-15" });
    expect(b[0].cuota).toBe(10_662);
    expect(b[0].intereses).toBe(1_200);
    const empate = cuadroAmortizacion({ principalCents: 10_050, plazoMeses: 1, tin: 120_000, primeraCuota: "2026-01-15" });
    // 10.050 · 0,01 = 100,5 → 101
    expect(empate[0].intereses).toBe(101);
    expect(empate[0].capital).toBe(10_050);
  });

  it("TIN 0 %: cuota P/n redondeada, sin intereses, la última ajusta", () => {
    const c = cuadroAmortizacion({ principalCents: 100_000, plazoMeses: 12, tin: 0, primeraCuota: "2026-01-31" });
    expect(c[0].cuota).toBe(8_333);
    expect(c.at(-1)!.cuota).toBe(8_337);
    expect(c.every((f) => f.intereses === 0)).toBe(true);
    expect(suma(c.map((f) => f.capital))).toBe(100_000);
  });

  it("las fechas: el mismo día cada mes, recortando el fin de mes como Postgres", () => {
    const c = cuadroAmortizacion({ principalCents: 100_000, plazoMeses: 3, tin: 0, primeraCuota: "2026-01-31" });
    expect(c.map((f) => f.fecha)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(coche.at(-1)!.fecha).toBe("2031-10-01");
  });

  it("un solo mes: una cuota con todo", () => {
    const u = cuadroAmortizacion({ principalCents: 50_000, plazoMeses: 1, tin: 60_000, primeraCuota: "2026-02-01" });
    expect(u).toHaveLength(1);
    expect(u[0].capital).toBe(50_000);
    expect(u[0].intereses).toBe(250);
  });

  it("rechaza datos sin sentido (el mismo caso en que la base rechaza el préstamo)", () => {
    const base = { principalCents: 1_000_000, plazoMeses: 60, tin: 60_000, primeraCuota: "2026-01-01" };
    expect(() => cuadroAmortizacion({ ...base, plazoMeses: 0 })).toThrow(CuadroInvalido);
    expect(() => cuadroAmortizacion({ ...base, plazoMeses: 481 })).toThrow(CuadroInvalido);
    expect(() => cuadroAmortizacion({ ...base, principalCents: 0 })).toThrow(CuadroInvalido);
    expect(() => cuadroAmortizacion({ ...base, tin: 500_001 })).toThrow(CuadroInvalido);
    // 100 € a 10 años al 50 %: el redondeo de la cuota liquidaría el préstamo
    // antes de la última, y la base también lo rechaza.
    expect(() => cuadroAmortizacion({ ...base, principalCents: 10_000, plazoMeses: 120, tin: 499_999 })).toThrow(
      CuadroInvalido,
    );
  });
});

describe("taeCalculada · informativa", () => {
  const cuotas = cuadroAmortizacion({
    principalCents: 1_000_000,
    plazoMeses: 60,
    tin: 60_000,
    primeraCuota: "2026-01-01",
  }).map((f) => f.cuota);

  it("sin comisión ≈ (1 + TIN/12)^12 − 1", () => {
    expect(taeCalculada(cuotas, 1_000_000)).toBe(6.17);
  });

  it("la comisión de apertura la sube", () => {
    expect(taeCalculada(cuotas, 990_000)).toBe(6.61);
    expect(taeCalculada(cuotas, 950_000)!).toBeGreaterThan(8);
  });

  it("TIN 0 sin comisión → 0; con comisión, positiva", () => {
    const sin = cuadroAmortizacion({ principalCents: 100_000, plazoMeses: 12, tin: 0, primeraCuota: "2026-01-01" });
    expect(taeCalculada(sin.map((f) => f.cuota), 100_000)).toBe(0);
    expect(taeCalculada(sin.map((f) => f.cuota), 99_000)!).toBeGreaterThan(1.5);
  });

  it("null si no hay una TAE con sentido", () => {
    expect(taeCalculada([], 100)).toBeNull();
    expect(taeCalculada(cuotas, 0)).toBeNull();
    expect(taeCalculada([100], 1)).toBeNull(); // más del 100 % mensual
  });
});

describe("resumen, comisión y fechas", () => {
  it("comisión en %: mitad hacia arriba sobre el principal", () => {
    expect(comisionPorPorcentaje(1_000_000, leerTipo("1")!)).toBe(10_000);
    expect(comisionPorPorcentaje(123_457, leerTipo("1,5")!)).toBe(1_852); // 1.851,855 → 1.852
    expect(comisionPorPorcentaje(100, leerTipo("0,5")!)).toBe(1); // 0,5 → 1
  });

  it("resumen: cuota, intereses, coste total = intereses + comisión", () => {
    const r = resumenPrestamo({
      principalCents: 1_000_000,
      plazoMeses: 60,
      tin: 60_000,
      primeraCuota: "2026-11-01",
      comisionCents: 10_000,
    });
    expect(r.cuota).toBe(19_333);
    expect(r.interesesTotales).toBe(159_968);
    expect(r.costeTotal).toBe(169_968);
    expect(r.totalCuotas).toBe(1_000_000 + 159_968);
    expect(r.tae).toBe(6.61);
    expect(r.fechaFin).toBe("2031-10-01");
  });

  it("primera cuota por defecto: el día de cobro del mes siguiente al de inicio", () => {
    expect(primeraCuotaPorDefecto("2026-10-13", 1)).toBe("2026-11-01");
    expect(primeraCuotaPorDefecto("2026-10-13", 20)).toBe("2026-11-20");
    expect(primeraCuotaPorDefecto("2026-12-31", 28)).toBe("2027-01-28");
  });

  it("ya apuntado: empieza en la primera cuota POSTERIOR al alta, con el pendiente del cuadro", () => {
    const c = cuadroAmortizacion({ principalCents: 1_000_000, plazoMeses: 60, tin: 60_000, primeraCuota: "2026-01-01" });
    const a = arranqueYaApuntado(c, "2026-03-01")!;
    // La del 1 de marzo ya está pagada (es de hasta hoy): sigue en la 4.ª.
    expect(a.primerPeriodo).toBe(4);
    expect(a.pendiente).toBe(c[2].pendiente);
    expect(arranqueYaApuntado(c, "2025-12-31")).toEqual({ primerPeriodo: 1, pendiente: 1_000_000 });
    expect(arranqueYaApuntado(c, "2031-01-01")).toBeNull();
  });

  it("sumarMeses recorta igual que Postgres", () => {
    expect(sumarMeses("2026-01-31", 1)).toBe("2026-02-28");
    expect(sumarMeses("2024-01-31", 1)).toBe("2024-02-29");
    expect(sumarMeses("2026-03-15", -3)).toBe("2025-12-15");
  });

  it("hoyEnMadrid: a las 23:30 UTC del 31 ya es día 1 en Madrid", () => {
    expect(hoyEnMadrid(new Date("2026-10-31T23:30:00Z"))).toBe("2026-11-01");
    expect(hoyEnMadrid(new Date("2026-07-31T21:59:00Z"))).toBe("2026-07-31");
  });
});

describe("lo que devuelve la base y el aviso", () => {
  it("parseLoanDeletePreview valida la forma", () => {
    const ok = parseLoanDeletePreview({
      name: "Coche",
      status: "ACTIVO",
      transactions: 8,
      installments: 3,
      expense_cents: 24_784,
      balance_effects: [{ account_id: "a", account_name: "Banco", balance_delta_cents: -932_001 }],
      net_worth_delta_cents: 24_784,
      liability_initial_cents: 0,
    });
    expect(ok?.balance_effects[0].balance_delta_cents).toBe(-932_001);
    expect(parseLoanDeletePreview({ name: "x" })).toBeNull();
    expect(parseLoanDeletePreview(null)).toBeNull();
  });

  it("parseLoanCreateResult", () => {
    expect(
      parseLoanCreateResult({
        loan_id: "l",
        liability_account_id: "c",
        first_charge_on: "2026-11-01",
        tracked_from_period: 1,
        generated: 0,
      })?.generated,
    ).toBe(0);
    expect(parseLoanCreateResult({ loan_id: "l" })).toBeNull();
  });

  it("textoAvisoCuota: una o varias cuotas", () => {
    expect(textoAvisoCuota({ nombre: "Coche", desde: 5, hasta: 5, plazo: 60, importe: "193,33 €" })).toEqual({
      title: "Se ha cobrado la cuota de Coche",
      body: "Cuota 5 de 60: 193,33 €.",
    });
    expect(textoAvisoCuota({ nombre: "Coche", desde: 1, hasta: 3, plazo: 60, importe: "579,99 €" }).title).toBe(
      "Se han cobrado 3 cuotas de Coche",
    );
  });
});

describe("esquemas de préstamo", () => {
  const terminos = {
    payment_account_id: "11111111-1111-4111-8111-111111111111",
    principal_cents: "10.000,00",
    term_months: "60",
    tin: "6",
    fee_mode: "PORCENTAJE",
    fee: "1",
    charge_day: "1",
    start_on: "2026-10-13",
    first_charge_on: null,
    disbursed: true,
  };

  it("convierte importe, TIN y comisión en % a enteros, y resuelve la primera cuota", () => {
    const r = loanTermsSchema.safeParse(terminos);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.principal_cents).toBe(1_000_000);
    expect(r.data.tin).toBe(60_000);
    expect(r.data.opening_fee_cents).toBe(10_000);
    expect(r.data.first_charge_on).toBe("2026-11-01");
    expect(r.data.term_months).toBe(60);
  });

  it("la comisión también en euros, y vacía es 0", () => {
    const e = loanTermsSchema.safeParse({ ...terminos, fee_mode: "IMPORTE", fee: "150,50" });
    expect(e.success && e.data.opening_fee_cents).toBe(15_050);
    const v = loanTermsSchema.safeParse({ ...terminos, fee: "" });
    expect(v.success && v.data.opening_fee_cents).toBe(0);
  });

  it("rechaza lo que rechazaría la base, con un mensaje decente", () => {
    const casos: [Record<string, unknown>, RegExp][] = [
      [{ tin: "6,12345" }, /TIN/],
      [{ tin: "51" }, /TIN/],
      [{ principal_cents: "99,99" }, /100 €/],
      [{ term_months: "0" }, /plazo/],
      [{ term_months: "12,5" }, /plazo/],
      [{ charge_day: "29" }, /día de cobro/],
      [{ fee_mode: "IMPORTE", fee: "10000" }, /comisión/],
      [{ disbursed: false }, /ya tenías apuntado/],
      [{ disbursed: undefined }, /entra ahora/],
      [{ first_charge_on: "2026-10-01" }, /posterior/],
      [{ first_charge_on: "2026-11-15" }, /día de cobro/],
      [{ payment_account_id: "" }, /cuenta/],
    ];
    for (const [cambio, mensaje] of casos) {
      const r = loanTermsSchema.safeParse({ ...terminos, ...cambio });
      expect(r.success, JSON.stringify(cambio)).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toMatch(mensaje);
    }
  });

  it("la vista previa no necesita cuenta", () => {
    const { payment_account_id, ...sinCuenta } = terminos;
    void payment_account_id;
    expect(loanPreviewSchema.safeParse(sinCuenta).success).toBe(true);
  });

  it("alta: la TAE es opcional (vacía → null) y exacta si se da", () => {
    const sin = loanCreateSchema.safeParse({ name: " Coche ", tae: null, terms: terminos });
    expect(sin.success && sin.data.tae).toBeNull();
    expect(sin.success && sin.data.name).toBe("Coche");
    const con = loanCreateSchema.safeParse({ name: "Coche", tae: "6,92", terms: terminos });
    expect(con.success && con.data.tae).toBe(69_200);
    expect(loanCreateSchema.safeParse({ name: "", tae: null, terms: terminos }).success).toBe(false);
    expect(loanCreateSchema.safeParse({ name: "x".repeat(41), tae: null, terms: terminos }).success).toBe(false);
  });

  it("alta: sin categoría, solo los intereses; la cuota entera exige categoría", () => {
    const cat = "33333333-3333-4333-8333-333333333333";
    const porDefecto = loanCreateSchema.safeParse({ name: "Coche", tae: null, terms: terminos });
    expect(porDefecto.success && porDefecto.data.category_id).toBeNull();
    expect(porDefecto.success && porDefecto.data.counts_full_installment).toBe(false);
    const entera = loanCreateSchema.safeParse({ name: "Coche", tae: null, terms: terminos, category_id: cat, counts_full_installment: true });
    expect(entera.success && entera.data.counts_full_installment).toBe(true);
    const sinCat = loanCreateSchema.safeParse({ name: "Coche", tae: null, terms: terminos, counts_full_installment: true });
    expect(sinCat.success).toBe(false);
    if (!sinCat.success) expect(sinCat.error.issues[0].message).toBe("Elige en qué categoría cuenta la cuota");
    expect(loanCreateSchema.safeParse({ name: "Coche", tae: null, terms: terminos, category_id: "x" }).success).toBe(false);
  });

  it("liquidar: comisión vacía es 0, en euros si se da", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(loanSettleSchema.parse({ id, fee_cents: "" }).fee_cents).toBe(0);
    expect(loanSettleSchema.parse({ id, fee_cents: "50" }).fee_cents).toBe(5_000);
    expect(loanSettleSchema.safeParse({ id, fee_cents: "-5" }).success).toBe(false);
  });
});
