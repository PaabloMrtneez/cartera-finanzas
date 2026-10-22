/**
 * Leer TODAS las filas de una consulta de PostgREST, de mil en mil.
 *
 * PostgREST (el `db-max-rows` de Supabase) corta cualquier respuesta a 1.000
 * filas EN SILENCIO: no da error, solo menos filas. Era el hallazgo C2 de
 * docs/pruebas/informe-datos.md: la copia de seguridad de alguien con más de
 * 1.000 movimientos salía incompleta, la curva de Inversiones perdía fondos y
 * Movimientos no pasaba de 1.000 aunque se pidieran 5.000.
 *
 * `consulta(desde, hasta)` construye la consulta ENTERA cada vez y le aplica
 * `.range(desde, hasta)`. Tiene que llevar un orden TOTAL (que acabe en una
 * columna única, como `id`): con empates, dos páginas pueden repetir o saltarse
 * filas, porque cada página es una consulta distinta.
 *
 * Vale igual para tablas, vistas y funciones (`supabase.rpc(…).range(…)`). Para
 * una función, cada página la vuelve a ejecutar: úsese donde casi siempre
 * cabe en una página y paginar es la red de seguridad.
 *
 * Módulo neutral (ni servidor ni cliente): sin dependencias.
 */

/** Lo que devuelve PostgREST en una página. Debe ser <= db-max-rows (1.000). */
export const FILAS_POR_PAGINA = 1000;

type Respuesta<T> = { data: T[] | null; error: { message: string } | null };

export type OpcionesLeerTodo = {
  /** Filas por página (por defecto 1.000, el tope del servidor). */
  pagina?: number;
  /** No leer más de estas filas en total (por defecto, todas). */
  maximo?: number;
};

export async function leerTodo<T>(
  consulta: (desde: number, hasta: number) => PromiseLike<Respuesta<T>>,
  { pagina = FILAS_POR_PAGINA, maximo = Number.POSITIVE_INFINITY }: OpcionesLeerTodo = {},
): Promise<{ data: T[]; error: { message: string } | null }> {
  if (!Number.isInteger(pagina) || pagina < 1) throw new RangeError("pagina debe ser un entero positivo");
  const filas: T[] = [];
  while (filas.length < maximo) {
    const desde = filas.length;
    const pedidas = Math.min(pagina, maximo - desde);
    const { data, error } = await consulta(desde, desde + pedidas - 1);
    if (error) return { data: filas, error };
    const trozo = data ?? [];
    for (const fila of trozo) filas.push(fila);
    // Una página incompleta es la última (no hay más filas).
    if (trozo.length < pedidas) break;
  }
  return { data: filas, error: null };
}
