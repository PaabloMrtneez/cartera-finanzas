"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { NO_ENCONTRADO, conSesion, esId, filasTocadas, mensajeErrorDb } from "@/lib/acciones-servidor";
import { MENSAJE_TOPE_IMPORTE as TOPE, firstIssue, positiveAmountCents, type ActionResult } from "@/lib/schemas";

const schema = z.object({
  category_id: z.uuid("Elige una categoría"),
  monthly_cap_cents: positiveAmountCents,
  warn_at_80: z.boolean(),
  discount_reimbursements: z.boolean(),
  rollover_unspent: z.boolean(),
});

function parse(formData: FormData) {
  return schema.safeParse({
    category_id: formData.get("category_id"),
    monthly_cap_cents: formData.get("cap"),
    warn_at_80: formData.get("warn_at_80") === "on",
    discount_reimbursements: formData.get("discount_reimbursements") === "on",
    rollover_unspent: formData.get("rollover_unspent") === "on",
  });
}

export async function createBudget(formData: FormData): Promise<ActionResult> {
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;
  const { supabase, userId } = sesion;

  // Un límite solo tiene sentido sobre gasto: un ingreso o un traspaso no
  // consumen tope. La base de datos lo impone; aquí se avisa mejor.
  const { data: categoria } = await supabase
    .from("category")
    .select("type")
    .eq("id", parsed.data.category_id)
    .maybeSingle();

  if (!categoria) return { ok: false, error: "Esa categoría ya no existe." };
  if (categoria.type !== "EXPENSE") {
    return { ok: false, error: "Solo se puede poner límite a una categoría de gasto." };
  }

  const { error } = await supabase
    .from("budget")
    .insert({ ...parsed.data, category_type: "EXPENSE", user_id: userId });

  if (error) return { ok: false, error: friendly(error) };

  revalidate();
  return { ok: true };
}

export async function updateBudget(id: string, formData: FormData): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  // La categoría de un límite no se cambia: si quieres otra, quitas este y pones
  // uno nuevo. Cambiarla convertiría el histórico de consumo en una mentira.
  const fallo = filasTocadas(
    await sesion.supabase
      .from("budget")
      .update({
        monthly_cap_cents: parsed.data.monthly_cap_cents,
        warn_at_80: parsed.data.warn_at_80,
        discount_reimbursements: parsed.data.discount_reimbursements,
        rollover_unspent: parsed.data.rollover_unspent,
      })
      .eq("id", id)
      .select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

export async function deleteBudget(id: string): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(await sesion.supabase.from("budget").delete().eq("id", id).select("id"), friendly);
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

function revalidate() {
  revalidatePath("/analisis");
  revalidatePath("/resumen");
}

function friendly(error: { message?: string; code?: string }): string {
  return mensajeErrorDb(error, [
    [/budget_user_id_category_id_key|duplicate key/i, "Ya tienes un límite para esa categoría."],
    [/budget_cap_positive/i, "El tope tiene que ser mayor que cero."],
    [/budget_cap_max/i, TOPE],
    [/budget_only_expense/i, "Solo se puede poner límite a una categoría de gasto."],
  ]);
}
