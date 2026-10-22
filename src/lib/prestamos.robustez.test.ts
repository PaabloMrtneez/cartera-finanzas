import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CuadroInvalido,
  PLAZO_MAXIMO,
  PRINCIPAL_MAXIMO,
  PRINCIPAL_MINIMO,
  TIN_MAXIMO,
  comisionPorPorcentaje,
  cuadroAmortizacion,
  hoyEnMadrid,
  leerTipo,
  primeraCuotaPorDefecto,
  resumenPrestamo,
  sumarMeses,
  taeCalculada,
  tipoComoDecimal,
} from "./prestamos";

/**
 * Propiedades del cuadro de amortización francés (fase 1: robustez). El cuadro
 * es lo que luego se COBRA: cualquier céntimo que se pierda aquí se pierde en
 * la cuenta de alguien. Semilla fija para que todo fallo sea reproducible.
 */

const SEMILLA = { seed: 20261019, numRuns: 150 };

/**
 * Un cuadro de 480 meses en BigInt cuesta milisegundos; cientos de ellos con
 * la cobertura activada pasan de los 5 s por defecto. Plazo holgado.
 */
const LENTO = { timeout: 60_000 };

const entrada = fc.record({
  principalCents: fc.integer({ min: PRINCIPAL_MINIMO, max: PRINCIPAL_MAXIMO }),
  plazoMeses: fc.integer({ min: 1, max: PLAZO_MAXIMO }),
  tin: fc.integer({ min: 0, max: TIN_MAXIMO * 10_000 }),
  primeraCuota: fc.constantFrom("2026-01-31", "2026-02-28", "2028-02-29", "2026-03-29", "2026-10-25", "2026-11-01"),
});

/** El cuadro o, si la base también lo rechazaría, null. */
function cuadroONull(e: Parameters<typeof cuadroAmortizacion>[0]) {
  try {
    return cuadroAmortizacion(e);
  } catch (error) {
    expect(error).toBeInstanceOf(CuadroInvalido);
    return null;
  }
}

