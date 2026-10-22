"use server";

import { revalidatePath } from "next/cache";
import { NO_ENCONTRADO, conSesion, esId, filasTocadas, mensajeErrorDb } from "@/lib/acciones-servidor";
import { firstIssue, merchantRuleSchema, type ActionResult } from "@/lib/schemas";

export async function createRule(
  formData: FormData,
): Promise<ActionResult & { applied?: number }> {
  const parsed = merchantRuleSchema.safeParse({
    match_text: formData.get("match_text"),
    category_id: formData.get("category_id"),
    apply_retroactively: formData.get("apply_retroactively") === "on",
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;
  const { supabase } = sesion;

  // El tipo de la categoría se lee de la propia categoría: es lo que sostiene
  // la clave foránea compuesta, y nadie lo elige a mano.
  const { data: category } = await supabase
    .from("category")
    .select("type")
    .eq("id", parsed.data.category_id)
    .maybeSingle();

  if (!category) return { ok: false, error: "Esa categoría ya no existe." };
  if (category.type === "TRANSFER") {
    return { ok: false, error: "Una regla no puede apuntar a una categoría de traspaso." };
  }

  const { data: rule, error } = await supabase
    .from("merchant_rule")
    .insert({
      user_id: sesion.userId,
      match_text: parsed.data.match_text,
      category_id: parsed.data.category_id,
      category_type: category.type,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: friendly(error) };

  let applied = 0;
  if (parsed.data.apply_retroactively && rule) {
    const { data: count, error: errorAplicar } = await supabase.rpc("apply_merchant_rule", { p_rule_id: rule.id });
    if (errorAplicar) {
      revalidate();
      return { ok: false, error: "La regla se ha creado, pero no se ha podido aplicar a lo anterior. Inténtalo de nuevo." };
    }
    applied = count ?? 0;
  }

  revalidate();
  return { ok: true, applied };
}

export async function deleteRule(id: string): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase.from("merchant_rule").delete().eq("id", id).select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

/** Cuántos movimientos sin clasificar tocaría una regla, antes de crearla. */
export async function previewRule(matchText: string): Promise<{ occurrences: number; totalCents: number }> {
  const clean = typeof matchText === "string" ? matchText.trim() : "";
  if (clean.length < 2 || clean.length > 60) return { occurrences: 0, totalCents: 0 };

  const sesion = await conSesion();
  if (!sesion.ok) return { occurrences: 0, totalCents: 0 };

  const { data } = await sesion.supabase.rpc("preview_merchant_rule", { p_match_text: clean });
  const row = Array.isArray(data) ? data[0] : null;
  return { occurrences: row?.occurrences ?? 0, totalCents: row?.total_cents ?? 0 };
}

/** Aplica una regla ya existente a lo que siga sin clasificar. */
export async function applyRule(id: string): Promise<ActionResult & { applied?: number }> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { data, error } = await sesion.supabase.rpc("apply_merchant_rule", { p_rule_id: id });
  if (error) return { ok: false, error: friendly(error) };

  revalidate();
  return { ok: true, applied: data ?? 0 };
}

function revalidate() {
  revalidatePath("/reglas");
  revalidatePath("/movimientos");
  revalidatePath("/ajustes");
}

function friendly(error: { message?: string; code?: string }): string {
  return mensajeErrorDb(error, [
    [/rule_user_id_match_norm_key|duplicate key/i, "Ya tienes una regla con ese mismo texto."],
    [/rule_match_len/i, "El texto debe tener entre 2 y 60 caracteres."],
    [/rule_not_transfer/i, "Una regla no puede apuntar a una categoría de traspaso."],
  ]);
}
