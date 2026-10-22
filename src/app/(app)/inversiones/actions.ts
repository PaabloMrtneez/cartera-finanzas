"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { NO_ENCONTRADO, conSesion, esId, filasTocadas, mensajeErrorDb } from "@/lib/acciones-servidor";
import { shortDate } from "@/lib/dates";
import { type PositionDeletePreview, parsePositionDeletePreview } from "@/lib/eliminar-fondo";
import { formatCents } from "@/lib/money";
import { IMPORTE_MAXIMO_CENTS, MENSAJE_TOPE_IMPORTE as TOPE, amountCents, firstIssue, isoDate, positionDeleteSchema, type ActionResult } from "@/lib/schemas";
import type { createClient } from "@/lib/supabase/server";
import {
  applyPercent,
  baseDeValoracion,
  parsePercent,
  type Porcentaje,
} from "@/lib/valoracion";

const posicionSchema = z.object({
  name: z.string().trim().min(1, "Ponle un nombre").max(60, "Máximo 60 caracteres"),
  account_id: z.uuid("Elige una cuenta de inversión"),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Color no válido"),
  since: isoDate,
});

export async function createPosition(formData: FormData): Promise<ActionResult> {
  const parsed = posicionSchema.safeParse({
    name: formData.get("name"),
    account_id: formData.get("account_id"),
    color: formData.get("color"),
    since: formData.get("since"),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { error } = await sesion.supabase
    .from("investment_position")
    .insert({ ...parsed.data, user_id: sesion.userId });

  if (error) return { ok: false, error: friendly(error) };

  revalidate();
  return { ok: true };
}

export async function updatePosition(id: string, formData: FormData): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  const parsed = posicionSchema.safeParse({
    name: formData.get("name"),
    account_id: formData.get("account_id"),
    color: formData.get("color"),
    since: formData.get("since"),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase
      .from("investment_position")
      .update({ name: parsed.data.name, color: parsed.data.color })
      .eq("id", id)
      .select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

/**
 * Archivar es lo recomendable: conserva la historia y el patrimonio de meses
 * pasados sigue cuadrando. Para quitar un fondo de verdad está `deletePosition`.
 */
export async function archivePosition(id: string, archived: boolean): Promise<ActionResult> {
  if (!esId(id)) return { ok: false, error: NO_ENCONTRADO };
  if (typeof archived !== "boolean") return { ok: false, error: "Petición no válida. Recarga la página." };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const fallo = filasTocadas(
    await sesion.supabase.from("investment_position").update({ archived }).eq("id", id).select("id"),
    friendly,
  );
  if (fallo) return { ok: false, error: fallo };

  revalidate();
  return { ok: true };
}

/**
 * Qué se borraría al eliminar el fondo, para la confirmación. No borra nada.
 * El JSON de la base se valida antes de dárselo al cliente: si no tiene la
 * forma esperada, mejor un error que unas cifras inventadas.
 */
type PreviewFondoResult = { ok: true; preview: PositionDeletePreview } | { ok: false; error: string };

export async function previewPositionDeletion(id: string): Promise<PreviewFondoResult> {
  const parsed = positionDeleteSchema.shape.id.safeParse(id);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { data, error } = await sesion.supabase.rpc("position_delete_preview", { p_position_id: parsed.data });
  if (error) return { ok: false, error: friendlyDelete(error) };

  const preview = parsePositionDeletePreview(data);
  if (!preview) return { ok: false, error: "No se pudo calcular qué se borraría. Inténtalo de nuevo." };
  return { ok: true, preview };
}

/**
 * Elimina el fondo con su historia: valoraciones, libro de participaciones y
 * los traspasos que le aportaron dinero (el dinero vuelve a contar en las
 * cuentas de las que salió). Lo hace `delete_position` en una sola
 * transacción, y solo si el nombre escrito coincide. No tiene vuelta atrás: la
 * interfaz recomienda archivar antes de llegar aquí.
 *
 * Se revalida todo lo que deriva de los movimientos y de las posiciones.
 */
const RUTAS_TRAS_BORRAR = [
  "/inversiones",
  "/patrimonio",
  "/resumen",
  "/cuentas",
  "/movimientos",
  "/metas",
  "/analisis",
];

export async function deletePosition(id: string, formData: FormData): Promise<ActionResult> {
  const parsed = positionDeleteSchema.safeParse({ id, confirm_name: formData.get("confirm_name") ?? "" });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;

  const { error } = await sesion.supabase.rpc("delete_position", {
    p_position_id: parsed.data.id,
    p_confirm_name: parsed.data.confirm_name,
  });
  if (error) return { ok: false, error: friendlyDelete(error) };

  for (const ruta of RUTAS_TRAS_BORRAR) revalidatePath(ruta);
  return { ok: true };
}

const valoracionSchema = z.discriminatedUnion("modo", [
  z.object({
    modo: z.literal("valor"),
    position_id: z.uuid("Posición no válida"),
    date: isoDate,
    value_cents: amountCents.refine((c) => c >= 0, "El valor no puede ser negativo"),
  }),
  z.object({
    modo: z.literal("porcentaje"),
    position_id: z.uuid("Posición no válida"),
    date: isoDate,
    // El porcentaje viaja como TEXTO, tal cual lo escribió la persona, y se
    // convierte aquí a una fracción exacta (ver lib/valoracion.ts).
    pct: z.string().transform((texto, ctx) => {
      const p = parsePercent(texto);
      if (p === null) {
        ctx.addIssue({ code: "custom", message: "Escribe un porcentaje válido, por ejemplo 5,2" });
        return z.NEVER;
      }
      return p;
    }),
    // La base que enseñó la vista previa, para comprobar que se guarda lo
    // mismo que se vio. No se usa para calcular: la base se calcula aquí.
    // Solo dígitos: nada de «1e5» (H-25).
    base_cents: z
      .string()
      .regex(/^\d{1,15}$/, "Vuelve a abrir la valoración")
      .transform(Number),
  }),
]);

/**
 * Registra el valor de una posición en una fecha.
 *
 * Solo se guarda el valor en céntimos. El porcentaje SIEMPRE se deriva de las
 * valoraciones, nunca al revés: si se guardara el porcentaje, dos fuentes
 * distintas podrían contradecirse.
 *
 * Se puede mandar el valor (modo «valor») o el porcentaje que ha variado (modo
 * «porcentaje»). En el segundo, el valor lo calcula el SERVIDOR, en enteros,
 * sobre una base que también calcula él (`baseDeValoracion`: la valoración del
 * cierre anterior más lo aportado desde entonces, al coste). El cliente solo
 * enseña una vista previa con las mismas funciones puras.
 */
export async function saveValuation(formData: FormData): Promise<ActionResult> {
  const parsed = valoracionSchema.safeParse({
    modo: formData.get("modo") ?? "valor",
    position_id: formData.get("position_id"),
    date: formData.get("date"),
    value_cents: formData.get("value") ?? undefined,
    pct: formData.get("pct") ?? undefined,
    base_cents: formData.get("base_cents") ?? undefined,
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const datos = parsed.data;

  const sesion = await conSesion();
  if (!sesion.ok) return sesion;
  const { supabase, userId } = sesion;

  let valueCents: number;
  if (datos.modo === "valor") {
    valueCents = datos.value_cents;
  } else {
    const calculo = await valorPorPorcentaje(supabase, datos);
    if (!calculo.ok) return calculo;
    valueCents = calculo.valueCents;
  }

  // Una valoración por posición y mes. Si ya hay una de ese mes, se reemplaza:
  // corregir una cifra mal metida tiene que ser fácil.
  const mes = `${datos.date.slice(0, 7)}-01`;
  const reemplazar = async () => {
    const { data: existente, error: errorLectura } = await supabase
      .from("valuation")
      .select("id")
      .eq("position_id", datos.position_id)
      .eq("period_month", mes)
      .maybeSingle();
    if (errorLectura) return { error: errorLectura, hay: false };
    if (!existente) return { error: null, hay: false };
    const { error } = await supabase
      .from("valuation")
      .update({ date: datos.date, value_cents: valueCents })
      .eq("id", existente.id);
    return { error, hay: true };
  };

  const primero = await reemplazar();
  let { error } = primero;
  if (!error && !primero.hay) {
    ({ error } = await supabase.from("valuation").insert({
      position_id: datos.position_id,
      date: datos.date,
      value_cents: valueCents,
      user_id: userId,
    }));
    // H-26: dos guardados a la vez. El otro ha metido la del mes entre la
    // lectura y este insert: se reemplaza esa, en vez de enseñar el choque.
    if (error && /valuation_one_per_month|duplicate key|23505/i.test(`${error.message} ${error.code ?? ""}`)) {
      ({ error } = await reemplazar());
    }
  }

  if (error) return { ok: false, error: friendly(error) };

  revalidate();
  return { ok: true };
}

/**
 * El valor que resulta de aplicar el porcentaje, calculado en el servidor.
 *
 * Lee la valoración del cierre anterior (la última de un mes ANTERIOR al de la
 * fecha: la de ese mismo mes es la que se va a sustituir) y lo aportado desde
 * ella hasta la fecha, con el mismo filtro que v_position_contributions y
 * v_position_value (traspasos a la posición que no estén descartados).
 */
async function valorPorPorcentaje(
  supabase: Awaited<ReturnType<typeof createClient>>,
  datos: { position_id: string; date: string; pct: Porcentaje; base_cents: number },
): Promise<{ ok: true; valueCents: number } | { ok: false; error: string }> {
  const { data: previas, error: e1 } = await supabase
    .from("valuation")
    .select("date, value_cents")
    .eq("position_id", datos.position_id)
    .lt("date", `${datos.date.slice(0, 7)}-01`)
    .order("date", { ascending: false })
    .limit(1);
  if (e1) return { ok: false, error: mensajeErrorDb(e1) };

  const previa = previas?.[0];
  const { data: aportes, error: e2 } = previa
    ? await supabase
        .from("transaction")
        .select("occurred_on, amount_cents")
        .eq("position_id", datos.position_id)
        .eq("type", "TRANSFER")
        .neq("status", "DISCARDED")
        .gt("occurred_on", previa.date)
        .lte("occurred_on", datos.date)
    : { data: [], error: null };
  if (e2) return { ok: false, error: mensajeErrorDb(e2) };

  const base = baseDeValoracion(datos.date, previas ?? [], aportes ?? []);
  if (base === null) {
    return {
      ok: false,
      error: "Sin una valoración de un mes anterior no se puede usar el porcentaje. Mete el valor.",
    };
  }

  // La vista previa se calculó con los datos de cuando se abrió la página y
  // para el día de hoy. Si con la fecha elegida (o porque entretanto se ha
  // apuntado una aportación) la base es otra, NO se guarda una cifra distinta
  // de la que se vio: se avisa.
  if (base.base !== datos.base_cents) {
    return {
      ok: false,
      error: `Con esa fecha el porcentaje se aplica sobre ${formatCents(base.base)} (valoración del ${shortDate(base.fechaPrevia)} más lo aportado hasta ese día), no sobre ${formatCents(datos.base_cents)}. Revisa la fecha o mete el valor.`,
    };
  }

  const valueCents = applyPercent(base.base, datos.pct);
  if (valueCents === null) {
    return { ok: false, error: "Con ese porcentaje el valor saldría negativo." };
  }
  // El valor calculado tiene el mismo tope que el escrito (valuation_value_max).
  if (valueCents > IMPORTE_MAXIMO_CENTS) return { ok: false, error: `${TOPE}.` };
  return { ok: true, valueCents };
}

function revalidate() {
  revalidatePath("/inversiones");
  revalidatePath("/patrimonio");
  revalidatePath("/cuentas");
}

type ErrorDb = { message?: string; code?: string };

function friendlyDelete(error: ErrorDb): string {
  return mensajeErrorDb(error, [
    [/nombre no coincide/i, "El nombre no coincide con el del fondo."],
    [/no encontrada/i, "Ese fondo ya no existe."],
    [/sin verificar/i, "Sesión sin verificar. Vuelve a entrar."],
    // PostgREST no encuentra la función: la migración aún no está en la base.
    [/could not find the function|schema cache/i, "Eliminar fondos aún no está disponible: falta actualizar la base de datos."],
  ]);
}

function friendly(error: ErrorDb): string {
  return mensajeErrorDb(error, [
    [/position_name_uq/i, "Ya tienes una posición con ese nombre."],
    [/position_account_is_investment|position_is_invest/i, "Una posición solo puede colgar de una cuenta de tipo Inversión."],
    [/valuation_one_per_month/i, "Ya hay una valoración de ese mes para esta posición."],
    [/valuation_not_future/i, "No se puede valorar una fecha futura."],
    [/valuation_value_max/i, TOPE],
    [/duplicate key/i, "Ya tienes una posición con ese nombre."],
    [/23503|foreign key/i, "Esa cuenta ya no existe. Recarga la página."],
  ]);
}
