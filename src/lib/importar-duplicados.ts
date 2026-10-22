import type { FilaLeida } from "./csv";

/**
 * Duplicados de una importación, como MULTICONJUNTO (H-10).
 *
 * Antes, `import_transactions` daba por duplicada toda fila repetida DENTRO
 * del mismo fichero: dos billetes de autobús de 1,50 € el mismo día acababan
 * siendo uno, y el resumen lo contaba como «duplicado», que es justo lo que
 * la persona espera leer. Y contra la base comprobaba «existe», no «cuántas»:
 * con un «BUS 1,50» ya guardado, de los dos del extracto no entraba ninguno.
 *
 * Ahora, para cada fila (fecha, concepto, importe, tipo) con n copias en el
 * fichero y m en la base, entran max(0, n − m), y son duplicadas min(n, m).
 * Las que entran son las ÚLTIMAS del fichero: las primeras se toman por las
 * que ya estaban. La comparación es la misma que hacía la base: concepto
 * exacto, importe en positivo y el tipo según el signo.
 */

export type Existente = {
  occurred_on: string;
  description: string;
  amount_cents: number;
  type: string;
};

function clave(fecha: string, concepto: string, centimos: number, tipo: string): string {
  return JSON.stringify([fecha, concepto, centimos, tipo]);
}

export function contarDuplicadas(
  filas: FilaLeida[],
  existentes: Existente[],
): { nuevas: FilaLeida[]; duplicadas: number } {
  const enLaBase = new Map<string, number>();
  for (const e of existentes) {
    const k = clave(e.occurred_on, e.description, e.amount_cents, e.type);
    enLaBase.set(k, (enLaBase.get(k) ?? 0) + 1);
  }

  const nuevas: FilaLeida[] = [];
  let duplicadas = 0;
  for (const f of filas) {
    const tipo = f.amount_cents < 0 ? "EXPENSE" : "INCOME";
    const k = clave(f.occurred_on, f.description, Math.abs(f.amount_cents), tipo);
    const quedan = enLaBase.get(k) ?? 0;
    if (quedan > 0) {
      enLaBase.set(k, quedan - 1);
      duplicadas++;
    } else {
      nuevas.push(f);
    }
  }
  return { nuevas, duplicadas };
}
