"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  firstIssue,
  transactionSchema,
  type ActionResult,
  type TransactionInput,
} from "@/lib/schemas";
import { NO_ENCONTRADO, conSesion, esId, filasTocadas, mensajeErrorDb } from "@/lib/acciones-servidor";
import { PERIODICITIES, TRANSACTION_TYPES } from "@/lib/types";

function parse(formData: FormData) {
  const nullable = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" && value !== "" ? value : null;
  };

  return transactionSchema.safeParse({
    type: formData.get("type"),
    amount_cents: formData.get("amount"),
    description: formData.get("description") ?? "",
    occurred_on: formData.get("occurred_on"),
    occurred_time: formData.get("occurred_time") || "00:00",
    account_id: formData.get("account_id"),
    to_account_id: nullable("to_account_id"),
    category_id: nullable("category_id"),
    note: nullable("note"),
    reimburses_id: nullable("reimburses_id"),
    position_id: nullable("position_id"),
    // Solo llega si la posición elegida sigue un instrumento. Vacío: se estiman.
    position_units: nullable("position_units"),
  });
}

/**
 * `category_type` y `reimburses_target_type` son espejos que sostienen las
 * claves foráneas compuestas: no los elige la persona, se derivan. Sin ellos la
 * base de datos no podría garantizar que la categoría es del mismo tipo que el
 * movimiento, ni que un reembolso apunta siempre a un gasto.
 */
function mirrors(data: TransactionInput) {
  return {
    category_type: data.category_id ? data.type : null,
    reimburses_target_type: data.reimburses_id ? ("EXPENSE" as const) : null,
  };
}

export async function createTransaction(formData: FormData): Promise<ActionResult> {
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  // H-22: la clave de idempotencia que manda el formulario (un uuid por
  // formulario abierto, el mismo en los reintentos). Opcional: sin ella, como
  // antes; con algo que no es un uuid, se ignora en vez de rechazar el alta.
  const claveCruda = formData.get("client_id");
  const clientId = esId(claveCruda) ? claveCruda : null;

  const s = await conSesion();
  if (!s.ok) return s;

  const { error } = await s.supabase.from("transaction").insert({
    ...parsed.data,
    ...mirrors(parsed.data),
    user_id: s.userId,
    source: "MANUAL",
    status: "CONFIRMED",
    client_id: clientId,
  });

  // Un segundo envío del MISMO formulario (doble toque, respuesta perdida)
  // choca con `tx_client_id_uq`: el movimiento ya estaba guardado, así que
  // para quien pulsó es un éxito, no un error.
  if (error && clientId && esChoqueDeClave(error)) {
    revalidateAll();
    return { ok: true };
  }
  if (error) return { ok: false, error: friendly(error) };

  revalidateAll();
  return { ok: true };
}

/** ¿Es el choque del índice único de idempotencia del alta? */
function esChoqueDeClave(error: { message?: string; code?: string; details?: string }): boolean {
  return /tx_client_id_uq/i.test(`${error.message ?? ""} ${error.details ?? ""}`) ||
    (error.code === "23505" && /client_id/i.test(`${error.message ?? ""} ${error.details ?? ""}`));
}

/**
 * Un gasto que además se repite.
 *
 * Valida con el MISMO esquema que un gasto normal y luego añade la periodicidad:
 * así no hay una segunda puerta con reglas más flojas para el mismo movimiento.
 *
 * Las dos escrituras las hace una función de base en una sola transacción. Aquí
 * no se puede: si la aplicación insertara el gasto y luego la suscripción, un
 * fallo por el medio dejaría un gasto suelto y a alguien esperando un cargo el
 * mes que viene que nunca llegaría.
 */
export async function createExpenseWithSubscription(formData: FormData): Promise<ActionResult> {
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  if (parsed.data.type !== "EXPENSE") {
    return { ok: false, error: "Solo un gasto puede repetirse." };
  }

  const periodicidad = z.enum(PERIODICITIES).safeParse(formData.get("periodicity"));
  if (!periodicidad.success) return { ok: false, error: "Elige cada cuánto se repite." };

  const s = await conSesion();
  if (!s.ok) return s;
  const { error } = await s.supabase.rpc("create_expense_with_subscription", {
    p_amount_cents: parsed.data.amount_cents,
    p_description: parsed.data.description,
    p_occurred_on: parsed.data.occurred_on,
    p_occurred_time: parsed.data.occurred_time,
    p_account_id: parsed.data.account_id,
    p_category_id: parsed.data.category_id,
    p_periodicity: periodicidad.data,
    p_note: parsed.data.note,
  });

  if (error) {
    return {
      ok: false,
      error: error.message.includes("categoría de gasto")
        ? "Un gasto fijo solo puede colgar de una categoría de gasto."
        : friendly(error),
    };
  }

  revalidateAll();
  revalidatePath("/fijos");
  return { ok: true };
}

