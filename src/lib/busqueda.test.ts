import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { citarValorPostgrest, escaparComodinesLike, patronContienePostgrest } from "./busqueda";

describe("escaparComodinesLike", () => {
  it.each([
    ["", ""],
    ["mercadona", "mercadona"],
    ["50%", "50\\%"],
    ["mi_tienda", "mi\\_tienda"],
    ["c:\\ruta", "c:\\\\ruta"],
    // La barra se escapa ANTES de mirar lo que sigue: «\%» son dos literales.
    ["\\%", "\\\\\\%"],
    // Lo que no es comodín de LIKE pasa tal cual: aquí no hay gramática de
    // PostgREST que proteger, el texto va como parámetro.
    ["Amazon, Inc. (ES)", "Amazon, Inc. (ES)"],
    ['"comillas"', '"comillas"'],
    ["a*b", "a*b"],
    ["Café Ñandú", "Café Ñandú"],
    ["😀 €", "😀 €"],
  ])("%j → %j", (entrada, salida) => {
    expect(escaparComodinesLike(entrada)).toBe(salida);
  });
});

describe("patronContienePostgrest", () => {
  it("envuelve en % para buscar «contiene»", () => {
    expect(patronContienePostgrest("super")).toBe("%super%");
  });

  it("el texto vacío es «cualquier cosa» (quien llama ya lo evita)", () => {
    expect(patronContienePostgrest("")).toBe("%%");
  });

  it("escapa los comodines de Postgres", () => {
    expect(patronContienePostgrest("50%_x")).toBe("%50\\%\\_x%");
    expect(patronContienePostgrest("a\\b")).toBe("%a\\\\b%");
  });

  it("el * —que PostgREST convertiría en %— pasa a ser un solo carácter", () => {
    expect(patronContienePostgrest("a*b")).toBe("%a_b%");
    expect(patronContienePostgrest("*")).toBe("%_%");
  });

  it("deja la coma, el punto, el paréntesis y las comillas como texto", () => {
    expect(patronContienePostgrest('S.L., "x" (y)')).toBe('%S.L., "x" (y)%');
  });

  it("no toca los acentos ni las mayúsculas: ILIKE ya las iguala", () => {
    expect(patronContienePostgrest("CAFÉ")).toBe("%CAFÉ%");
  });
});

describe("citarValorPostgrest", () => {
  it.each([
    ["", '""'],
    ["texto", '"texto"'],
    ["a,b", '"a,b"'],
    ["f(x)", '"f(x)"'],
    ["s.l.", '"s.l."'],
    ['di "hola"', '"di \\"hola\\""'],
    ["c:\\ruta", '"c:\\\\ruta"'],
    ['\\"', '"\\\\\\""'],
    ["50%_*", '"50%_*"'],
    ["Ñandú 😀", '"Ñandú 😀"'],
  ])("%j → %j", (entrada, salida) => {
    expect(citarValorPostgrest(entrada)).toBe(salida);
  });

  it("una inyección clásica queda dentro de las comillas", () => {
    const citado = citarValorPostgrest('x",id.neq.0,description.eq."');
    // Solo las dos comillas de los extremos quedan sin escapar.
    const sinEscapar = citado.replace(/\\./g, "").match(/"/g) ?? [];
    expect(sinEscapar).toHaveLength(2);
    expect(citado.startsWith('"') && citado.endsWith('"')).toBe(true);
  });
});

/**
 * Vigilancia: ningún filtro de PostgREST lleva texto interpolado sin citar.
 *
 * Pasó: la búsqueda global y el selector de reembolsos hacían
 * `.or(\`description.ilike.%${texto}%,…\`)`, y una coma en lo escrito partía el
 * filtro en dos. Se buscan llamadas `.or(`, `.and(`, `.not(`, `.filter(`,
 * `.ilike(` y `.like(` cuyo argumento sea una plantilla con `${…}`; cada
 * interpolación tiene que pasar por una de las funciones de `busqueda.ts`.
 */
function ficheros(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const completa = join(dir, entrada);
    if (statSync(completa).isDirectory()) ficheros(completa, acc);
    else if (/\.tsx?$/.test(entrada) && !/\.test\.tsx?$/.test(entrada)) acc.push(completa);
  }
  return acc;
}

const SEGURAS = /^\$\{\s*(citarValorPostgrest|patronContienePostgrest|escaparComodinesLike)\(/;

describe("filtros de PostgREST", () => {
  it("no interpolan texto sin pasar por busqueda.ts", () => {
    const sospechosas: string[] = [];
    for (const ruta of ficheros("src")) {
      const codigo = readFileSync(ruta, "utf8");
      const llamadas = codigo.matchAll(/\.(?:or|and|not|filter|ilike|like)\(\s*[^)]*?`([^`]*)`/g);
      for (const [completa, plantilla] of llamadas) {
        const interpolaciones = plantilla.match(/\$\{[^}]*\}?/g) ?? [];
        if (interpolaciones.some((i) => !SEGURAS.test(i))) {
          sospechosas.push(`${ruta}: ${completa.replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    }
    expect(sospechosas).toEqual([]);
  });
});
