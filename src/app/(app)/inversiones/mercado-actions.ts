"use server";

import { revalidatePath } from "next/cache";
import { addDays, hoyMadrid } from "@/lib/dates";
import { mensajeErrorDb } from "@/lib/errores-db";
import { isinValido } from "@/lib/participaciones";
import {
  ErrorPrecios,
  buscarCandidatos,
  descargarHistorico,
  descargarTiposDeCambio,
  type Candidato,
} from "@/lib/precios/fuentes";
import { asegurarInstrumento, guardarCambios, guardarPrecios } from "@/lib/precios/guardar";
import {
  ajustarParticipacionesSchema,
  buscarInstrumentosSchema,
  dejarDeSeguirSchema,
  firstIssue,
  participacionesAportacionSchema,
  seguirInstrumentoSchema,
  type AjustarParticipacionesInput,
  type DejarDeSeguirInput,
  type ParticipacionesAportacionInput,
  type SeguirInstrumentoInput,
} from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions de las inversiones que se actualizan solas. Todavía sin
 * interfaz: la pantalla llega en la fase siguiente.
 *
 * Reparto de responsabilidades, que es lo que sostiene la seguridad:
 *
 *   · Lo COMPARTIDO (catálogo, precios, cambios) se escribe con service_role,
 *     y SOLO después de haber validado el símbolo contra Yahoo aquí, en el
 *     servidor. Ningún usuario puede escribirlo directamente.
 *   · Lo DE CADA USUARIO (la posición, el libro de participaciones, las
 *     participaciones de una aportación) se escribe con el cliente de la
 *     sesión: la RLS y las claves foráneas compuestas deciden.
 *
 * Las participaciones llegan como TEXTO y se convierten a decimal exacto
 * (lib/participaciones.ts); lo aportado, con parseAmountToCents. Ningún float.
 */

type Resultado<T> = ({ ok: true } & T) | { ok: false; error: string };

/** Días de margen al rellenar el histórico: el precio de la víspera del alta. */
const MARGEN_DIAS = 10;

const RUTAS = ["/inversiones", "/patrimonio", "/resumen", "/cuentas", "/metas"];

function revalidar() {
  for (const ruta of RUTAS) revalidatePath(ruta);
}

async function sesion() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

function mensajePrecios(e: unknown, simbolo: string): string {
  if (e instanceof ErrorPrecios) {
    switch (e.codigo) {
      case "NO_ENCONTRADO":
      case "SIMBOLO_NO_VALIDO":
        return `Yahoo no encuentra «${simbolo}». Búscalo de nuevo y elige uno de la lista.`;
      case "TIEMPO":
      case "RED":
        return "Yahoo no responde ahora mismo. Inténtalo en un rato.";
      default:
        return "Yahoo ha devuelto algo que no se entiende. Inténtalo en un rato.";
    }
  }
  return "No se han podido guardar los precios. Inténtalo de nuevo.";
}

function amable(message: string): string {
  if (/no sigue ningún instrumento/i.test(message)) {
    return "Esa posición no sigue ningún instrumento en esa fecha.";
  }
  if (/unit_event_date|date_check|not_future/i.test(message)) {
    return "La fecha no puede ser futura.";
  }
  if (/position_name_uq|duplicate key/i.test(message)) return "Ya tienes una posición con ese nombre.";
  if (/position_is_invest/i.test(message)) {
    return "Una posición solo puede colgar de una cuenta de tipo Inversión.";
  }
  if (/tx_units_only_position/i.test(message)) {
    return "Solo una aportación a una posición puede llevar participaciones.";
  }
  if (/23503|foreign key/i.test(message)) return "Esa posición ya no existe. Recarga la página.";
  if (/no encontrada/i.test(message)) return "No se encuentra esa posición.";
  return mensajeErrorDb(message);
}

// ---------------------------------------------------------------------------
// Buscar
// ---------------------------------------------------------------------------

/**
 * Candidatos para seguir: por ISIN, por nombre o por símbolo. Cada uno con su
 * divisa, su último precio y la fecha de ese precio, para elegir la clase
 * correcta de un fondo (LC, LD, USD…). Si lo buscado es un ISIN, se devuelve
 * para guardarlo con el instrumento elegido.
 *
 * Pide sesión: no es un proxy abierto hacia Yahoo.
 */
