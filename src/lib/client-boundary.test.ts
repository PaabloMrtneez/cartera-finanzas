import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Un componente de SERVIDOR no puede usar valores exportados por un módulo
 * `"use client"`.
 *
 * Next sustituye los exports de un módulo cliente por referencias, así que lo
 * que llega al servidor no es el array ni la función, sino un proxy. Usarlo
 * revienta en tiempo de ejecución con «is not a function» y tumba la página
 * entera.
 *
 * Esta prueba existe porque ha pasado DOS veces:
 *
 *   · `activeFilterCount`, exportada desde el módulo de filtros
 *   · `RANGOS`, exportada desde el conmutador de rango de Patrimonio, que dejó
 *     la pantalla de Patrimonio sin cargar
 *
 * Y no lo caza nadie más: typecheck, lint y build pasan los tres, porque
 * TypeScript ve el tipo real. Solo se ve abriendo la página.
 *
 * La regla es un heurístico deliberadamente simple: de un módulo cliente, un
 * componente de servidor solo puede importar TIPOS y COMPONENTES. Los
 * componentes se distinguen porque van en mayúscula inicial y no son
 * CONSTANTES_EN_MAYUSCULAS; cualquier otro valor es sospechoso y debe vivir en
 * un módulo neutral, como `lib/filters.ts` o `lib/rangos.ts`.
 */

const RAIZ = "src";

function ficheros(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const completa = join(dir, entrada);
    if (statSync(completa).isDirectory()) ficheros(completa, acc);
    else if (/\.tsx?$/.test(entrada) && !/\.test\.tsx?$/.test(entrada)) acc.push(completa);
  }
  return acc;
}

const todos = ficheros(RAIZ);

const esCliente = (ruta: string) => {
  const cabecera = readFileSync(ruta, "utf8").slice(0, 200);
  return /^\s*["']use client["']/m.test(cabecera);
};

const clientes = new Set(todos.filter(esCliente).map((f) => resolve(f)));

/** Resuelve un import a un fichero del proyecto, o null si es externo. */
function resolver(desde: string, especificador: string): string | null {
  if (!especificador.startsWith("@/") && !especificador.startsWith(".")) return null;

  const base = especificador.startsWith("@/")
    ? resolve(RAIZ, especificador.slice(2))
    : resolve(dirname(desde), especificador);

  for (const candidato of [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    try {
      if (statSync(candidato).isFile()) return resolve(candidato);
    } catch {
      // Sigue probando.
    }
  }
  return null;
}

/** Un componente: mayúscula inicial y no una CONSTANTE. */
const pareceComponente = (nombre: string) =>
  /^[A-Z]/.test(nombre) && nombre !== nombre.toUpperCase();

describe("la frontera entre servidor y cliente", () => {
  it("ningún componente de servidor importa valores de un módulo «use client»", () => {
    const infracciones: string[] = [];

    for (const fichero of todos) {
      if (esCliente(fichero)) continue;

      const fuente = readFileSync(fichero, "utf8");

      for (const m of fuente.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
        const clausula = m[1];
        const destino = resolver(fichero, m[2]);
        if (!destino || !clientes.has(destino)) continue;

        // `import type { ... }` se borra al compilar: no llega nada al servidor.
        if (/^\s*type\b/.test(clausula)) continue;

        const llaves = clausula.match(/\{([\s\S]*)\}/);
        if (!llaves) continue;

        for (const bruto of llaves[1].split(",")) {
          const nombre = bruto.trim().split(/\s+as\s+/)[0].trim();
          if (!nombre || nombre.startsWith("type ")) continue;
          if (pareceComponente(nombre)) continue;

          infracciones.push(
            `${fichero.replace(/\\/g, "/")} importa «${nombre}» de ${m[2]}, que es "use client". ` +
              `Muévelo a un módulo neutral en src/lib.`,
          );
        }
      }
    }

    expect(infracciones).toEqual([]);
  });

  it("hay módulos cliente y de servidor, o la prueba no está mirando nada", () => {
    expect(clientes.size).toBeGreaterThan(5);
    expect(todos.length - clientes.size).toBeGreaterThan(10);
  });
});
