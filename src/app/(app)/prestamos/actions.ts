"use server";

import { revalidatePath } from "next/cache";
import {
  CuadroInvalido,
  type CuotaDelCuadro,
  type LoanDeletePreview,
  arranqueYaApuntado,
  hoyEnMadrid,
  parseLoanCreateResult,
  parseLoanDeletePreview,
  resumenPrestamo,
  tipoComoDecimal,
} from "@/lib/prestamos";
import {
  firstIssue,
  loanCreateSchema,
  loanDeleteSchema,
  loanPreviewSchema,
  loanSettleSchema,
  loanTermsSchema,
  loanUpdateSchema,
  type ActionResult,
} from "@/lib/schemas";
import { conSesion, mensajeErrorDb } from "@/lib/acciones-servidor";

/**
 * H-08 en el servidor: el cuadro se comprueba aquí ANTES de llamar a la base,
 * con el mismo cálculo que la vista previa. Un préstamo cuyas cuotas no
 * amortizan (o cuya última cuota se desviaría) no se crea, aunque la función
 * de la base aún lo admitiera.
 */
function errorDelCuadro(t: { principal_cents: number; term_months: number; tin: number; first_charge_on: string }) {
  try {
    resumenPrestamo({
      principalCents: t.principal_cents,
      plazoMeses: t.term_months,
      tin: t.tin,
      primeraCuota: t.first_charge_on,
      comisionCents: 0,
    });
    return null;
  } catch (e) {
    if (e instanceof CuadroInvalido) return e.message;
    throw e;
  }
}

/**
 * Préstamos. Todo lo que escribe pasa por las funciones de la base
 * (create_loan, update_loan, update_loan_terms, cancel_loan, settle_loan,
 * delete_loan, generate_loan_installments): son `security invoker`, así que la
 * RLS y las claves compuestas tienen la última palabra. Aquí se valida antes
 * con Zod para dar mensajes decentes, y el TIN y la TAE viajan como TEXTO
 * decimal exacto («6.5»), nunca como un doble.
 *
 * Los campos del formulario:
 *   name, tae (opcional), payment_account_id, principal (importe), term_months,
 *   tin, fee_mode (IMPORTE | PORCENTAJE), fee, charge_day (1–28, por defecto 1),
 *   start_on, first_charge_on (opcional: por defecto, el día de cobro del mes
 *   siguiente al de inicio) y disbursed («ahora» | «apuntado»).
 */

/** Lo que cambia cuando se mueve un préstamo: saldos, gasto, patrimonio… */
const RUTAS = ["/prestamos", "/cuentas", "/resumen", "/movimientos", "/patrimonio", "/analisis"];
function revalidar() {
  for (const ruta of RUTAS) revalidatePath(ruta);
}

function campo(formData: FormData, nombre: string): string {
  const v = formData.get(nombre);
  return typeof v === "string" ? v : "";
}

/** «ahora» / «apuntado» (o true / false). Cualquier otra cosa: sin elegir. */
function leerDesembolso(formData: FormData): boolean | undefined {
  const v = campo(formData, "disbursed").trim().toLowerCase();
  if (v === "ahora" || v === "true") return true;
  if (v === "apuntado" || v === "false") return false;
  return undefined;
}

/**
 * La categoría (vacía: «Intereses») y qué cuenta como gasto: «entera» (la
 * cuota) o «intereses» (solo los intereses, lo de siempre).
 */
function leerGasto(formData: FormData) {
  return {
    category_id: campo(formData, "category_id") || null,
    counts_full_installment: campo(formData, "cuenta_gasto") === "entera",
  };
}

function leerCondiciones(formData: FormData) {
  return {
    payment_account_id: campo(formData, "payment_account_id"),
    principal_cents: campo(formData, "principal"),
    term_months: campo(formData, "term_months"),
    tin: campo(formData, "tin"),
    fee_mode: campo(formData, "fee_mode") || undefined,
    fee: campo(formData, "fee"),
    charge_day: campo(formData, "charge_day") || undefined,
    start_on: campo(formData, "start_on"),
    first_charge_on: campo(formData, "first_charge_on") || null,
    disbursed: leerDesembolso(formData),
  };
}