export async function buscarInstrumentos(
  q: string,
): Promise<Resultado<{ candidatos: Candidato[]; isin: string | null }>> {
  const parsed = buscarInstrumentosSchema.safeParse({ q });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const { user } = await sesion();
  if (!user) return { ok: false, error: "Sesión caducada. Vuelve a entrar." };

  const consulta = parsed.data.q;
  const isin = isinValido(consulta) ? consulta.toUpperCase() : null;
  try {
    const candidatos = await buscarCandidatos(consulta);
    if (candidatos.length === 0 && isin) {
      return {
        ok: false,
        error: "Yahoo no encuentra ese ISIN. Prueba con el nombre del fondo (por ejemplo «DWS Invest Gold»).",
      };
    }
    return { ok: true, candidatos, isin };
  } catch (e) {
    return { ok: false, error: mensajePrecios(e, consulta) };
  }
}

// ---------------------------------------------------------------------------
// Seguir un instrumento
// ---------------------------------------------------------------------------

/**
 * Hace que una posición (existente o nueva) siga un instrumento desde `fecha`
 * con `participaciones` exactas y `aportado` en total hasta ese día.
 *
 *   1. Valida el símbolo contra Yahoo y descarga su histórico desde unos días
 *      antes de la fecha (y el cambio del BCE si no cotiza en euros). Si algo de
 *      esto falla, no se escribe NADA.
 *   2. Da de alta el instrumento en el catálogo (si no estaba) y guarda los
 *      precios y cambios, con service_role.
 *   3. Con la sesión del usuario: crea la posición si es nueva y anota el ALTA
 *      en su libro.
 *
 * Una posición que ya seguía un instrumento puede volver a darse de alta (otra
 * clase del mismo fondo, por ejemplo): el ALTA nuevo abre otro periodo y el
 * anterior se conserva en el libro.
 */
export async function seguirInstrumento(
  input: SeguirInstrumentoInput,
): Promise<
  Resultado<{
    position_id: string;
    instrument_id: string;
    divisa: string;
    ultimoPrecio: string | null;
    fechaUltimoPrecio: string | null;
  }>
