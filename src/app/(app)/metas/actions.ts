"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { NO_ENCONTRADO, conSesion, esId, filasTocadas, mensajeErrorDb } from "@/lib/acciones-servidor";
import { MENSAJE_TOPE_IMPORTE as TOPE, firstIssue, isoDate, positiveAmountCents, type ActionResult } from "@/lib/schemas";

const schema = z.object({
  name: z.string().trim().min(1, "Ponle un nombre").max(60, "Máximo 60 caracteres"),
  target_cents: positiveAmountCents,
  account_id: z.uuid("Elige una cuenta"),
  deadline: isoDate.nullable(),
});

function parse(formData: FormData) {
  const deadline = formData.get("deadline");
  return schema.safeParse({
    name: formData.get("name"),
    target_cents: formData.get("target"),
    account_id: formData.get("account_id"),
    deadline: typeof deadline === "string" && deadline !== "" ? deadline : null,
  });
}

export async function createGoal(formData: FormData): Promise<ActionResult> {
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { error } = await sesion.supabase.from("savings_goal").insert({
    ...parsed.data,
    user_id: sesion.userId,
  });
  if (error) return { ok: false, error: friendly(error) };

  revalidate();
  return { ok: true };
}

export async function updateGoal(id: string, formData: FormData): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase.from("savings_goal").update(parsed.data).eq("id", id).select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

export async function deleteGoal(id: string): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase.from("savings_goal").delete().eq("id", id).select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

function revalidate() {
  revalidatePath("/metas");
}

function friendly(error: { message?: string; code?: string }): string {
  return mensajeErrorDb(error, [
    // El unique (user_id, account_id): una meta por cuenta.
    [/savings_goal_user_id_account_id/i, "Ya tienes una meta en esa cuenta. Edítala, o elige otra cuenta."],
    [/goal_target_positive/i, "El objetivo tiene que ser mayor que cero."],
    [/goal_target_max/i, TOPE],
    [/goal_name_len/i, "Ponle un nombre a la meta."],
    [/23503|foreign key/i, "La cuenta ya no existe. Recarga la página."],
  ]);
}
