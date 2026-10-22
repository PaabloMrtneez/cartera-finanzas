import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Cotizacion, PrecioDiario, TipoDeCambio } from "./fuentes";

/**
 * Escritura de los datos COMPARTIDOS de mercado: catálogo, precios y cambios.
 *
 * Solo con el cliente de service_role (`createAdminClient`): la RLS no deja a
 * ningún usuario escribir aquí. Todo es upsert por la clave natural, así que
 * repetir una descarga (el cron que dispara dos veces, un reintento) deja la
 * base igual: idempotente. Un precio que Yahoo corrige, o el del día en curso
 * de una acción que aún cotiza, se sobrescribe con el último que llegue.
 */

type Admin = SupabaseClient<Database>;

/** PostgREST acepta lotes grandes, pero un histórico de años son miles de filas. */
const LOTE = 500;

export type InstrumentoGuardado = { id: string; currency: string; yahoo_symbol: string };

/**
 * Da de alta el instrumento en el catálogo si no estaba (por su símbolo de
 * Yahoo) y devuelve su fila. Si ya estaba, no se toca: el catálogo es de todos
 * y una segunda persona siguiendo el mismo fondo no debe cambiarle el nombre al
 * de la primera. El ISIN sí se completa si faltaba.
 */
export async function asegurarInstrumento(
  admin: Admin,
  cotizacion: Cotizacion,
  isin: string | null,
): Promise<InstrumentoGuardado> {
  if (!cotizacion.tipo) throw new Error("Solo se siguen fondos, ETF y acciones");

  const { data: existente, error: e1 } = await admin
    .from("instrument")
    .select("id, currency, yahoo_symbol, isin")
    .eq("yahoo_symbol", cotizacion.simbolo)
    .maybeSingle();
  if (e1) throw new Error(e1.message);

  if (existente) {
    if (isin && !existente.isin) {
      const { error } = await admin.from("instrument").update({ isin }).eq("id", existente.id);
      if (error) throw new Error(error.message);
    }
    return { id: existente.id, currency: existente.currency, yahoo_symbol: existente.yahoo_symbol };
  }

  const { data, error } = await admin
    .from("instrument")
    .upsert(
      {
        kind: cotizacion.tipo,
        yahoo_symbol: cotizacion.simbolo,
        name: cotizacion.nombre.slice(0, 200),
        currency: cotizacion.divisa,
        exchange: cotizacion.mercado?.slice(0, 60) ?? null,
        isin,
      },
      { onConflict: "yahoo_symbol", ignoreDuplicates: false },
    )
    .select("id, currency, yahoo_symbol")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Guarda (upsert) los cierres de un instrumento. Devuelve cuántas filas ha escrito. */
export async function guardarPrecios(
  admin: Admin,
  instrumentId: string,
  precios: readonly PrecioDiario[],
): Promise<number> {
  const ahora = new Date().toISOString();
  let escritos = 0;
  for (let i = 0; i < precios.length; i += LOTE) {
    const filas = precios.slice(i, i + LOTE).map((p) => ({
      instrument_id: instrumentId,
      date: p.fecha,
      close: p.cierre,
      fetched_at: ahora,
    }));
    const { error } = await admin
      .from("instrument_price")
      .upsert(filas, { onConflict: "instrument_id,date" });
    if (error) throw new Error(error.message);
    escritos += filas.length;
  }
  return escritos;
}

/** Guarda (upsert) los tipos de cambio de una divisa. Devuelve cuántas filas ha escrito. */
export async function guardarCambios(
  admin: Admin,
  divisa: string,
  cambios: readonly TipoDeCambio[],
): Promise<number> {
  const ahora = new Date().toISOString();
  let escritos = 0;
  for (let i = 0; i < cambios.length; i += LOTE) {
    const filas = cambios.slice(i, i + LOTE).map((c) => ({
      currency: divisa,
      date: c.fecha,
      rate: c.tasa,
      fetched_at: ahora,
    }));
    const { error } = await admin.from("fx_rate").upsert(filas, { onConflict: "currency,date" });
    if (error) throw new Error(error.message);
    escritos += filas.length;
  }
  return escritos;
}