describe("cuadroAmortizacion · invariantes del sistema francés", LENTO, () => {
  it("la suma del capital es el principal EXACTO y el pendiente acaba en cero", () => {
    let validos = 0;
    fc.assert(
      fc.property(entrada, (e) => {
        const cuadro = cuadroONull(e);
        if (!cuadro) return;
        validos++;
        expect(cuadro).toHaveLength(e.plazoMeses);
        expect(cuadro.reduce((s, f) => s + f.capital, 0)).toBe(e.principalCents);
        expect(cuadro[cuadro.length - 1].pendiente).toBe(0);
      }),
      SEMILLA,
    );
    // Que la propiedad no pase en vacío: la mayoría de entradas son válidas.
    expect(validos).toBeGreaterThan(SEMILLA.numRuns / 2);
  });

  it("cada fila cuadra: cuota = intereses + capital, todo entero y nada negativo", () => {
    fc.assert(
      fc.property(entrada, (e) => {
        const cuadro = cuadroONull(e);
        if (!cuadro) return;
        let pendienteAntes = e.principalCents;
        for (const f of cuadro) {
          for (const v of [f.cuota, f.intereses, f.capital, f.pendiente]) {
            expect(Number.isSafeInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
          }
          expect(f.cuota).toBe(f.intereses + f.capital);
          expect(f.pendiente).toBe(pendienteAntes - f.capital);
          pendienteAntes = f.pendiente;
        }
      }),
      SEMILLA,
    );
  });

  it("la cuota es constante salvo la última, que solo arrastra el redondeo (capitalizado)", () => {
    fc.assert(
      fc.property(entrada, (e) => {
        const cuadro = cuadroONull(e);
        if (!cuadro || cuadro.length < 2) return;
        const cuota = cuadro[0].cuota;
        for (const f of cuadro.slice(0, -1)) expect(f.cuota).toBe(cuota);
        // El medio céntimo de redondeo de la cuota y el de los intereses de
        // cada mes se capitalizan: como mucho 1 · ((1+i)ⁿ − 1)/i céntimos.
        const i = e.tin / 12_000_000;
        const capitalizado = i === 0 ? e.plazoMeses : (Math.pow(1 + i, e.plazoMeses) - 1) / i;
        const ultima = cuadro[cuadro.length - 1].cuota;
        expect(Math.abs(ultima - cuota)).toBeLessThanOrEqual(Math.ceil(capitalizado) + 1);
      }),
      SEMILLA,
    );
  });

  it("en préstamos normales (≤ 30 años, TIN ≤ 10 %) la última cuota se desvía menos de 10 €", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: PRINCIPAL_MINIMO, max: 100_000_000 }),
        fc.integer({ min: 1, max: 360 }),
        fc.integer({ min: 0, max: 100_000 }),
        (p, n, tin) => {
          const cuadro = cuadroONull({ principalCents: p, plazoMeses: n, tin, primeraCuota: "2026-11-01" });
          if (!cuadro) return;
          expect(Math.abs(cuadro[n - 1].cuota - cuadro[0].cuota)).toBeLessThan(1000);
        },
      ),
      SEMILLA,
    );
  });

  // H-08: con un TIN alto y un plazo largo, la cuota redondeada iguala a los
  // intereses: el capital de cada mes es 0 y TODO el principal se paga en la
  // última cuota. La base lo admite igual (es su espejo), y el formulario lo
  // enseña como un préstamo normal. 100 € a 40 años al 30 %: 479 cuotas de
  // 2,50 € que no amortizan nada y una última de 102,50 €.
  it("toda cuota amortiza algo: con capital 0 el cuadro se rechaza (CuadroInvalido)", () => {
    expect(() =>
      cuadroAmortizacion({ principalCents: 10_000, plazoMeses: 480, tin: 300_000, primeraCuota: "2026-11-01" }),
    ).toThrow(CuadroInvalido);
  });

  // Con 480 meses al 25 %, un céntimo de cuota mueve la última en miles de
  // euros: no hay cuota entera que cuadre. No se enseña un cuadro con la
  // última cuota desviada 979 €: se rechaza con un error claro.
  it("50.000 € a 40 años al 25 % no da un cuadro con la última cuota desviada 979 €", () => {
    expect(() =>
      cuadroAmortizacion({ principalCents: 5_000_000, plazoMeses: 480, tin: 250_000, primeraCuota: "2026-11-01" }),
    ).toThrow(/no amortiza/);
  });

  it("todo cuadro aceptado tiene la última cuota a menos del 10 % (o de 1 €) de las demás", () => {
    fc.assert(
      fc.property(entrada, (e) => {
        const cuadro = cuadroONull(e);
        if (!cuadro || cuadro.length < 2) return;
        const normal = cuadro[0].cuota;
        const desvio = Math.abs(cuadro[cuadro.length - 1].cuota - normal);
        expect(desvio).toBeLessThanOrEqual(Math.max(100, Math.floor(normal / 10)));
        for (const f of cuadro) expect(f.capital).toBeGreaterThan(0);
      }),
      SEMILLA,
    );
  });

  it("los intereses no suben y el capital no baja de un mes al siguiente (salvo el último)", () => {
    fc.assert(
      fc.property(entrada, (e) => {
        const cuadro = cuadroONull(e);
        if (!cuadro) return;
        for (let k = 1; k < cuadro.length - 1; k++) {
          expect(cuadro[k].intereses).toBeLessThanOrEqual(cuadro[k - 1].intereses);
          expect(cuadro[k].capital).toBeGreaterThanOrEqual(cuadro[k - 1].capital);
        }
      }),
      SEMILLA,
    );
  });

  it("la cuota está a menos de 1 céntimo de la fórmula cerrada en coma flotante", () => {
    fc.assert(
      fc.property(entrada, (e) => {
        fc.pre(e.tin > 0 && e.plazoMeses <= 360);
        const cuadro = cuadroONull(e);
        if (!cuadro) return;
        const i = e.tin / 12_000_000;
        const formula = (e.principalCents * i) / (1 - Math.pow(1 + i, -e.plazoMeses));
        expect(Math.abs(cuadro[0].cuota - formula)).toBeLessThanOrEqual(1);
      }),
      SEMILLA,
    );
  });

  it("TIN 0 %: sin intereses y la cuota es el principal entre los meses, redondeado", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: PRINCIPAL_MINIMO, max: PRINCIPAL_MAXIMO }),
        fc.integer({ min: 1, max: PLAZO_MAXIMO }),
        (p, n) => {
          const cuadro = cuadroONull({ principalCents: p, plazoMeses: n, tin: 0, primeraCuota: "2026-11-01" });
          if (!cuadro) return;
          expect(cuadro.every((f) => f.intereses === 0)).toBe(true);
          expect(cuadro[0].cuota).toBe(Math.round(p / n));
        },
      ),
      SEMILLA,
    );
  });

  it("casos límite: 1 mes, 480 meses, principal mínimo y máximo, TIN máximo", () => {
    const uno = cuadroAmortizacion({ principalCents: 1_000_000, plazoMeses: 1, tin: 65_000, primeraCuota: "2026-11-01" });
    expect(uno).toHaveLength(1);
    expect(uno[0].capital).toBe(1_000_000);
    expect(uno[0].intereses).toBe(5417); // 10.000 € × 6,5 % / 12 = 54,166… → 54,17 €

    // Principal máximo, 480 meses: con TIN máximo la última cuota no cuadra
    // (H-08) y se rechaza; con un TIN de hipoteca, el cuadro sale exacto.
    expect(() =>
      cuadroAmortizacion({
        principalCents: PRINCIPAL_MAXIMO,
        plazoMeses: PLAZO_MAXIMO,
        tin: TIN_MAXIMO * 10_000,
        primeraCuota: "2026-11-01",
      }),
    ).toThrow(CuadroInvalido);
    const largo = cuadroAmortizacion({
      principalCents: PRINCIPAL_MAXIMO,
      plazoMeses: PLAZO_MAXIMO,
      tin: 40_000,
      primeraCuota: "2026-11-01",
    });
    expect(largo).toHaveLength(480);
    expect(largo.reduce((s, f) => s + f.capital, 0)).toBe(PRINCIPAL_MAXIMO);

    // Principal mínimo, 480 meses, TIN máximo: la cuota es casi todo intereses.
    // O da un cuadro válido o se rechaza con el mensaje de la base, nunca otra cosa.
    const r = cuadroONull({ principalCents: PRINCIPAL_MINIMO, plazoMeses: 480, tin: 500_000, primeraCuota: "2026-11-01" });
    if (r) expect(r.reduce((s, f) => s + f.capital, 0)).toBe(PRINCIPAL_MINIMO);
  });

  it("rechaza con CuadroInvalido (no con otro error) lo que no es un préstamo", () => {
    const base = { principalCents: 1_000_000, plazoMeses: 12, tin: 65_000, primeraCuota: "2026-11-01" };
    for (const malo of [
      { principalCents: 0 },
      { principalCents: -5 },
      { principalCents: 1.5 },
      { principalCents: Number.NaN },
      { principalCents: Number.POSITIVE_INFINITY },
      { plazoMeses: 0 },
      { plazoMeses: 481 },
      { plazoMeses: 12.5 },
      { tin: -1 },
      { tin: TIN_MAXIMO * 10_000 + 1 },
      { tin: 0.5 },
    ]) {
      expect(() => cuadroAmortizacion({ ...base, ...malo })).toThrow(CuadroInvalido);
    }
  });
});