/** Los errores de la base, en cristiano. Los de create_loan ya vienen en español. */
function amable(error: { message?: string; code?: string }): string {
  return mensajeErrorDb(error, [
    [
      /account_name_uq|duplicate key value.*account/i,
      "Ya tienes una cuenta con el nombre de este préstamo («Préstamo · …»): ponle otro nombre.",
    ],
    [/No autenticado|Sesión sin verificar/i, "Sesión sin verificar. Vuelve a entrar."],
    [/could not find the function|schema cache/i, "Los préstamos aún no están disponibles: falta actualizar la base de datos."],
    [/nombre no coincide/i, "El nombre no coincide con el del préstamo."],
    [/Préstamo no encontrado/i, "Ese préstamo ya no existe."],
  ]);
}

// ---------------------------------------------------------------------------
// Vista previa: cuota, intereses, coste y TAE, SIN tocar la base. Usa
// lib/prestamos.ts, que da al céntimo lo mismo que loan_plan/loan_tae (lo
// comprueba scripts/test-prestamos.mjs). La interfaz puede importar ese módulo
// directamente para una vista previa en vivo; esto es para quien prefiera
// pedirla al servidor.
// ---------------------------------------------------------------------------

export type LoanPreview = {
  cuota: number;
  ultimaCuota: number;
  interesesTotales: number;
  comision: number;
  costeTotal: number;
  totalCuotas: number;
  /** TAE calculada en % (dos decimales), o null. */
  tae: number | null;
  primeraCuota: string;
  fechaFin: string;
  cuadro: CuotaDelCuadro[];
  /** Solo «ya lo tenía apuntado»: desde qué cuota sigue la app y con qué deuda arranca. */
  arranque: { primerPeriodo: number; pendiente: number } | null;
};

type PreviewResult = { ok: true; preview: LoanPreview } | { ok: false; error: string };

