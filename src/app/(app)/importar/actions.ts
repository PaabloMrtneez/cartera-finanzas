"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { conSesion } from "@/lib/acciones-servidor";
import { leerFilas, prepararTabla, type Emparejado, type FilaLeida } from "@/lib/csv";
import { contarDuplicadas, type Existente } from "@/lib/importar-duplicados";
import { firstIssue } from "@/lib/schemas";

/**
 * Previsualizar e importar un extracto.
 *
 * Las dos acciones reciben lo MISMO —el texto del fichero y el emparejamiento
 * de columnas— y lo vuelven a analizar aquí. No se aceptan las filas ya
 * interpretadas por el navegador: si el navegador mandara las filas, lo que se
 * previsualiza y lo que se importa podrían no ser lo mismo, y el número que
 * alguien ve antes de pulsar dejaría de significar nada.
 */

/**
 * El tope del texto, en caracteres. Va de la mano de
 * `serverActions.bodySizeLimit` (4 MB en next.config.ts): 2 millones de
 * caracteres, aun con acentos y el escapado del JSON, caben de sobra. Antes
 * el límite de las acciones era 1 MB y un fichero de 1,5 MB, aceptado por la
 * pantalla, fallaba con un error genérico de Next (M-12).
 */
const MAX_TEXTO = 2_000_000;
const MAX_FILAS = 20_000;

const peticionSchema = z.object({
  account_id: z.uuid("Elige una cuenta"),
  texto: z
    .string({ error: "No se ha podido leer el fichero" })
    .min(1, "El fichero está vacío")
    .max(MAX_TEXTO, "El fichero es demasiado grande (más de 2 MB): pártelo por meses"),
  separador: z.string().min(1).max(1),
  columnas: z.object({
    fecha: z.number().int().min(0),
    concepto: z.number().int().min(0),
    importe: z.number().int().min(0),
  }),
  conCabecera: z.boolean(),
  todoGasto: z.boolean(),
  saltarDuplicados: z.boolean(),
});

export type Peticion = z.infer<typeof peticionSchema>;

export type Resumen = {
  insertadas: number;
  duplicadas: number;
  clasificadas: number;
  sinClasificar: number;
  descartadas: { linea: number; motivo: string; texto: string }[];
  ambiguedadDeFecha: boolean;
};

export type ResultadoImport = { ok: true; resumen: Resumen } | { ok: false; error: string };

type Cliente = Extract<Awaited<ReturnType<typeof conSesion>>, { ok: true }>["supabase"];

/**
 * Los movimientos que ya hay en la cuenta entre dos fechas, para contar los
 * duplicados. Por páginas: PostgREST devuelve como mucho 1000 filas por
 * consulta, y un extracto de un año puede chocar con más.
 */
async function existentes(
  supabase: Cliente,
  accountId: string,
  desde: string,
  hasta: string,
): Promise<Existente[] | null> {
  const PAGINA = 1000;
  const todas: Existente[] = [];
  for (let inicio = 0; ; inicio += PAGINA) {
    const { data, error } = await supabase
      .from("transaction")
      .select("occurred_on, description, amount_cents, type")
      .eq("account_id", accountId)
      .gte("occurred_on", desde)
      .lte("occurred_on", hasta)
      .neq("status", "DISCARDED")
      .order("id")
      .range(inicio, inicio + PAGINA - 1);
    if (error) return null;
    todas.push(...(data ?? []));
    if (!data || data.length < PAGINA) return todas;
  }
}

async function ejecutar(entrada: unknown, enSeco: boolean): Promise<ResultadoImport> {
  const parsed = peticionSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const { account_id, texto, separador, columnas, conCabecera, todoGasto, saltarDuplicados } =
    parsed.data;

  // El mismo recorte de preámbulo que hizo la pantalla: si aquí se recortara
  // distinto, los índices de columna que eligió la persona señalarían otra cosa.
  const { filas } = prepararTabla(texto, separador);
  if (filas.length === 0) return { ok: false, error: "No se ha encontrado ninguna fila." };
  if (filas.length > MAX_FILAS) {
    return { ok: false, error: `Son ${filas.length} filas. Importa como máximo ${MAX_FILAS}.` };
  }

  const lectura = leerFilas(filas, columnas as Emparejado, { conCabecera, todoGasto });
  if (lectura.filas.length === 0) {
    return {
      ok: false,
      error:
        lectura.descartadas.length > 0
          ? `Ninguna fila es un movimiento. La primera falla por: ${lectura.descartadas[0].motivo.toLowerCase()}.`
          : "No hay ninguna fila que importar.",
    };
  }

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;
  const { supabase } = sesion;

  /*
    H-10: los duplicados se cuentan aquí, como MULTICONJUNTO. Dos billetes de
    autobús de 1,50 € el mismo día son dos gastos: una fila repetida dentro
    del fichero ya no se descarta por estarlo. Solo es duplicada si la base ya
    tiene esa misma fila (fecha, concepto, importe y tipo), y tantas veces como
    la tenga: si hay un «BUS 1,50» y el extracto trae dos, entra uno.
    A la base se le manda solo lo que hay que meter, con `p_skip_duplicates`
    apagado, para que no vuelva a descartar las repetidas del fichero.
  */
  let aEnviar: FilaLeida[] = lectura.filas;
  let duplicadas = 0;
  if (saltarDuplicados) {
    const fechas = lectura.filas.map((f) => f.occurred_on).sort();
    const yaEstan = await existentes(supabase, account_id, fechas[0], fechas[fechas.length - 1]);
    if (!yaEstan) return { ok: false, error: "No se ha podido comprobar qué movimientos ya tenías. Inténtalo de nuevo." };
    const reparto = contarDuplicadas(lectura.filas, yaEstan);
    aEnviar = reparto.nuevas;
    duplicadas = reparto.duplicadas;
  }

  let fila: { insertadas: number; clasificadas: number; sin_clasificar: number } | undefined = {
    insertadas: 0,
    clasificadas: 0,
    sin_clasificar: 0,
  };
  if (aEnviar.length > 0) {
    const { data, error } = await supabase.rpc("import_transactions", {
      p_account_id: account_id,
      p_rows: aEnviar.map((f) => ({
        occurred_on: f.occurred_on,
        description: f.description,
        amount_cents: f.amount_cents,
      })),
      p_skip_duplicates: false,
      p_dry_run: enSeco,
    });

    if (error) {
      return {
        ok: false,
        error: error.message.includes("no existe")
          ? "Esa cuenta no existe o está archivada."
          : "No se ha podido importar. Revisa el emparejamiento de columnas.",
      };
    }
    fila = Array.isArray(data) ? data[0] : data;
  }

  if (!enSeco) {
    revalidatePath("/movimientos");
    revalidatePath("/resumen");
    revalidatePath("/cuentas");
    revalidatePath("/analisis");
  }

  return {
    ok: true,
    resumen: {
      insertadas: fila?.insertadas ?? 0,
      duplicadas,
      clasificadas: fila?.clasificadas ?? 0,
      sinClasificar: fila?.sin_clasificar ?? 0,
      descartadas: lectura.descartadas.slice(0, 20),
      ambiguedadDeFecha: lectura.ambiguedadDeFecha,
    },
  };
}

export async function previsualizarImport(entrada: unknown): Promise<ResultadoImport> {
  return ejecutar(entrada, true);
}

export async function confirmarImport(entrada: unknown): Promise<ResultadoImport> {
  return ejecutar(entrada, false);
}