> {
  const parsed = seguirInstrumentoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const datos = parsed.data;

  if (datos.fecha > hoyMadrid()) return { ok: false, error: "La fecha no puede ser futura." };

  const { supabase, user } = await sesion();
  if (!user) return { ok: false, error: "Sesión caducada. Vuelve a entrar." };

  // La posición existe y es de quien llama (la RLS solo deja ver las propias).
  if (datos.position_id) {
    const { data: posicion, error } = await supabase
      .from("investment_position")
      .select("id, archived")
      .eq("id", datos.position_id)
      .maybeSingle();
    if (error) return { ok: false, error: amable(error.message) };
    if (!posicion) return { ok: false, error: "No se encuentra esa posición." };
    if (posicion.archived) return { ok: false, error: "Esa posición está archivada." };
  }

  // 1. Todo lo que viene de fuera, ANTES de escribir nada.
  const desde = addDays(datos.fecha, -MARGEN_DIAS);
  let cotizacion;
  try {
    cotizacion = await descargarHistorico(datos.simbolo, desde);
  } catch (e) {
    return { ok: false, error: mensajePrecios(e, datos.simbolo) };
  }
  if (!cotizacion.tipo) {
    return { ok: false, error: "Solo se pueden seguir fondos, ETF y acciones." };
  }
  if (cotizacion.precios.length === 0) {
    return {
      ok: false,
      error: `Yahoo no tiene precios de ${cotizacion.simbolo} desde esa fecha. Prueba con una fecha más reciente.`,
    };
  }

  let cambios: Awaited<ReturnType<typeof descargarTiposDeCambio>> = [];
  if (cotizacion.divisa !== "EUR") {
    try {
      cambios = await descargarTiposDeCambio(cotizacion.divisa, desde);
    } catch {
      return { ok: false, error: "El BCE no responde ahora mismo. Inténtalo en un rato." };
    }
    if (cambios.length === 0) {
      return {
        ok: false,
        error: `El BCE no publica el cambio de ${cotizacion.divisa} a euros: ese instrumento no se puede valorar.`,
      };
    }
  }

  // 2. Lo compartido, con service_role.
  let instrumento;
  try {
    const admin = createAdminClient();
    instrumento = await asegurarInstrumento(admin, cotizacion, datos.isin);
    await guardarPrecios(admin, instrumento.id, cotizacion.precios);
    if (cambios.length > 0) await guardarCambios(admin, cotizacion.divisa, cambios);
  } catch {
    return { ok: false, error: "No se ha podido guardar el instrumento. Inténtalo de nuevo." };
  }

  // 3. Lo del usuario, con su sesión.
  let positionId = datos.position_id;
  if (!positionId && datos.nueva) {
    const { data: creada, error } = await supabase
      .from("investment_position")
      .insert({ ...datos.nueva, since: datos.fecha, user_id: user.id })
      .select("id")
      .single();
    if (error) return { ok: false, error: amable(error.message) };
    positionId = creada.id;
  }
  if (!positionId) return { ok: false, error: "Elige una posición o crea una nueva" };

  const { error: eAlta } = await supabase.from("position_unit_event").insert({
    user_id: user.id,
    position_id: positionId,
    kind: "ALTA",
    date: datos.fecha,
    instrument_id: instrumento.id,
    units: datos.participaciones,
    contributed_cents: datos.aportado,
  });
  if (eAlta) {
    const motivo = amable(eAlta.message);
    return {
      ok: false,
      error: datos.nueva
        ? `La posición se ha creado, pero no se ha podido empezar a seguir el instrumento (${motivo}). Vuelve a intentarlo desde la posición.`
        : motivo,
    };
  }

  revalidar();
  const ultimo = cotizacion.precios[cotizacion.precios.length - 1] ?? null;
  return {
    ok: true,
    position_id: positionId,
    instrument_id: instrumento.id,
    divisa: instrumento.currency,
    ultimoPrecio: ultimo?.cierre ?? null,
    fechaUltimoPrecio: ultimo?.fecha ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ajustar participaciones
// ---------------------------------------------------------------------------

/**
 * «MyInvestor dice que tengo X participaciones a fecha D». Se anota como
 * AJUSTE en el libro: nuevo punto de partida desde esa fecha (las aportaciones
 * del mismo día se dan por incluidas). El pasado no se reescribe, y un ajuste
 * equivocado se corrige con otro.
 */
export async function ajustarParticipaciones(input: AjustarParticipacionesInput): Promise<Resultado<object>> {
  const parsed = ajustarParticipacionesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const datos = parsed.data;
  if (datos.fecha > hoyMadrid()) return { ok: false, error: "La fecha no puede ser futura." };

  const { supabase, user } = await sesion();
  if (!user) return { ok: false, error: "Sesión caducada. Vuelve a entrar." };

  // El disparador del libro rechaza el ajuste si ese día no se sigue nada.
  const { error } = await supabase.from("position_unit_event").insert({
    user_id: user.id,
    position_id: datos.position_id,
    kind: "AJUSTE",
    date: datos.fecha,
    units: datos.participaciones,
    note: datos.nota,
  });
  if (error) return { ok: false, error: amable(error.message) };

  revalidar();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dejar de seguir
// ---------------------------------------------------------------------------

/**
 * Vuelve a valorar la posición a mano desde `fecha`, sin perder historia: el
 * libro conserva el ALTA y los AJUSTES, los precios siguen en el catálogo y la
 * curva del pasado se sigue calculando con ellos. Para que el valor no salte,
 * la base registra como valoración manual el valor de mercado de ese día
 * (`unfollow_instrument`, en una sola transacción). Devuelve ese valor.
 */
export async function dejarDeSeguir(
  input: DejarDeSeguirInput,
): Promise<Resultado<{ value_cents: number }>> {
  const parsed = dejarDeSeguirSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const datos = parsed.data;
  if (datos.fecha > hoyMadrid()) return { ok: false, error: "La fecha no puede ser futura." };

  const { supabase, user } = await sesion();
  if (!user) return { ok: false, error: "Sesión caducada. Vuelve a entrar." };

  const { data, error } = await supabase.rpc("unfollow_instrument", {
    p_position_id: datos.position_id,
    p_date: datos.fecha,
  });
  if (error) return { ok: false, error: amable(error.message) };

  revalidar();
  return { ok: true, value_cents: data };
}

// ---------------------------------------------------------------------------
// Participaciones de una aportación
// ---------------------------------------------------------------------------

/**
 * Anota (o borra, con null) las participaciones que compró una aportación. Sin
 * ellas, el cálculo las estima con el último precio de su fecha y lo marca
 * como estimación. La base exige que el movimiento vaya a una posición.
 */
export async function participacionesDeAportacion(
  input: ParticipacionesAportacionInput,
): Promise<Resultado<object>> {
  const parsed = participacionesAportacionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const { supabase, user } = await sesion();
  if (!user) return { ok: false, error: "Sesión caducada. Vuelve a entrar." };

  const { data, error } = await supabase
    .from("transaction")
    .update({ position_units: parsed.data.participaciones })
    .eq("id", parsed.data.transaction_id)
    .select("id");
  if (error) return { ok: false, error: amable(error.message) };
  if (!data || data.length === 0) return { ok: false, error: "No se encuentra ese movimiento." };

  revalidar();
  revalidatePath("/movimientos");
  return { ok: true };
}