export async function previewLoan(formData: FormData): Promise<PreviewResult> {
  const parsed = loanPreviewSchema.safeParse(leerCondiciones(formData));
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const c = parsed.data;

  try {
    const r = resumenPrestamo({
      principalCents: c.principal_cents,
      plazoMeses: c.term_months,
      tin: c.tin,
      primeraCuota: c.first_charge_on,
      comisionCents: c.opening_fee_cents,
    });
    let arranque: LoanPreview["arranque"] = null;
    if (!c.disbursed) {
      arranque = arranqueYaApuntado(r.cuadro, hoyEnMadrid());
      if (!arranque) {
        return { ok: false, error: "Todas las cuotas de este préstamo ya han pasado: estaría pagado." };
      }
    }
    return {
      ok: true,
      preview: {
        cuota: r.cuota,
        ultimaCuota: r.ultimaCuota,
        interesesTotales: r.interesesTotales,
        comision: r.comision,
        costeTotal: r.costeTotal,
        totalCuotas: r.totalCuotas,
        tae: r.tae,
        primeraCuota: c.first_charge_on,
        fechaFin: r.fechaFin,
        cuadro: r.cuadro,
        arranque,
      },
    };
  } catch (e) {
    if (e instanceof CuadroInvalido) return { ok: false, error: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

type CreateResult =
  | { ok: true; loanId: string; generated: number; firstChargeOn: string }
  | { ok: false; error: string };

export async function createLoan(formData: FormData): Promise<CreateResult> {
  const parsed = loanCreateSchema.safeParse({
    name: campo(formData, "name"),
    tae: campo(formData, "tae") || null,
    ...leerGasto(formData),
    terms: leerCondiciones(formData),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { name, tae, category_id, counts_full_installment, terms } = parsed.data;
  const cuadroMalo = errorDelCuadro(terms);
  if (cuadroMalo) return { ok: false, error: cuadroMalo };

  const s = await conSesion();
  if (!s.ok) return s;
  const { supabase } = s;
  const { data, error } = await supabase.rpc("create_loan", {
    p_name: name,
    p_payment_account_id: terms.payment_account_id,
    p_principal_cents: terms.principal_cents,
    p_term_months: terms.term_months,
    p_tin_pct: tipoComoDecimal(terms.tin),
    p_tae_pct: tae === null ? null : tipoComoDecimal(tae),
    p_opening_fee_cents: terms.opening_fee_cents,
    p_charge_day: terms.charge_day,
    p_start_on: terms.start_on,
    p_first_charge_on: terms.first_charge_on,
    p_disbursed: terms.disbursed,
    p_category_id: category_id,
    p_counts_full_installment: counts_full_installment,
  });
  if (error) return { ok: false, error: amable(error) };

  const r = parseLoanCreateResult(data);
  if (!r) return { ok: false, error: "El préstamo se creó, pero la respuesta no se entiende. Recarga la página." };

  revalidar();
  return { ok: true, loanId: r.loan_id, generated: r.generated, firstChargeOn: r.first_charge_on };
}

// ---------------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------------

/**
 * El nombre (y el de su cuenta), la TAE del contrato, la categoría y qué cuenta
 * como gasto: se pueden cambiar siempre, porque no tocan el cuadro ni los
 * saldos. Al cambiar la categoría, los intereses ya apuntados se van con ella.
 */
export async function updateLoan(id: string, formData: FormData): Promise<ActionResult> {
  const parsed = loanUpdateSchema.safeParse({
    id,
    name: campo(formData, "name"),
    tae: campo(formData, "tae") || null,
    ...leerGasto(formData),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const s = await conSesion();
  if (!s.ok) return s;
  const { supabase } = s;
  const { error } = await supabase.rpc("update_loan", {
    p_loan_id: parsed.data.id,
    p_name: parsed.data.name,
    p_tae_pct: parsed.data.tae === null ? null : tipoComoDecimal(parsed.data.tae),
    p_category_id: parsed.data.category_id,
    p_counts_full_installment: parsed.data.counts_full_installment,
  });
  if (error) return { ok: false, error: amable(error) };

  revalidar();
  return { ok: true };
}

/**
 * Las condiciones financieras: solo mientras no haya ninguna cuota cobrada (la
 * base lo impide después). Rehace el desembolso y la comisión.
 */
export async function updateLoanTerms(
  id: string,
  formData: FormData,
): Promise<ActionResult & { generated?: number }> {
  const idOk = loanUpdateSchema.shape.id.safeParse(id);
  if (!idOk.success) return { ok: false, error: firstIssue(idOk.error) };
  const parsed = loanTermsSchema.safeParse(leerCondiciones(formData));
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const t = parsed.data;
  const cuadroMalo = errorDelCuadro(t);
  if (cuadroMalo) return { ok: false, error: cuadroMalo };

  const s = await conSesion();
  if (!s.ok) return s;
  const { supabase } = s;
  const { data, error } = await supabase.rpc("update_loan_terms", {
    p_loan_id: idOk.data,
    p_payment_account_id: t.payment_account_id,
    p_principal_cents: t.principal_cents,
    p_term_months: t.term_months,
    p_tin_pct: tipoComoDecimal(t.tin),
    p_opening_fee_cents: t.opening_fee_cents,
    p_charge_day: t.charge_day,
    p_start_on: t.start_on,
    p_first_charge_on: t.first_charge_on,
    p_disbursed: t.disbursed,
  });
  if (error) return { ok: false, error: amable(error) };

  revalidar();
  const generadas = (data as { generated?: unknown } | null)?.generated;
  return { ok: true, generated: typeof generadas === "number" ? generadas : 0 };
}

// ---------------------------------------------------------------------------
// Cerrar: cancelar (dejar de seguirlo) o liquidar antes de tiempo
// ---------------------------------------------------------------------------

/**
 * Deja de generar cuotas. No mueve dinero: lo que quede por pagar sigue en la
 * cuenta del préstamo (y en el patrimonio) hasta que se liquide o se elimine.
 */
export async function cancelLoan(id: string): Promise<ActionResult> {
  const idOk = loanUpdateSchema.shape.id.safeParse(id);
  if (!idOk.success) return { ok: false, error: firstIssue(idOk.error) };

  const s = await conSesion();
  if (!s.ok) return s;
  const { supabase } = s;
  const { error } = await supabase.rpc("cancel_loan", { p_loan_id: idOk.data });
  if (error) return { ok: false, error: amable(error) };

  revalidar();
  return { ok: true };
}

/**
 * Liquidación anticipada: cobra las cuotas vencidas hasta la fecha, paga el
 * pendiente real con un traspaso y apunta la comisión de cancelación, si la hay.
 */
export async function settleLoan(
  id: string,
  formData: FormData,
): Promise<ActionResult & { settledCents?: number }> {
  const parsed = loanSettleSchema.safeParse({
    id,
    on: campo(formData, "on") || null,
    fee_cents: campo(formData, "fee"),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const s = await conSesion();
  if (!s.ok) return s;
  const { supabase } = s;
  const { data, error } = await supabase.rpc("settle_loan", {
    p_loan_id: parsed.data.id,
    p_on: parsed.data.on,
    p_fee_cents: parsed.data.fee_cents,
  });
  if (error) return { ok: false, error: amable(error) };

  revalidar();
  const pagado = (data as { settled_cents?: unknown } | null)?.settled_cents;
  return { ok: true, settledCents: typeof pagado === "number" ? pagado : 0 };
}

// ---------------------------------------------------------------------------
// Eliminar, con el patrón de delete_account: primero qué cambia, y se borra solo
// si el nombre escrito coincide.
// ---------------------------------------------------------------------------

type DeletePreviewResult = { ok: true; preview: LoanDeletePreview } | { ok: false; error: string };

export async function previewLoanDeletion(id: string): Promise<DeletePreviewResult> {
  const idOk = loanDeleteSchema.shape.id.safeParse(id);
  if (!idOk.success) return { ok: false, error: firstIssue(idOk.error) };

  const s = await conSesion();
  if (!s.ok) return s;
  const { supabase } = s;
  const { data, error } = await supabase.rpc("loan_delete_preview", { p_loan_id: idOk.data });
  if (error) return { ok: false, error: amable(error) };

  const preview = parseLoanDeletePreview(data);
  if (!preview) return { ok: false, error: "No se pudo calcular qué se borraría. Inténtalo de nuevo." };
  return { ok: true, preview };
}

/**
 * Borra el préstamo con todos sus movimientos (desembolso, comisiones, cuotas,
 * liquidación), lo apuntado a mano en su cuenta y la propia cuenta. No tiene
 * vuelta atrás: la interfaz debería ofrecer antes «cancelar».
 */
export async function deleteLoan(id: string, formData: FormData): Promise<ActionResult> {
  const parsed = loanDeleteSchema.safeParse({ id, confirm_name: campo(formData, "confirm_name") });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const s = await conSesion();
  if (!s.ok) return s;
  const { supabase } = s;
  const { error } = await supabase.rpc("delete_loan", {
    p_loan_id: parsed.data.id,
    p_confirm_name: parsed.data.confirm_name,
  });
  if (error) return { ok: false, error: amable(error) };

  revalidar();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Generar las cuotas vencidas a mano. No hace falta para que se cobren (lo hace
// el cron de /api/notificar cada dos horas), pero sirve para no esperar.
// Idempotente: pulsarlo dos veces no cobra dos veces.
// ---------------------------------------------------------------------------

export async function generateLoanInstallments(): Promise<ActionResult & { created?: number }> {
  const s = await conSesion();
  if (!s.ok) return s;
  const { supabase } = s;
  const { data, error } = await supabase.rpc("generate_loan_installments");
  if (error) return { ok: false, error: amable(error) };

  revalidar();
  return { ok: true, created: data ?? 0 };
}
