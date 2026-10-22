"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { NO_ENCONTRADO, conSesion, esId, filasTocadas, mensajeErrorDb } from "@/lib/acciones-servidor";
import { MENSAJE_TOPE_IMPORTE as TOPE, firstIssue, isoDate, positiveAmountCents, type ActionResult } from "@/lib/schemas";
import { PERIODICITIES } from "@/lib/types";

const schema = z.object({
  description: z.string().trim().min(1, "Ponle un nombre").max(60, "Máximo 60 caracteres"),
  amount_cents: positiveAmountCents,
  periodicity: z.enum(PERIODICITIES, { error: "Elige cada cuánto se repite" }),
  next_charge_date: isoDate,
  started_at: isoDate,
  account_id: z.uuid("Elige una cuenta"),
  category_id: z.uuid("Elige una categoría").nullable(),
  active: z.boolean(),
});

function parse(formData: FormData) {
  const categoria = formData.get("category_id");
  return schema.safeParse({
    description: formData.get("description"),
    amount_cents: formData.get("amount"),
    periodicity: formData.get("periodicity"),
    next_charge_date: formData.get("next_charge_date"),
    started_at: formData.get("started_at"),
    account_id: formData.get("account_id"),
    category_id: typeof categoria === "string" && categoria !== "" ? categoria : null,
    active: formData.get("active") === "on",
  });
}

export async function createSubscription(formData: FormData): Promise<ActionResult> {
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { error } = await sesion.supabase.from("subscription").insert({
    ...parsed.data,
    // El espejo del tipo sostiene la clave foránea compuesta; un gasto fijo
    // siempre genera gasto, así que solo admite categorías de gasto.
    category_type: parsed.data.category_id ? "EXPENSE" : null,
    user_id: sesion.userId,
  });

  if (error) return { ok: false, error: friendly(error) };

  revalidate();
  return { ok: true };
}

export async function updateSubscription(id: string, formData: FormData): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase
      .from("subscription")
      .update({
        ...parsed.data,
        category_type: parsed.data.category_id ? "EXPENSE" : null,
      })
      .eq("id", id)
      .select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

/** Pausar en vez de borrar: en pausa deja de generar y sale del compromiso. */
export async function setSubscriptionActive(id: string, active: boolean): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  if (typeof active !== "boolean") return { ok: false, error: "Petición no válida. Recarga la página." };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase.from("subscription").update({ active }).eq("id", id).select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

export async function deleteSubscription(id: string): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase.from("subscription").delete().eq("id", id).select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

/**
 * Crea los movimientos de las suscripciones cuya fecha ya ha pasado. Es
 * idempotente: el índice único por suscripción y fecha impide duplicar aunque se
 * pulse dos veces.
 */
export async function generateCharges(): Promise<ActionResult & { created?: number }> {
  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { data, error } = await sesion.supabase.rpc("generate_subscription_charges");
  if (error) return { ok: false, error: friendly(error) };

  revalidate();
  revalidatePath("/movimientos");
  revalidatePath("/resumen");
  return { ok: true, created: data ?? 0 };
}

function revalidate() {
  revalidatePath("/fijos");
  revalidatePath("/ajustes");
}

function friendly(error: { message?: string; code?: string }): string {
  return mensajeErrorDb(error, [
    [/sub_next_after_start/i, "El próximo cargo no puede ser anterior a la fecha de alta."],
    [/sub_amount_positive/i, "El importe tiene que ser mayor que cero."],
    [/sub_amount_max/i, TOPE],
    [/sub_category_is_expense/i, "Un gasto fijo solo admite categorías de gasto."],
    [/23503|foreign key/i, "La cuenta o la categoría ya no existen. Recarga la página."],
  ]);
}
