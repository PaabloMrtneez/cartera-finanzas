/**
 * Exportación de los datos a CSV y JSON.
 *
 * Los dos formatos existen porque sirven a cosas distintas, y esa diferencia
 * decide cómo se escriben los importes:
 *
 *   · CSV es para abrirlo en Excel: importes en euros con coma decimal, que es
 *     lo que espera un Excel en español.
 *   · JSON es la copia de seguridad fiel: importes en céntimos enteros, tal y
 *     como están guardados. Es el formato del que se puede restaurar sin
 *     perder ni un céntimo.
 */

/**
 * 1337455 → "13374,55". Aritmética entera pura, a propósito.
 *
 * `formatCentsPlain` serviría, pero divide entre 100 en coma flotante y mete
 * separador de millares, que en un CSV rompe la columna. Aquí el entero y los
 * céntimos se separan con módulo y nunca llegan a ser un decimal.
 */
export function centsToDecimalString(cents: number): string {
  const signo = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${signo}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Neutraliza la inyección de fórmulas (CWE-1236).
 *
 * Excel y Sheets evalúan como fórmula toda celda que empiece por `=`, `+`, `-`,
 * `@`, tabulador o retorno de carro. Un movimiento con la descripción
 * `=HYPERLINK(...)` o `=cmd|'/c calc'!A1` se ejecutaría al abrir el CSV. Se
 * antepone un apóstrofo, que fuerza a Excel a tratar la celda como texto.
 *
 * No corrompe la columna de importes: se exportan siempre en positivo (la base
 * los guarda con `amount_cents > 0`), así que ninguno empieza por `-`.
 */
function neutralizarFormula(texto: string): string {
  return /^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto;
}

/**
 * Un campo de CSV, escapado.
 *
 * El separador es `;`, no `,`, porque el decimal español YA es la coma: con
 * `,` de separador, "12,40" se leería como dos columnas. Excel en español
 * espera `;` precisamente por esto.
 */
function campo(valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined) return "";
  const texto = neutralizarFormula(String(valor));
  return /[;"\n\r]/.test(texto) ? `"${texto.replaceAll('"', '""')}"` : texto;
}

export function toCsv(cabeceras: string[], filas: (string | number | null)[][]): string {
  const lineas = [cabeceras.map(campo).join(";")];
  for (const fila of filas) lineas.push(fila.map(campo).join(";"));
  // Marca de orden de bytes: sin ella Excel abre el fichero en la codificación
  // del sistema y destroza cada acento y cada eñe.
  return "﻿" + lineas.join("\r\n") + "\r\n";
}

export const ETIQUETA_TIPO: Record<string, string> = {
  EXPENSE: "Gasto",
  INCOME: "Ingreso",
  TRANSFER: "Traspaso",
};

export const ETIQUETA_ESTADO: Record<string, string> = {
  CONFIRMED: "Confirmado",
  PENDING: "Pendiente",
  DISCARDED: "Descartado",
};

/** `cartera-movimientos-2026-08-18.csv` */
export function nombreFichero(que: string, extension: string, hoy: string): string {
  return `cartera-${que}-${hoy}.${extension}`;
}