describe("fechas de las cuotas", () => {
  it("cada cuota cae el mismo día que la primera, recortado al fin de mes, sin deriva", () => {
    const cuadro = cuadroAmortizacion({ principalCents: 1_000_000, plazoMeses: 14, tin: 50_000, primeraCuota: "2026-01-31" });
    expect(cuadro.map((f) => f.fecha).slice(0, 5)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31", // no 28: se suma desde la primera, no encadenando
      "2026-04-30",
      "2026-05-31",
    ]);
    expect(cuadro[13].fecha).toBe("2027-02-28");
  });

  it("sumarMeses: el día se conserva si existe y si no se recorta; ida y vuelta para días ≤ 28", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: -600, max: 600 }),
        (a, m, d, delta) => {
          const dias = new Date(Date.UTC(a, m, 0)).getUTCDate();
          fc.pre(d <= dias);
          const iso = `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const r = sumarMeses(iso, delta);
          const [ra, rm, rd] = r.split("-").map(Number);
          const diasDestino = new Date(Date.UTC(ra, rm, 0)).getUTCDate();
          expect(rd).toBe(Math.min(d, diasDestino));
          expect((ra * 12 + rm) - (a * 12 + m)).toBe(delta);
          if (d <= 28) expect(sumarMeses(r, -delta)).toBe(iso);
        },
      ),
      { ...SEMILLA, numRuns: 2000 },
    );
  });

  it("29 de febrero: en un año bisiesto existe y en el siguiente se recorta al 28", () => {
    expect(sumarMeses("2028-01-29", 1)).toBe("2028-02-29");
    expect(sumarMeses("2028-02-29", 12)).toBe("2029-02-28");
    expect(sumarMeses("2100-01-29", 1)).toBe("2100-02-28"); // 2100 no es bisiesto
  });

  it("hoyEnMadrid atraviesa bien los cambios de hora (último domingo de marzo y de octubre)", () => {
    // 29-03-2026: a las 02:00 CET pasan a ser las 03:00 CEST.
    expect(hoyEnMadrid(new Date("2026-03-28T22:59:59Z"))).toBe("2026-03-28");
    expect(hoyEnMadrid(new Date("2026-03-28T23:00:00Z"))).toBe("2026-03-29");
    // 25-10-2026: a las 03:00 CEST vuelven a ser las 02:00 CET.
    expect(hoyEnMadrid(new Date("2026-10-24T21:59:59Z"))).toBe("2026-10-24");
    expect(hoyEnMadrid(new Date("2026-10-24T22:00:00Z"))).toBe("2026-10-25");
    expect(hoyEnMadrid(new Date("2026-10-25T22:59:59Z"))).toBe("2026-10-25");
    expect(hoyEnMadrid(new Date("2026-10-25T23:00:00Z"))).toBe("2026-10-26");
    // Nochevieja: en UTC aún es 2026, en Madrid ya es 2027.
    expect(hoyEnMadrid(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });

  it("primeraCuotaPorDefecto con días de cobro 1–28 da siempre una fecha real del mes siguiente", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2100 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }), (a, m, dia) => {
        const inicio = `${a}-${String(m).padStart(2, "0")}-15`;
        const r = primeraCuotaPorDefecto(inicio, dia);
        expect(sumarMeses(`${a}-${String(m).padStart(2, "0")}-${String(dia).padStart(2, "0")}`, 1)).toBe(r);
      }),
      SEMILLA,
    );
  });

  // H-17 (bajo): el esquema limita el día de cobro a 1–28, pero la función no se
  // protege sola: con 31 en noviembre fabrica una fecha que no existe.
  it("primeraCuotaPorDefecto con día 31 no fabrica el 31 de noviembre", () => {
    expect(primeraCuotaPorDefecto("2026-10-13", 31)).not.toBe("2026-11-31");
  });
});

describe("tipos, comisión y TAE", LENTO, () => {
  it("leerTipo y tipoComoDecimal son ida y vuelta exacta para 0–50 % con hasta 4 decimales", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: TIN_MAXIMO * 10_000 }), fc.constantFrom(",", "."), (t, sep) => {
        const texto = tipoComoDecimal(t).replace(".", sep);
        expect(leerTipo(texto)).toBe(t);
        expect(leerTipo(`${texto} %`)).toBe(t);
      }),
      { ...SEMILLA, numRuns: 2000 },
    );
  });

  it("leerTipo no revienta con texto arbitrario y nunca devuelve algo fuera de rango", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (texto) => {
        const t = leerTipo(texto);
        expect(t === null || (Number.isSafeInteger(t) && t >= 0 && t <= TIN_MAXIMO * 10_000)).toBe(true);
      }),
      { ...SEMILLA, numRuns: 3000 },
    );
    for (const raro of ["-1", "−1", "1e2", "NaN", "Infinity", "6,5,5", "50,0001", "١", "0x10"]) {
      expect(leerTipo(raro)).toBeNull();
    }
  });

  it("comisionPorPorcentaje redondea al céntimo más cercano (empate hacia arriba) sin floats", () => {
    fc.assert(
      fc.property(fc.integer({ min: PRINCIPAL_MINIMO, max: PRINCIPAL_MAXIMO }), fc.integer({ min: 0, max: 1_000_000 }), (p, t) => {
        const c = comisionPorPorcentaje(p, t);
        const num = BigInt(p) * BigInt(t);
        const den = BigInt(1_000_000);
        // |c − p·t/den| ≤ ½  ⇔  |2·c·den − 2·num| ≤ den
        const dif = BigInt(2) * BigInt(c) * den - BigInt(2) * num;
        expect(dif <= den && dif > -den).toBe(true);
      }),
      { ...SEMILLA, numRuns: 2000 },
    );
  });

  it("sin comisión, la TAE es la efectiva del TIN: (1 + TIN/12)^12 − 1, a dos decimales", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 300_000 }), fc.integer({ min: 12, max: 360 }), (tin, n) => {
        // Con TIN altos y plazos largos el cuadro se rechaza (H-08): ahí no hay TAE.
        if (!cuadroONull({ principalCents: 2_000_000, plazoMeses: n, tin, primeraCuota: "2026-11-01" })) return;
        const r = resumenPrestamo({ principalCents: 2_000_000, plazoMeses: n, tin, primeraCuota: "2026-11-01", comisionCents: 0 });
        const efectiva = (Math.pow(1 + tin / 12_000_000, 12) - 1) * 100;
        expect(r.tae).not.toBeNull();
        // El redondeo de las cuotas al céntimo mueve la TAE como mucho unas centésimas.
        expect(Math.abs((r.tae as number) - efectiva)).toBeLessThan(0.06);
      }),
      SEMILLA,
    );
  });

  it("una comisión de apertura siempre sube la TAE (nunca la baja)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200_000 }), fc.integer({ min: 1, max: 50_000 }), (tin, comision) => {
        const base = { principalCents: 2_000_000, plazoMeses: 60, tin, primeraCuota: "2026-11-01" };
        const sin = resumenPrestamo({ ...base, comisionCents: 0 }).tae as number;
        const con = resumenPrestamo({ ...base, comisionCents: comision }).tae as number;
        expect(con).toBeGreaterThanOrEqual(sin);
      }),
      SEMILLA,
    );
  });

  it("taeCalculada con datos degenerados devuelve null o 0, no NaN", () => {
    expect(taeCalculada([], 100)).toBeNull();
    expect(taeCalculada([100], 0)).toBeNull();
    expect(taeCalculada([100], -5)).toBeNull();
    expect(taeCalculada([50], 100)).toBe(0); // se devuelve menos de lo recibido
    expect(taeCalculada([1_000_000], 1)).toBeNull(); // > 100 % mensual
  });
});
