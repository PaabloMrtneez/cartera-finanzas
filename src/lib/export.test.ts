import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { centsToDecimalString, toCsv } from "./export";

describe("centsToDecimalString", () => {
  it("separa euros y céntimos sin pasar por coma flotante", () => {
    expect(centsToDecimalString(1337455)).toBe("13374,55");
    expect(centsToDecimalString(1240)).toBe("12,40");
    expect(centsToDecimalString(5)).toBe("0,05");
    expect(centsToDecimalString(0)).toBe("0,00");
    expect(centsToDecimalString(100)).toBe("1,00");
  });

  it("mantiene el signo de los saldos negativos", () => {
    expect(centsToDecimalString(-43200)).toBe("-432,00");
    expect(centsToDecimalString(-5)).toBe("-0,05");
  });

  it("no agrupa millares: rompería la columna del CSV", () => {
    expect(centsToDecimalString(123456789)).toBe("1234567,89");
  });

  it("no pierde precisión donde la división en coma flotante la perdería", () => {
    // 0,29 * 100 da 28.999999999999996 en coma flotante. Aquí no hay división.
    expect(centsToDecimalString(29)).toBe("0,29");
    expect(centsToDecimalString(70)).toBe("0,70");
    // Un patrimonio grande, céntimo a céntimo.
    for (const c of [999999999, 100000001, 8640000, 1000000000000]) {
      const texto = centsToDecimalString(c);
      const vuelta = Number(texto.replace(",", ""));
      expect(vuelta).toBe(c);
    }
  });
});

describe("toCsv", () => {
  it("separa por punto y coma, porque la coma ya es el decimal", () => {
    const csv = toCsv(["Fecha", "Importe"], [["2026-08-18", "12,40"]]);
    expect(csv).toContain("Fecha;Importe");
    expect(csv).toContain("2026-08-18;12,40");
  });

  it("entrecomilla lo que llevaría punto y coma, comillas o saltos de línea", () => {
    const csv = toCsv(["a"], [["Bar; Restaurante"], ['Dijo "hola"'], ["dos\nlíneas"]]);
    expect(csv).toContain('"Bar; Restaurante"');
    expect(csv).toContain('"Dijo ""hola"""');
    expect(csv).toContain('"dos\nlíneas"');
  });

  it("deja vacías las celdas nulas, sin escribir null", () => {
    const csv = toCsv(["a", "b"], [["x", null]]);
    expect(csv).toContain("x;");
    expect(csv).not.toContain("null");
  });

  it("empieza por la marca de orden de bytes, o Excel destroza los acentos", () => {
    expect(toCsv(["Categoría"], [])).toMatch(/^﻿/);
  });

  it("neutraliza las fórmulas anteponiendo un apóstrofo (CWE-1236)", () => {
    const csv = toCsv(
      ["Concepto"],
      [["=HYPERLINK(\"http://malo\")"], ["+1+1"], ["-50% dto"], ["@SUM(A1)"]],
    );
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1+1");
    expect(csv).toContain("'-50% dto");
    expect(csv).toContain("'@SUM(A1)");
  });

  it("no toca un importe positivo: no empieza por carácter de fórmula", () => {
    const csv = toCsv(["Importe"], [[centsToDecimalString(1337455)]]);
    expect(csv).toContain("13374,55");
    expect(csv).not.toContain("'13374,55");
  });

  it("una fórmula con punto y coma queda neutralizada Y entrecomillada", () => {
    const csv = toCsv(["a"], [["=A1;B2"]]);
    expect(csv).toContain('"\'=A1;B2"');
  });
});

describe("el endpoint de exportación", () => {
  const fuente = readFileSync("src/app/api/exportar/route.ts", "utf8");

  /**
   * Es el único sitio que vuelca todos los datos de una persona en una sola
   * respuesta. Con el cliente de la sesión, la seguridad a nivel de fila
   * devuelve solo lo suyo; con la clave de servicio se saltaría entera y
   * exportaría los de las cuatro personas sin dar ningún error.
   */
  it("usa el cliente de la sesión, nunca la clave de servicio", () => {
    expect(fuente).toContain('from "@/lib/supabase/server"');
    expect(fuente).not.toContain("SERVICE_ROLE");
    // El cliente crudo de la librería es el que acepta una clave cualquiera, y
    // por tanto el que permitiría entrar como servicio. El de `supabase/server`
    // solo sabe leer la sesión de las cookies.
    expect(fuente).not.toContain('from "@supabase/supabase-js"');
  });

  /**
   * PostgREST corta cada respuesta a 1.000 filas sin avisar: una copia sin
   * paginar sale incompleta para cualquiera con más de 1.000 movimientos.
   * Cada `.from(…)` del endpoint va dentro de `leerTodo` con su `.range`.
   */
  it("lee todas las tablas paginadas (leerTodo + range), nunca de una vez", () => {
    const lecturas = fuente.match(/\.from\("/g) ?? [];
    const paginadas = fuente.match(/leerTodo\(/g) ?? [];
    const rangos = fuente.match(/\.range\(/g) ?? [];
    expect(lecturas.length).toBeGreaterThan(0);
    expect(paginadas.length).toBe(lecturas.length);
    expect(rangos.length).toBe(lecturas.length);
  });

  it("exige sesión antes de exportar nada", () => {
    expect(fuente).toContain("auth.getUser()");
    expect(fuente).toContain("status: 401");
  });
});
