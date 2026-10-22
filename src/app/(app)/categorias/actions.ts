"use server";

import { revalidatePath } from "next/cache";
import { NO_ENCONTRADO, conSesion, esId, filasTocadas, mensajeErrorDb } from "@/lib/acciones-servidor";
import { categoryEditSchema, categorySchema, firstIssue, type ActionResult } from "@/lib/schemas";

function fields(formData: FormData) {
  return {
    name: formData.get("name"),
    type: formData.get("type"),
    color: formData.get("color"),
    icon: formData.get("icon"),
  };
}

export async function createCategory(formData: FormData): Promise<ActionResult> {
  const parsed = categorySchema.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { error } = await sesion.supabase.from("category").insert({ ...parsed.data, user_id: sesion.userId });
  if (error) return { ok: false, error: friendly(error) };

  revalidatePath("/categorias");
  return { ok: true };
}

/**
 * El tipo no se puede cambiar: es inmutable una vez creada, y tanto el
 * privilegio de columna como un disparador lo impiden en la base de datos. Por
 * eso ni siquiera se envía.
 */
export async function updateCategory(id: string, formData: FormData): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const parsed = categoryEditSchema.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase.from("category").update(parsed.data).eq("id", id).select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidatePath("/categorias");
  revalidatePath("/movimientos");
  return { ok: true };
}

/**
 * Al borrar una categoría, sus movimientos NO se borran: la clave foránea los
 * deja sin categoría, que es exactamente el comportamiento deseado.
 */
export async function deleteCategory(id: string): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(await sesion.supabase.from("category").delete().eq("id", id).select("id"), friendly);
  if (fallo) return { ok: false, error: fallo };

  revalidatePath("/categorias");
  revalidatePath("/movimientos");
  return { ok: true };
}

function friendly(error: { message?: string; code?: string }): string {
  return mensajeErrorDb(error, [
    [/category_name_uq|duplicate key/i, "Ya tienes una categoría de ese tipo con ese nombre."],
    [/no se puede cambiar/i, "El tipo de una categoría no se puede cambiar una vez creada."],
  ]);
}
