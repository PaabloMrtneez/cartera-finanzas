"use server";

import { revalidatePath } from "next/cache";
import { NO_ENCONTRADO, conSesion, esId, filasTocadas, mensajeErrorDb } from "@/lib/acciones-servidor";
import { type AccountDeletePreview, parseAccountDeletePreview } from "@/lib/eliminar-cuenta";
import {
  accountDeleteSchema,
  accountSchema,
  cardEditSchema,
  cardSchema,
  firstIssue,
  type ActionResult,
} from "@/lib/schemas";
import type { Card } from "@/lib/supabase/database.types";

/**
 * Las escrituras pasan por aquí y no por el navegador, para que la validación
 * ocurra en el servidor. Aun así, la última palabra la tienen las políticas y
 * las restricciones de la base de datos.
 */

function parse(formData: FormData) {
  return accountSchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type"),
    initial_balance_cents: formData.get("initial_balance_cents"),
    color: formData.get("color"),
  });
}

export async function createAccount(formData: FormData): Promise<ActionResult> {
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { error } = await sesion.supabase.from("account").insert({ ...parsed.data, user_id: sesion.userId });
  if (error) return { ok: false, error: friendly(error) };

  revalidatePath("/cuentas");
  revalidatePath("/resumen");
  return { ok: true };
}

export async function updateAccount(id: string, formData: FormData): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase.from("account").update(parsed.data).eq("id", id).select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidatePath("/cuentas");
  revalidatePath("/resumen");
  return { ok: true };
}

/**
 * Archivar es lo recomendable: conserva la historia. La cuenta sigue contando
 * en el patrimonio, pero desaparece de los selectores del día a día. Para
 * quitarla de verdad está `deleteAccount`.
 */
export async function setAccountArchived(id: string, archived: boolean): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  // TypeScript no protege en tiempo de ejecución: «"false"» no es false (H-16).
  if (typeof archived !== "boolean") return { ok: false, error: "Petición no válida. Recarga la página." };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase
      .from("account")
      .update({ archived, archived_at: archived ? new Date().toISOString() : null })
      .eq("id", id)
      .select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidatePath("/cuentas");
  revalidatePath("/resumen");
  return { ok: true };
}

/**
 * Qué se borraría al eliminar la cuenta, para la confirmación. No borra nada.
 * El JSON de la base se valida antes de dárselo al cliente: si no tiene la
 * forma esperada, mejor un error que unos recuentos inventados.
 */
type PreviewResult = { ok: true; preview: AccountDeletePreview } | { ok: false; error: string };

export async function previewAccountDeletion(id: string): Promise<PreviewResult> {
  const parsed = accountDeleteSchema.shape.id.safeParse(id);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { data, error } = await sesion.supabase.rpc("account_delete_preview", { p_account_id: parsed.data });
  if (error) return { ok: false, error: friendlyDelete(error) };

  const preview = parseAccountDeletePreview(data);
  if (!preview) return { ok: false, error: "No se pudo calcular qué se borraría. Inténtalo de nuevo." };
  return { ok: true, preview };
}

/**
 * Elimina la cuenta con TODO lo suyo: movimientos (y los traspasos con otras
 * cuentas), tarjetas, posiciones y valoraciones, suscripciones, ingresos
 * recurrentes y metas. Lo hace `delete_account` en una sola transacción, y solo
 * si el nombre escrito coincide con el de la cuenta. No tiene vuelta atrás: la
 * interfaz recomienda archivar antes de llegar aquí.
 *
 * Se revalida todo lo que deriva de los movimientos: saldos, patrimonio,
 * gasto, metas, fijos (gastos e ingresos), inversiones y la cuenta del Atajo.
 */
const RUTAS_TRAS_BORRAR = [
  "/cuentas",
  "/resumen",
  "/movimientos",
  "/patrimonio",
  "/inversiones",
  "/metas",
  "/fijos",
  "/analisis",
  "/atajo",
  "/ajustes",
];

export async function deleteAccount(id: string, formData: FormData): Promise<ActionResult> {
  const parsed = accountDeleteSchema.safeParse({ id, confirm_name: formData.get("confirm_name") ?? "" });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { error } = await sesion.supabase.rpc("delete_account", {
    p_account_id: parsed.data.id,
    p_confirm_name: parsed.data.confirm_name,
  });
  if (error) return { ok: false, error: friendlyDelete(error) };

  for (const ruta of RUTAS_TRAS_BORRAR) revalidatePath(ruta);
  return { ok: true };
}

