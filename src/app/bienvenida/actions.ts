"use server";

import { revalidatePath } from "next/cache";
import { CATEGORIAS_SUGERIDAS } from "@/lib/onboarding";
import { accountSchema, firstIssue, type ActionResult } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

/**
 * El primer arranque, en una sola escritura por paso.
 *
 * Se apoya en las mismas validaciones que el resto de la app: aquí no hay
 * ningún camino más corto ni más permisivo por ser el principio.
 */

export async function terminarArranque(
  formData: FormData,
  claves: string[],
): Promise<ActionResult> {
  const parsed = accountSchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type"),
    initial_balance_cents: formData.get("initial_balance_cents"),
    color: formData.get("color"),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  // La primera tarjeta es opcional. Ya no se guarda en `account.card_last4`: va a
  // la tabla `card`, que es de donde el Atajo enruta los pagos. Se valida aquí su
  // formato para no crear la cuenta si los dígitos están mal.
  const last4 = (formData.get("card_last4") ?? "").toString().replace(/\D/g, "");
  if (last4 !== "" && !/^\d{4}$/.test(last4)) {
    return { ok: false, error: "Escribe los 4 últimos dígitos de la tarjeta" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sesión caducada. Vuelve a entrar." };

  // Nadie debería poder rehacer el arranque teniendo ya datos: sería la vía
  // para duplicar categorías sin pasar por la pantalla que las controla.
  const { count } = await supabase
    .from("account")
    .select("*", { count: "exact", head: true });
  if ((count ?? 0) > 0) {
    return { ok: false, error: "Ya tienes cuentas creadas." };
  }

  const { data: account, error } = await supabase
    .from("account")
    .insert({ ...parsed.data, user_id: user.id })
    .select("id")
    .single();
  if (error || !account) {
    return {
      ok: false,
      error: /account_name_uq|account_name_unique|duplicate key/i.test(error?.message ?? "")
        ? "Ya tienes una cuenta con ese nombre."
        : "No se ha podido crear la cuenta.",
    };
  }

  // La cuenta ya existe: ahora sí se puede colgar su primera tarjeta (la clave
  // foránea exige un account_id real). Si falla, se entra igual y se añade luego
  // desde Cuentas; la cuenta, que es lo que de verdad hace falta, ya está.
  if (last4 !== "") {
    await supabase
      .from("card")
      .insert({ user_id: user.id, account_id: account.id, last4, type: "DEBITO" });
  }

  // Del navegador solo llegan claves. El nombre, el color y el tipo salen de la
  // lista del servidor, así que no hay nada que inyectar.
  const lista = Array.isArray(claves) ? claves : [];
  const elegidas = CATEGORIAS_SUGERIDAS.filter((c) => lista.includes(c.clave));
  if (elegidas.length > 0) {
    const { error: errorCategorias } = await supabase.from("category").insert(
      elegidas.map((c) => ({
        user_id: user.id,
        name: c.name,
        type: c.type,
        color: c.color,
        icon: c.icon,
      })),
    );
    // La cuenta ya está creada y es lo que de verdad hace falta: si fallan las
    // categorías, se entra igual y se crean luego desde su pantalla.
    if (errorCategorias) {
      revalidatePath("/", "layout");
      return { ok: true };
    }
  }

  revalidatePath("/", "layout");
  return { ok: true };
}
