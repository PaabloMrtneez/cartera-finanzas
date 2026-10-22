import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { addDays } from "@/lib/dates";
import { ErrorPrecios, descargarHistorico, descargarTiposDeCambio, esReintentable } from "@/lib/precios/fuentes";
import { guardarCambios, guardarPrecios } from "@/lib/precios/guardar";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Actualiza los precios de los instrumentos que se siguen y los tipos de cambio
 * que hacen falta. La llama una tarea programada (.github/workflows/precios.yml),
 * no una persona.
 *
 * Se protege con el SECRETO DE LAS TAREAS PROGRAMADAS, `NOTIFY_SECRET`: el
 * mismo que ya usa /api/notificar, para no obligar a crear y custodiar otro.
 * Viaja como `Authorization: Bearer …` y se compara en tiempo constante.
 *
 * Qué hace:
 *   1. Pregunta a la base qué instrumentos sigue hoy alguna posición NO
 *      archivada (`instruments_to_refresh`, solo service_role).
 *   2. Para cada uno pide a Yahoo los cierres desde una semana antes del último
 *      guardado (o desde una semana antes del alta, si aún no tiene ninguno).
 *      Volver a pedir los últimos días es a propósito: los fondos publican con
 *      retraso y Yahoo a veces corrige; el upsert lo deja todo como debe.
 *   3. Para cada divisa distinta del euro, lo mismo con el BCE, A LA VEZ que
 *      los precios (no depende de ellos).
 *   4. Devuelve un resumen sin datos personales: cuántos instrumentos, cuántos
 *      precios y cambios nuevos, y qué símbolos han fallado y por qué.
 *
 * Si Yahoo falla con un símbolo, no se inventa nada: se apunta el fallo y se
 * sigue con los demás. La posición seguirá valorándose con el último precio
 * que haya (y la interfaz la marcará desactualizada si pasan días).
 *
 * H-23 · Tiempo: la función tiene 60 s. Antes iba uno detrás de otro, con 8 s
 * por petición: siete símbolos colgados y se moría sin llegar a los cambios ni
 * devolver el resumen. Ahora:
 *   · como mucho CONCURRENCIA peticiones a la vez (pocas, para no provocar el
 *     429 que se quiere evitar);
 *   · un presupuesto total de PRESUPUESTO_MS que corta lo que quede en vuelo
 *     y deja sin empezar lo pendiente (se apunta como `sin_tiempo`: el
 *     siguiente cron lo recupera, porque se pide con 7 días de solape);
 *   · un reintento, tras una espera, ante un 429 o un 5xx.
 *
 * service_role solo existe aquí dentro, en el servidor (invariante 8).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function secretoValido(recibido: string | undefined, esperado: string): boolean {
  if (!recibido) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Días de solape al volver a pedir: cubre fines de semana, festivos y correcciones. */
const SOLAPE_DIAS = 7;
/** Peticiones a la vez. */
const CONCURRENCIA = 3;
/** Todo lo de fuera tiene que acabar aquí: deja margen hasta los 60 s para guardar y responder. */
const PRESUPUESTO_MS = 45_000;
/** Espera antes de reintentar un 429 o un 5xx. */
const ESPERA_REINTENTO_MS = 2_000;

type Fallo = { simbolo: string; error: string };

/**
 * Ejecuta `tareas` con como mucho `limite` a la vez, en orden de llegada. Una
 * tarea que lanza no para a las demás (cada una se encarga de sus errores).
 */
async function enParalelo<T>(elementos: T[], limite: number, tarea: (e: T) => Promise<void>): Promise<void> {
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < elementos.length) {
      const e = elementos[siguiente++];
      await tarea(e);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, elementos.length) }, trabajador));
}

/** Una vez, y si es un 429 o un 5xx y queda presupuesto, otra tras una espera. */
async function conReintento<T>(fn: () => Promise<T>, presupuesto: AbortSignal): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!esReintentable(e) || presupuesto.aborted) throw e;
    await new Promise((resolver) => setTimeout(resolver, ESPERA_REINTENTO_MS));
    if (presupuesto.aborted) throw e;
    return fn();
  }
}

function codigoDeError(e: unknown, presupuesto: AbortSignal): string {
  if (presupuesto.aborted) return "sin_tiempo";
  return e instanceof ErrorPrecios ? e.codigo : "error_al_guardar";
}