/**
 * Las tarjetas de una cuenta. Cada operación es independiente del «Guardar» de
 * la cuenta: una tarjeta necesita el `account_id` de una cuenta que ya existe
 * (la clave foránea lo exige), así que solo se crean, editan y borran sobre una
 * cuenta guardada. El `user_id` sale del usuario autenticado en el servidor, no
 * del cliente: la política `with check` de la tabla `card` lo exige.
 */
type CardResult = { ok: true; card: Card } | { ok: false; error: string };

export async function createCard(formData: FormData): Promise<CardResult> {
  const parsed = cardSchema.safeParse({
    account_id: formData.get("account_id"),
    last4: formData.get("last4") ?? "",
    type: formData.get("type"),
    nickname: formData.get("nickname") ?? "",
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { data, error } = await sesion.supabase
    .from("card")
    .insert({ ...parsed.data, user_id: sesion.userId })
    .select()
    .single();
  if (error) return { ok: false, error: friendlyCard(error) };

  revalidatePath("/cuentas");
  revalidatePath("/atajo");
  return { ok: true, card: data };
}

export async function updateCard(id: string, formData: FormData): Promise<CardResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const parsed = cardEditSchema.safeParse({
    last4: formData.get("last4") ?? "",
    type: formData.get("type"),
    nickname: formData.get("nickname") ?? "",
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { data, error } = await sesion.supabase
    .from("card")
    .update(parsed.data)
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) return { ok: false, error: friendlyCard(error) };
  if (!data) return { ok: false, error: NO_ENCONTRADO };

  revalidatePath("/cuentas");
  revalidatePath("/atajo");
  return { ok: true, card: data };
}

/** Una tarjeta es solo una etiqueta: se puede borrar sin más (la RLS lo permite). */
export async function deleteCard(id: string): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(await sesion.supabase.from("card").delete().eq("id", id).select("id"), friendlyCard);
  if (fallo) return { ok: false, error: fallo };

  revalidatePath("/cuentas");
  revalidatePath("/atajo");
  return { ok: true };
}

type ErrorDb = { message?: string; code?: string };

function friendly(error: ErrorDb): string {
  return mensajeErrorDb(error, [
    [/account_name_uq|duplicate key/i, "Ya tienes una cuenta con ese nombre."],
    // La cuenta-pasivo de un préstamo no cambia de tipo (lo fija la clave del préstamo).
    [
      /loan_liability_account_fk/i,
      "Es la cuenta de un préstamo: su tipo no se puede cambiar. Gestiónala desde Préstamos.",
    ],
  ]);
}

function friendlyDelete(error: ErrorDb): string {
  return mensajeErrorDb(error, [
    // Un préstamo apunta a esta cuenta (la de pago o su cuenta-pasivo): delete_account
    // no puede llevárselo por delante. Se elimina antes el préstamo.
    [/loan_payment_account_fk/i, "Desde esta cuenta se paga un préstamo: elimina antes el préstamo en Préstamos."],
    [/loan_liability_account_fk/i, "Es la cuenta de un préstamo: para quitarla, elimina el préstamo en Préstamos."],
    [/nombre no coincide/i, "El nombre no coincide con el de la cuenta."],
    [/no encontrada/i, "Esa cuenta ya no existe."],
    [/sin verificar/i, "Sesión sin verificar. Vuelve a entrar."],
    // PostgREST no encuentra la función: la migración aún no está en la base.
    [/could not find the function|schema cache/i, "Eliminar cuentas aún no está disponible: falta actualizar la base de datos."],
  ]);
}

function friendlyCard(error: ErrorDb): string {
  return mensajeErrorDb(error, [
    [/card_user_id_last4_key|duplicate key/i, "Ya tienes una tarjeta con esos 4 dígitos."],
    [/card_last4_fmt/i, "Los 4 dígitos de la tarjeta no son válidos."],
    [/card_nickname_len/i, "El alias admite entre 1 y 40 caracteres."],
  ]);
}
