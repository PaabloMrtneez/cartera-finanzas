import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { leerFilas, parseCsv, parseFecha, prepararTabla } from "./csv";

/**
 * Importación de extractos (fase 1: robustez). Un CSV de banco es la entrada
 * más grande y menos controlada de la app: cientos de importes de golpe.
 */

const SEMILLA = { seed: 20261019, numRuns: 1000 };
const columnas = { fecha: 0, concepto: 1, importe: 2 };

describe("parseFecha", () => {
  it("una fecha real en dd/mm/aaaa se lee siempre igual; una imposible es null", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2099 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 31 }), (a, m, d) => {
        const existe = d <= new Date(Date.UTC(a, m, 0)).getUTCDate();
        const r = parseFecha(`${d}/${m}/${a}`, "dmy");
        if (existe) expect(r).toBe(`${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
        else expect(r).toBeNull();
      }),
      SEMILLA,
    );
    expect(parseFecha("29/02/2028", "dmy")).toBe("2028-02-29");
    expect(parseFecha("29/02/2027", "dmy")).toBeNull();
    expect(parseFecha("31/04/2026", "dmy")).toBeNull();
  });
});

describe("leerFilas", () => {
  it("con texto arbitrario no revienta, y todo lo leído son céntimos enteros distintos de cero", () => {
    fc.assert(
      fc.property(fc.array(fc.array(fc.string({ maxLength: 15 }), { minLength: 0, maxLength: 4 }), { maxLength: 30 }), (filas) => {
        const r = leerFilas(filas, columnas, { conCabecera: false, todoGasto: false });
        for (const f of r.filas) {
          expect(Number.isSafeInteger(f.amount_cents)).toBe(true);
          expect(f.amount_cents).not.toBe(0);
        }
        expect(r.filas.length + r.descartadas.length).toBe(filas.length);
      }),
      SEMILLA,
    );
  });

  it("dos cargos idénticos el mismo día salen como DOS filas (deduplicar es cosa de la base)", () => {
    const r = leerFilas(
      [
        ["01/10/2026", "BUS", "-1,50"],
        ["01/10/2026", "BUS", "-1,50"],
      ],
      columnas,
      { conCabecera: false, todoGasto: false },
    );
    expect(r.filas).toHaveLength(2);
    // H-10: los duplicados se cuentan como multiconjunto contra la base
    // (lib/importar-duplicados.ts) y a `import_transactions` se le manda con
    // `p_skip_duplicates` apagado: las dos filas entran.
  });

  // H-04 aplicado a la importación: los extractos que ponen el signo detrás
  // («45,00-») o detrás de la divisa («EUR -45,00») entran como INGRESO.
  it("un cargo con el menos detrás («45,00-») se importa como gasto", () => {
    const r = leerFilas([["01/10/2026", "Recibo luz", "45,00-"]], columnas, { conCabecera: false, todoGasto: false });
    expect(r.filas[0].amount_cents).toBe(-4500);
  });

  it("todoGasto convierte cualquier signo en gasto", () => {
    const r = leerFilas([["01/10/2026", "x", "45,00"]], columnas, { conCabecera: false, todoGasto: true });
    expect(r.filas[0].amount_cents).toBe(-4500);
  });
});

describe("parseCsv y prepararTabla", () => {
  it("comillas, separadores dentro de comillas y saltos CRLF no rompen el número de columnas", () => {
    const filas = parseCsv('fecha;concepto;importe\r\n01/10/2026;"Bar; ""El Rincón""";-3,20\r\n', ";");
    expect(filas[1]).toEqual(["01/10/2026", 'Bar; "El Rincón"', "-3,20"]);
  });

  it("un fichero de 20 000 líneas se prepara en poco tiempo (sin cuadrático)", () => {
    const texto = Array.from({ length: 20_000 }, (_, i) => `01/10/2026;Concepto ${i};-${(i % 500) + 1},00`).join("\n");
    const inicio = performance.now();
    const { filas } = prepararTabla(texto, ";");
    expect(filas.length).toBe(20_000);
    expect(performance.now() - inicio).toBeLessThan(3000);
  });
});
