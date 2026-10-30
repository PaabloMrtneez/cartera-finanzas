"use server";

import { revalidatePath } from "next/cache";
import { NO_ENCONTRADO, conSesion, esId, filasTocadas, mensajeErrorDb } from "@/lib/acciones-servidor";
import type { ActionResult } from "@/lib/schemas";

/**
 * Alta de un dispositivo de ingesta. El token en claro se devuelve UNA SOLA VEZ:
 * en la base de datos solo queda su hash. Si se pierde, hay que generar otro.
 * Un token recuperable es un token filtrable.
 */
export async function createIngestDevice(
  name: string,
): Promise<ActionResult & { token?: string }> {
  // Una server action se puede llamar con cualquier cosa (H-18): un número o
  // null no pueden reventar en `.trim()`.
  const clean = typeof name === "string" ? name.trim() : "";
  if (clean.length < 1 || clean.length > 40) {
    return { ok: false, error: "Ponle un nombre de entre 1 y 40 caracteres." };
  }

  const s = await conSesion();
  if (!s.ok) return s;
  const { data, error } = await s.supabase.rpc("create_ingest_device", { p_name: clean });

  if (error) return { ok: false, error: mensajeErrorDb(error) };

  const result = data as { token?: string } | null;
  revalidatePath("/ajustes");
  return { ok: true, token: result?.token };
}

/**
 * Cuenta a la que van los cargos del Atajo cuando la tarjeta no identifica
 * ninguna. Sin esto, un pago con una tarjeta que no esté dada de alta se
 * rechaza con «no_account_configured» y no habría forma de arreglarlo desde
 * la app.
 */
export async function setDefaultIngestAccount(accountId: string | null): Promise<ActionResult> {
  if (accountId !== null && !esId(accountId)) return { ok: false, error: "Elige una cuenta." };

  const s = await conSesion();
  if (!s.ok) return s;

  const fallo = filasTocadas(
    await s.supabase
      .from("profile")
      .update({ default_ingest_account_id: accountId })
      .eq("user_id", s.userId)
      .select("user_id"),
    (e) =>
      mensajeErrorDb(e, [[/foreign key|23503/i, "Esa cuenta ya no existe. Recarga la página."]]),
  );
  if (fallo) return { ok: false, error: fallo };

  revalidatePath("/ajustes");
  return { ok: true };
}

export async function revokeIngestDevice(id: string): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };

  const s = await conSesion();
  if (!s.ok) return s;

  const { error } = await s.supabase.rpc("revoke_ingest_device", { p_device_id: id });
  if (error) return { ok: false, error: mensajeErrorDb(error) };

  // La función no dice si ha encontrado el dispositivo (devuelve void): se
  // comprueba que existe, es tuyo (RLS) y ha quedado revocado.
  const { data: dispositivo, error: errorLectura } = await s.supabase
    .from("ingest_device")
    .select("revoked_at")
    .eq("id", id)
    .maybeSingle();
  if (errorLectura) return { ok: false, error: mensajeErrorDb(errorLectura) };
  if (!dispositivo?.revoked_at) return { ok: false, error: NO_ENCONTRADO };

  revalidatePath("/ajustes");
  return { ok: true };
}

/**
 * A qué cuenta van los cargos de una tarjeta de Cartera, por el nombre con el
 * que sale en sus avisos («Santander», «Revolut»). Guardar el mismo nombre otra
 * vez cambia su cuenta: el nombre se compara sin tildes ni mayúsculas.
 */
/** Lo mismo que private.nombre_normalizado: sin mayúsculas, tildes ni espacios de más. */
function nombreNormalizado(texto: string): string {
  const de = "áàäâéèëêíìïîóòöôúùüûñç";
  const a = "aaaaeeeeiiiioooouuuunc";
  return [...texto.toLowerCase()]
    .map((c) => (de.includes(c) ? a[de.indexOf(c)] : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export async function guardarTarjetaCartera(nombre: string, accountId: string): Promise<ActionResult> {
  const limpio = typeof nombre === "string" ? nombre.replace(/\s+/g, " ").trim() : "";
  if (limpio.length < 1 || limpio.length > 60) {
    return { ok: false, error: "Escribe el nombre de la tarjeta tal como sale en el aviso (hasta 60 caracteres)." };
  }
  if (!esId(accountId)) return { ok: false, error: "Elige una cuenta." };

  const s = await conSesion();
  if (!s.ok) return s;

  const traducir = (e: { message?: string; code?: string }) =>
    mensajeErrorDb(e, [[/foreign key|23503/i, "Esa cuenta ya no existe. Recarga la página."]]);

  // Primero se cambia la que ya hubiera con ese nombre; si no hay, se crea.
  // No con upsert: su UPDATE reescribiría user_id, que la app no puede tocar.
  const cambiada = await s.supabase
    .from("wallet_card")
    .update({ name: limpio, account_id: accountId })
    .eq("name_norm", nombreNormalizado(limpio))
    .select("id");
  if (cambiada.error) return { ok: false, error: traducir(cambiada.error) };
  if ((cambiada.data ?? []).length === 0) {
    const fallo = filasTocadas(
      await s.supabase.from("wallet_card").insert({ user_id: s.userId, name: limpio, account_id: accountId }).select("id"),
      traducir,
    );
    if (fallo) return { ok: false, error: fallo };
  }

  revalidatePath("/ajustes");
  return { ok: true };
}

export async function quitarTarjetaCartera(id: string): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };

  const s = await conSesion();
  if (!s.ok) return s;

  const fallo = filasTocadas(await s.supabase.from("wallet_card").delete().eq("id", id).select("id"), (e) =>
    mensajeErrorDb(e),
  );
  if (fallo) return { ok: false, error: fallo };

  revalidatePath("/ajustes");
  return { ok: true };
}
