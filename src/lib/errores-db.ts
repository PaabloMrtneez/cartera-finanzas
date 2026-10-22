/**
 * Errores de Postgres (vía PostgREST) → un mensaje en español para la persona
 * (H-01). Antes, lo que una acción no reconocía llegaba TAL CUAL a la
 * pantalla: en inglés y con nombres de tablas, columnas y restricciones.
 *
 * Cada acción sigue traduciendo primero sus restricciones conocidas (con su
 * mensaje preciso); esto es la red de debajo, común a todas:
 *
 *   1. Los mensajes que escriben NUESTRAS funciones SQL (`raise exception
 *      'Este préstamo ya tiene cuotas cobradas…'`) ya están en español y
 *      pensados para la persona: pasan tal cual.
 *   2. Lo técnico se reconoce por su forma y se traduce a algo accionable.
 *   3. Lo que no se reconoce: «No se ha podido guardar. Inténtalo de nuevo.»,
 *      y el detalle va al registro del servidor, nunca a la pantalla.
 */

export const ERROR_GENERICO = "No se ha podido guardar. Inténtalo de nuevo.";
export const NO_ENCONTRADO = "No se ha encontrado. Recarga la página.";
export const SESION_CADUCADA = "Sesión caducada. Vuelve a entrar.";

type ErrorDb = { message?: string | null; code?: string | null } | null | undefined;

/** SQLSTATE de los `raise exception` propios (ver supabase/migrations). */
const CODIGOS_PROPIOS = new Set(["55000", "23514", "22023", "P0001", "P0002"]);

/** Patrones técnicos conocidos, en orden: el primero que case manda. */
const TECNICOS: Array<[RegExp, string]> = [
  [/invalid input syntax for type uuid/i, NO_ENCONTRADO],
  [/date\/time field value out of range|invalid input syntax for type (date|time|timestamp)/i, "Esa fecha no es válida."],
  [/duplicate key|unique constraint|23505/i, "Ya existe uno igual."],
  [/foreign key|23503/i, "Algo de lo que has elegido ya no existe. Recarga la página."],
  [/row-level security|permission denied|42501/i, "No tienes permiso para hacer eso. Vuelve a entrar."],
  [/violates not-null constraint|23502/i, "Falta algún dato. Revisa el formulario."],
  [/violates check constraint|23514/i, "Algún dato no es válido. Revísalo."],
  [/numeric field overflow|out of range for type|value too long/i, "Algún dato es demasiado grande."],
  [/could not find the function|schema cache|PGRST20/i, "Esto aún no está disponible: falta actualizar la base de datos."],
  [/JWT|refresh token|not authenticated/i, SESION_CADUCADA],
  [/fetch failed|network|ECONNRESET|ETIMEDOUT|timeout|canceling statement/i, "No se ha podido conectar. Inténtalo de nuevo."],
];

/** ¿Tiene pinta de mensaje técnico (inglés, identificadores internos)? */
function esTecnico(mensaje: string): boolean {
  return (
    /\b[a-z]+_[a-z0-9_]+\b/.test(mensaje) || // snake_case: tablas, restricciones, columnas
    /\b(violates|relation|constraint|column|syntax|invalid|duplicate|permission|function|schema|null value|operator|does not exist|failed|error)\b/i.test(
      mensaje,
    )
  );
}

/** ¿Lo ha escrito una función nuestra, en español, para la persona? */
function esMensajePropio(mensaje: string): boolean {
  return !esTecnico(mensaje) && /[áéíóúñ¿¡]|\b(el|la|los|las|de|del|un|una|ya|que|con|para|por|se|es)\b/i.test(mensaje);
}

/**
 * El mensaje en español de un error de la base. `propias` son las
 * traducciones específicas de la acción (restricción → mensaje), que mandan
 * sobre las genéricas.
 */
export function mensajeErrorDb(error: ErrorDb | string, propias: Array<[RegExp, string]> = []): string {
  const mensaje = (typeof error === "string" ? error : error?.message) ?? "";
  const codigo = typeof error === "string" ? "" : (error?.code ?? "");
  const texto = `${mensaje} ${codigo}`;

  // Los códigos con los que NUESTRAS funciones y disparadores lanzan mensajes
  // para la persona (p. ej. 55000 al borrar un gasto con reembolsos vivos, o
  // 23514 cuando un reembolso superaría el gasto): si el texto no tiene forma
  // técnica, pasa tal cual, antes de cualquier traducción que lo pisara.
  if (mensaje && CODIGOS_PROPIOS.has(codigo) && !esTecnico(mensaje)) return mensaje;
  for (const [patron, traduccion] of propias) if (patron.test(texto)) return traduccion;
  if (mensaje && esMensajePropio(mensaje)) return mensaje;
  for (const [patron, traduccion] of TECNICOS) if (patron.test(texto)) return traduccion;

  if (mensaje) console.error("error de la base sin traducir:", mensaje, codigo);
  return ERROR_GENERICO;
}