export async function updateTransaction(id: string, formData: FormData): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const s = await conSesion();
  if (!s.ok) return s;
  const { supabase } = s;

  const fallo = filasTocadas(
    await supabase
      .from("transaction")
      .update({ ...parsed.data, ...mirrors(parsed.data) })
      .eq("id", id)
      .select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  /*
    Clasificar es confirmar.

    Había dos caminos para poner categoría —el diálogo de clasificar y este
    formulario— y solo el primero cambiaba el estado. Editando un cargo del
    Atajo para darle categoría, se quedaba en PENDIENTE para siempre: seguía con
    su pastilla en la lista y contando en el aviso de la barra inferior, ya
    clasificado. Pendiente significa «llegó del Atajo y nadie lo ha mirado», y
    si le acabas de poner categoría, lo has mirado.

    El filtro por `status` es lo que lo hace seguro: solo asciende un PENDIENTE.
    Un movimiento descartado al que se le añade categoría sigue descartado, y
    quitarle la categoría a uno ya confirmado no lo devuelve a la bandeja.
  */
  if (parsed.data.category_id) {
    // El error ya no se ignora: el movimiento está guardado, pero si no se
    // ha podido confirmar hay que decirlo (seguiría en la bandeja).
    const { error: errorConfirmar } = await supabase
      .from("transaction")
      .update({ status: "CONFIRMED" })
      .eq("id", id)
      .eq("status", "PENDING");
    if (errorConfirmar) {
      revalidateAll();
      return { ok: false, error: "Se ha guardado, pero no se ha podido confirmar. Inténtalo de nuevo." };
    }
  }

  revalidateAll();
  return { ok: true };
}

export async function deleteTransaction(id: string): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const s = await conSesion();
  if (!s.ok) return s;

  const fallo = filasTocadas(await s.supabase.from("transaction").delete().eq("id", id).select("id"), friendly);
  if (fallo) return { ok: false, error: fallo };

  revalidateAll();
  return { ok: true };
}

/** Confirma un cargo que llegó del Atajo y quedó pendiente de clasificar. */
export async function confirmTransaction(
  id: string,
  categoryId: string | null,
  categoryType: "EXPENSE" | "INCOME" | "TRANSFER" | null,
): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  if (categoryId !== null && !esId(categoryId)) return { ok: false, error: "Elige una categoría." };
  if (categoryType !== null && !(TRANSACTION_TYPES as readonly string[]).includes(categoryType)) {
    return { ok: false, error: "Elige una categoría." };
  }
  // El espejo `category_type` va con la categoría: los dos o ninguno.
  if ((categoryId === null) !== (categoryType === null)) return { ok: false, error: "Elige una categoría." };

  const s = await conSesion();
  if (!s.ok) return s;

  const fallo = filasTocadas(
    await s.supabase
      .from("transaction")
      .update({ status: "CONFIRMED", category_id: categoryId, category_type: categoryType })
      .eq("id", id)
      .select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidateAll();
  return { ok: true };
}

function revalidateAll() {
  revalidatePath("/movimientos");
  revalidatePath("/resumen");
  revalidatePath("/cuentas");
}

/** Las restricciones de `transaction`, en español; lo demás, la red común (H-01). */
function friendly(error: { message?: string; code?: string } | string): string {
  return mensajeErrorDb(error, [
    [/tx_to_account_only_transfer/i, "Un traspaso necesita una cuenta de destino distinta del origen."],
    [/tx_reimburses_only_income/i, "Solo un ingreso puede reembolsar un gasto."],
    // El CHECK pone suelo Y techo (H-13): no se explica solo como «mayor que cero».
    [/tx_amount_positive/i, "El importe tiene que ser mayor que cero y de 1.000 millones de euros como mucho."],
    [/23503|foreign key/i, "La cuenta o la categoría elegidas ya no existen. Recarga la página."],
    [/tx_date_sane/i, "Esa fecha está fuera de lo razonable."],
  ]);
}