export async function POST(request: Request) {
  const esperado = process.env.NOTIFY_SECRET;
  const recibido = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!esperado || !secretoValido(recibido, esperado)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const presupuesto = AbortSignal.timeout(PRESUPUESTO_MS);
  const opciones = { signal: presupuesto };

  const admin = createAdminClient();
  const { data: instrumentos, error } = await admin.rpc("instruments_to_refresh");
  if (error) {
    return NextResponse.json({ ok: false, error: "no_se_pudo_leer_la_base" }, { status: 500 });
  }
  const lista = instrumentos ?? [];

  // Tipos de cambio: una petición por divisa, desde lo más antiguo que haga
  // falta entre los instrumentos de esa divisa.
  const porDivisa = new Map<string, string>();
  for (const inst of lista) {
    if (inst.currency === "EUR") continue;
    const desde = addDays(inst.last_price_date ?? inst.desde, -SOLAPE_DIAS);
    const actual = porDivisa.get(inst.currency);
    if (!actual || desde < actual) porDivisa.set(inst.currency, desde);
  }

  // Los fallos se apuntan en el orden de la lista, no en el que acaban.
  const fallosPorIndice = new Map<number, Fallo>();
  let preciosNuevos = 0;
  let preciosEscritos = 0;

  const precios = enParalelo(
    lista.map((inst, i) => ({ inst, i })),
    CONCURRENCIA,
    async ({ inst, i }) => {
      if (presupuesto.aborted) {
        fallosPorIndice.set(i, { simbolo: inst.yahoo_symbol, error: "sin_tiempo" });
        return;
      }
      const desde = addDays(inst.last_price_date ?? inst.desde, -SOLAPE_DIAS);
      try {
        const cotizacion = await conReintento(() => descargarHistorico(inst.yahoo_symbol, desde, opciones), presupuesto);
        if (cotizacion.divisa !== inst.currency) {
          // Si Yahoo cambiara la divisa de un símbolo, sus precios ya no serían
          // comparables con los guardados: mejor no escribir nada y avisar.
          fallosPorIndice.set(i, { simbolo: inst.yahoo_symbol, error: `divisa_cambiada:${cotizacion.divisa}` });
          return;
        }
        // Primero el await y luego la suma: `x += await y` lee x ANTES de esperar
        // y, con varias tareas a la vez, perdería lo que sumen las demás.
        const escritos = await guardarPrecios(admin, inst.instrument_id, cotizacion.precios);
        preciosEscritos += escritos;
        preciosNuevos += cotizacion.precios.filter(
          (p) => inst.last_price_date === null || p.fecha > inst.last_price_date,
        ).length;
      } catch (e) {
        fallosPorIndice.set(i, { simbolo: inst.yahoo_symbol, error: codigoDeError(e, presupuesto) });
      }
    },
  );

  let cambiosEscritos = 0;
  const fallosCambioPorDivisa = new Map<string, Fallo>();
  const cambios = enParalelo([...porDivisa], CONCURRENCIA, async ([divisa, desdeInstrumentos]) => {
    if (presupuesto.aborted) {
      fallosCambioPorDivisa.set(divisa, { simbolo: divisa, error: "sin_tiempo" });
      return;
    }
    try {
      // Si el último cambio guardado es más antiguo, se pide desde ahí.
      const { data: ultimo } = await admin
        .from("fx_rate")
        .select("date")
        .eq("currency", divisa)
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle();
      const desdeCambio = ultimo ? addDays(ultimo.date, -SOLAPE_DIAS) : desdeInstrumentos;
      const desde = desdeCambio < desdeInstrumentos ? desdeCambio : desdeInstrumentos;
      const tasas = await conReintento(() => descargarTiposDeCambio(divisa, desde, opciones), presupuesto);
      const escritos = await guardarCambios(admin, divisa, tasas);
      cambiosEscritos += escritos;
    } catch (e) {
      fallosCambioPorDivisa.set(divisa, { simbolo: divisa, error: codigoDeError(e, presupuesto) });
    }
  });

  await Promise.all([precios, cambios]);

  const fallos = [...fallosPorIndice].sort(([a], [b]) => a - b).map(([, f]) => f);
  const fallosCambio = [...porDivisa.keys()].flatMap((d) => fallosCambioPorDivisa.get(d) ?? []);

  return NextResponse.json({
    ok: fallos.length === 0 && fallosCambio.length === 0,
    instrumentos: lista.length,
    precios_nuevos: preciosNuevos,
    precios_escritos: preciosEscritos,
    divisas: porDivisa.size,
    cambios_escritos: cambiosEscritos,
    fallos,
    fallos_cambio: fallosCambio,
  });
}
