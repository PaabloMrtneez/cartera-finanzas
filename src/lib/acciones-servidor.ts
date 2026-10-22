import { z } from "zod";
import { NO_ENCONTRADO, SESION_CADUCADA, mensajeErrorDb } from "./errores-db";
import { createClient } from "./supabase/server";

/**
 * Lo que comparten las server actions (H-16). Una server action es un endpoint
 * público: cualquiera con sesión la puede llamar con los argumentos que
 * quiera, y TypeScript no protege nada en tiempo de ejecución. Antes de tocar
 * la base, cada acción:
 *
 *   1. valida el id (un uuid: lo demás no llega a PostgREST);
 *   2. exige sesión (`getUser()`, que valida el token contra Supabase);
 *   3. y después de un UPDATE o un DELETE, mira cuántas filas ha tocado: la
 *      RLS filtra sin error las filas ajenas (o todas, con la sesión
 *      caducada), y sin esto la acción respondía «guardado» sin guardar nada.
 *
 * No es "use server" a propósito: son ayudantes, no endpoints.
 */

export { NO_ENCONTRADO, SESION_CADUCADA, mensajeErrorDb };

const uuid = z.uuid();

/** ¿Es un uuid? Un id que no lo es nunca llega a la base. */
export function esId(id: unknown): id is string {
  return uuid.safeParse(id).success;
}

type Cliente = Awaited<ReturnType<typeof createClient>>;

/**
 * El cliente de Supabase con la sesión comprobada, o el error que hay que
 * devolver. Uso: `const s = await conSesion(); if (!s.ok) return s;`
 */
export async function conSesion(): Promise<
  { ok: true; supabase: Cliente; userId: string } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: SESION_CADUCADA };
  return { ok: true, supabase, userId: user.id };
}

/**
 * El resultado de un UPDATE o DELETE con `.select("id")`: error traducido, o
 * «No se ha encontrado» si no ha tocado ninguna fila, o null si todo bien.
 */
export function filasTocadas(
  r: { data: unknown[] | null; error: { message?: string; code?: string } | null },
  traducir: (error: { message?: string; code?: string }) => string = (e) => mensajeErrorDb(e),
): string | null {
  if (r.error) return traducir(r.error);
  if (!r.data || r.data.length === 0) return NO_ENCONTRADO;
  return null;
}
