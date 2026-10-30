import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import {
  avisoDePago,
  centimosDeNumero,
  esErrorDeDatos,
  esInstanteIso,
  ultimosCuatro,
} from "@/lib/ingesta";
import { idDeAviso, leerAvisoCartera } from "@/lib/aviso-cartera";
import { parseAmountToCents } from "@/lib/money";
import { configurarPush, enviarAviso } from "@/lib/push";
import type { Database, Json } from "@/lib/supabase/database.types";
// Los mensajes de Zod del detalle de un rechazo, en español (H-11).
import "@/lib/zod-es";

/**
 * Entrada de los pagos que captura el Atajo del iPhone.
 *
 * No usa sesión: se autentica con un token de dispositivo, que solo puede
 * ESCRIBIR movimientos. Aunque alguien se hiciera con él, no podría leer ni un
 * euro; y todo lo que entre sin una regla que lo clasifique queda pendiente de
 * revisión, así que tampoco puede colar cifras a escondidas.
 *
 * La lógica vive en una función de Postgres para que autenticación, límite de
 * peticiones, idempotencia, motor de reglas e inserción ocurran en una sola
 * transacción. El disparador de iOS agota el tiempo de espera y reintenta, así
 * que dos llamadas simultáneas son lo normal, no la excepción.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const MAX_BODY = 4096;

/**
 * Guardo barato en memoria contra ráfagas, ANTES de tocar la base de datos.
 *
 * NO es un limitador de borde: en serverless la memoria es por instancia y
 * efímera, y varias instancias no lo comparten. Es a propósito: el límite de
 * verdad (60 cada 10 min POR DISPOSITIVO) vive en la función de Postgres, tras
 * autenticar el token. Esto solo evita que un flujo de basura con el prefijo
 * `cart_` dispare una consulta —el hash + el select del dispositivo— por cada
 * petición. Para una app privada de cuatro usuarios es suficiente y proporcionado.
 *
 * La ventana es generosa (muy por encima de lo que manda el Atajo real) para no
 * estorbar nunca al uso legítimo y cortar solo las ráfagas.
 */
const RAFAGA_VENTANA_MS = 60_000;
const RAFAGA_MAX = 60;
const RAFAGA_MAX_IPS = 5_000; // Cota de memoria del propio guardo.
const rafagaPorIp = new Map<string, { hasta: number; golpes: number }>();

function ipDeLaPeticion(request: Request): string {
  const reenviada = request.headers.get("x-forwarded-for");
  if (reenviada) return reenviada.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "desconocida";
}

function rafagaExcedida(ip: string): boolean {
  const ahora = Date.now();
  // Poda perezosa: si el mapa se dispara, se vacía entero. Perder los contadores
  // no tiene coste —el cerrojo real está en la base— y acota la memoria del guardo.
  if (rafagaPorIp.size > RAFAGA_MAX_IPS) rafagaPorIp.clear();

  const cubo = rafagaPorIp.get(ip);
  if (!cubo || cubo.hasta <= ahora) {
    rafagaPorIp.set(ip, { hasta: ahora + RAFAGA_VENTANA_MS, golpes: 1 });
    return false;
  }
  cubo.golpes += 1;
  return cubo.golpes > RAFAGA_MAX;
}

const payloadSchema = z.object({
  /** De dónde viene. Sirve para distinguir orígenes futuros (CSV, banco...). */
  source: z.string().max(40).default("ios-wallet"),
  merchant: z.string().max(200).nullish(),
  /** Llega como texto ya formateado por el iPhone: «23,45 €», «1.234,56»... */
  amount: z.union([z.string().max(40), z.number()]),
  currency: z.string().max(10).default("EUR"),
  /** Los últimos dígitos de la tarjeta, para encaminarlo a la cuenta correcta. */
  card: z.string().max(40).nullish(),
  occurred_at: z.string().max(40).nullish(),
  /** Identificador propio de cada ejecución del atajo. Da la idempotencia. */
  external_id: z.string().max(128).nullish(),
});

/**
 * El aviso de Cartera tal como lo entrega iOS 27 al atajo: Título (la
 * tarjeta), Subtítulo (el comercio), Cuerpo (el importe) y Fecha. Sin leer
 * aquí: eso lo hace lib/aviso-cartera.ts, con sus pruebas.
 */
const avisoCarteraSchema = z.object({
  source: z.string().max(40),
  tarjeta: z.string().max(80).nullish(),
  comercio: z.string().max(200).nullish(),
  importe: z.string().max(80),
  fecha: z.string().max(60).nullish(),
});

/** ¿Es un aviso de Cartera? Lo dice el campo `source`, fijo en su atajo. */
function esAvisoDeCartera(cuerpo: unknown): boolean {
  return (
    typeof cuerpo === "object" &&
    cuerpo !== null &&
    String((cuerpo as { source?: unknown }).source ?? "").trim().toLowerCase() === "cartera"
  );
}

/**
 * Lee el cuerpo como texto sin pasar de `max` BYTES. Mira primero el
 * `content-length` (si lo trae y se pasa, ni se lee) y luego cuenta lo que va
 * llegando, porque esa cabecera puede faltar o mentir. Null si se pasa.
 */
async function leerCuerpoAcotado(request: Request, max: number): Promise<string | null> {
  const declarada = Number(request.headers.get("content-length"));
  if (Number.isFinite(declarada) && declarada > max) return null;
  if (!request.body) return "";

  const lector = request.body.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await lector.cancel().catch(() => {});
      return null;
    }
    trozos.push(value);
  }
  const todo = new Uint8Array(total);
  let desde = 0;
  for (const t of trozos) {
    todo.set(t, desde);
    desde += t.byteLength;
  }
  return new TextDecoder().decode(todo);
}

/**
 * Ventana en la que un envío idéntico (mismo dispositivo, comercio, importe y
 * tarjeta) se toma por el reintento del anterior y no por otro pago (H-21).
 */
const VENTANA_REINTENTO_MS = 90_000;

/**
 * El `external_id` para un envío que no lo trae (el Atajo de la guía no lo
 * manda, y no se cambia su contrato).
 *
 * Antes lo sintetizaba la base con el MINUTO: un reintento que cruzaba el
 * cambio de minuto duplicaba el cargo, y dos cafés iguales en el mismo minuto
 * se fundían en uno. Ahora la ventana es deslizante: si este dispositivo
 * registró un cargo idéntico en los últimos 90 s, se reutiliza su
 * `external_id` (la base lo da por duplicado y no avisa dos veces); si no, el
 * envío es otro pago y lleva un identificador propio.
 *
 * Si la consulta falla, devuelve undefined y la base sintetiza el de siempre:
 * mejor la deduplicación vieja que ninguna.
 */
async function externalIdPorVentana(
  supabase: ReturnType<typeof createClient<Database>>,
  token: string,
  cents: number,
  merchant: string | null,
  card: string | null,
): Promise<string | undefined> {
  try {
    const hash = createHash("sha256").update(token).digest("hex");
    // `token_hash` no está en los tipos (nunca se lee desde la app): se filtra
    // por él con el service_role, igual que hace la función de ingesta.
    const dispositivos = supabase.from("ingest_device") as unknown as {
      select(c: "id"): {
        eq(c: "token_hash", v: string): {
          is(c: "revoked_at", v: null): {
            maybeSingle(): PromiseLike<{ data: { id: string } | null; error: unknown }>;
          };
        };
      };
    };
    const { data: dispositivo, error: errorDispositivo } = await dispositivos
      .select("id")
      .eq("token_hash", `\\x${hash}`)
      .is("revoked_at", null)
      .maybeSingle();
    if (errorDispositivo || !dispositivo) return undefined;

    const desde = new Date(Date.now() - VENTANA_REINTENTO_MS).toISOString();
    let consulta = supabase
      .from("transaction")
      .select("external_id")
      .eq("device_id", dispositivo.id)
      .eq("amount_cents", cents)
      .gte("created_at", desde)
      .not("external_id", "is", null);
    consulta = merchant ? consulta.eq("merchant_raw", merchant) : consulta.is("merchant_raw", null);
    consulta = card ? consulta.eq("card_last4", card) : consulta.is("card_last4", null);
    const { data: previos, error } = await consulta.order("created_at", { ascending: false }).limit(1);
    if (error) return undefined;

    return previos?.[0]?.external_id ?? `atajo_${randomUUID()}`;
  } catch {
    return undefined;
  }
}

/** Sin las claves `undefined`: lo mismo que haría JSON al enviarlo, pero tipado. */
function sinIndefinidos(objeto: Record<string, unknown>): { [clave: string]: Json } {
  return Object.fromEntries(Object.entries(objeto).filter(([, v]) => v !== undefined)) as {
    [clave: string]: Json;
  };
}

function json(body: unknown, status: number, headers?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export async function POST(request: Request) {
  // 1) El token, antes de tocar la base de datos: así la basura no gasta cupo.
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith("cart_")) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // 1b) Cortafuegos de ráfaga por IP, ANTES del hash y el select del dispositivo.
  //     Una avalancha de tokens `cart_` inventados ya no dispara una consulta
  //     por petición: se corta aquí, en memoria, sin tocar la base de datos.
  if (rafagaExcedida(ipDeLaPeticion(request))) {
    return json({ ok: false, error: "rate_limited", retry_after: 60 }, 429, {
      "Retry-After": "60",
    });
  }

  // 2) Cuerpo acotado: nadie necesita mandar más de 4 KB para un cargo. Se
  //    cuentan BYTES, no caracteres, y se corta al leer (H-27): un cuerpo
  //    enorme no llega a cargarse entero en memoria.
  const leido = await leerCuerpoAcotado(request, MAX_BODY);
  if (leido === null) {
    return json({ ok: false, error: "payload_too_large" }, 413);
  }
  const raw: string = leido;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  /**
   * Cliente de servicio. Se crea aquí arriba porque los rechazos también hay
   * que guardarlos: un envío que se tira sin dejar rastro deja a la persona
   * mirando «0 envíos» y pensando que el Atajo no llega, cuando sí llegaba.
   */
  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  /**
   * Guarda el intento y responde diciendo qué llegó, no solo que está mal.
   *
   * Y si el token no vale, lo dice EN LUGAR del error del contenido. Al
   * revés —comprobando el importe primero— un token mal copiado respondía
   * «importe no válido», que manda a revisar el campo equivocado y no hay forma
   * de salir de ahí. La función de registro ya resuelve el token, así que su
   * respuesta sirve para distinguir los dos casos sin una consulta más.
   */
  async function rechazar(error: string, extra: Record<string, unknown> = {}) {
    const { data } = await supabase.rpc("record_ingest_rejection", {
      p_token: token,
      p_reason: error,
      p_payload: (parsedBody ?? { raw: raw.slice(0, 500) }) as never,
    });

    if (
      data &&
      typeof data === "object" &&
      "error" in data &&
      data.error === "unauthorized"
    ) {
      return json(
        {
          ok: false,
          error: "unauthorized",
          pista:
            "El token no vale: o está incompleto, o el dispositivo se revocó. Genera otro en Ajustes y cópialo entero, sin cortar el final.",
        },
        401,
      );
    }

    // Los rechazos cuentan para el mismo límite que los cargos (60 cada 10
    // minutos por dispositivo): pasado, la base ya no guarda nada y se dice.
    if (data && typeof data === "object" && "error" in data && data.error === "rate_limited") {
      return json({ ok: false, error: "rate_limited", retry_after: 600 }, 429, {
        "Retry-After": "600",
      });
    }

    return json({ ok: false, error, ...extra }, 422);
  }

  type Preparado = { cents: number; payload: { [clave: string]: Json } };

  /** El envío del atajo NFC de siempre: comercio, importe, tarjeta, fecha. */
  async function prepararAtajo(): Promise<NextResponse | Preparado> {
    const parsed = payloadSchema.safeParse(parsedBody);
    if (!parsed.success) {
      return rechazar("invalid_payload", {
        detalle: parsed.error.issues.map(
          (i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`,
        ),
      });
    }

    const { amount, currency, ...rest } = parsed.data;

    if (currency.toUpperCase() !== "EUR") {
      return rechazar("currency_not_supported", { recibido: currency });
    }

    // 3) El importe se normaliza aquí, con la función probada: entiende tanto el
    //    formato español como el anglosajón, y nunca pasa por coma flotante.
    //    Hacerlo en SQL con reemplazos de puntos leería «12.40» como 1.240 €.
    //    Un número JSON tampoco: negativo o con más de dos decimales se rechaza
    //    igual que en texto, en vez de quitarle el signo o redondearlo (H-06).
    const cents = typeof amount === "number" ? centimosDeNumero(amount) : parseAmountToCents(amount);

    if (cents === null || !Number.isSafeInteger(cents) || cents <= 0) {
      /*
        El error dice QUÉ llegó. Con solo «invalid_amount» hubo que rebuscar en la
        base de datos para descubrir que el Atajo mandaba el texto «[Importe]» en
        lugar de la variable; con el valor delante se ve al primer intento.
      */
      const texto = typeof amount === "string" ? amount : String(amount);
      const sinDigitos = !/\d/.test(texto);
      return rechazar("invalid_amount", {
        recibido: texto,
        pista: sinDigitos
          ? texto.trim() === ""
            ? "Llegó vacío. Si estás probando el atajo a mano, es normal: sin un pago real el disparador no tiene importe. Pruébalo pagando algo pequeño."
            : "Llegó texto sin números, así que el campo lleva el nombre de la variable escrito en lugar de la variable. Bórralo y elígela de la barra de sugerencias del teclado."
          : typeof amount === "number"
            ? "El importe tiene que ser mayor que cero y con dos decimales como mucho."
            : "El importe tiene que ser mayor que cero.",
      });
    }

    // 4) La fecha, si viene, tiene que ser ISO 8601 y existir (H-02): «ayer» o
    //    «19 oct 2026» hacían fallar el `::timestamptz` de la base y el pago se
    //    perdía con un 500. Ahora se rechaza con rastro y se ve en Ajustes.
    if (rest.occurred_at != null && rest.occurred_at.trim() !== "" && !esInstanteIso(rest.occurred_at)) {
      return rechazar("invalid_date", {
        recibido: rest.occurred_at,
        pista: "La fecha tiene que ir en formato ISO 8601 (2026-10-19T14:32:00+02:00), o no mandarse.",
      });
    }

    // 5) La tarjeta, a sus 4 últimas cifras o a nada (H-02): una que no encaja
    //    va a la cuenta por defecto en vez de reventar el CHECK de la base.
    const card = ultimosCuatro(rest.card);
    const merchant = rest.merchant?.trim() || null;
    const externalId =
      rest.external_id?.trim() || (await externalIdPorVentana(supabase, token, cents, merchant, card));

    const payload = {
      ...rest,
      currency,
      card,
      ...(rest.occurred_at?.trim() ? {} : { occurred_at: undefined }),
      ...(externalId ? { external_id: externalId } : {}),
    };
    return { cents, payload: sinIndefinidos(payload) };
  }

  /**
   * El aviso de Cartera (iOS 27): título, subtítulo, cuerpo y fecha tal cual.
   * Se lee en lib/aviso-cartera.ts; la base elige la cuenta por el nombre de
   * la tarjeta, convierte las recargas en traspasos y lo empareja con el
   * atajo NFC si es el mismo pago.
   */
  async function prepararAviso(): Promise<NextResponse | Preparado> {
    const aviso = avisoCarteraSchema.safeParse(parsedBody);
    if (!aviso.success) {
      return rechazar("invalid_payload", {
        detalle: aviso.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`),
      });
    }
    const leido = leerAvisoCartera(aviso.data);
    if (!leido.ok) return rechazar(leido.error, { recibido: aviso.data.importe, pista: leido.pista });
    return {
      cents: leido.cents,
      payload: sinIndefinidos({
        ...aviso.data,
        origin: "CARTERA",
        wallet_card: leido.tarjeta,
        merchant: leido.comercio,
        ...(leido.occurredAt ? { occurred_at: leido.occurredAt } : {}),
        external_id: idDeAviso(aviso.data, leido.cents),
      }),
    };
  }

  const preparado = esAvisoDeCartera(parsedBody) ? await prepararAviso() : await prepararAtajo();
  if (preparado instanceof NextResponse) return preparado;
  const { cents, payload } = preparado;

  const { data, error } = await supabase.rpc("ingest_transaction", {
    p_token: token,
    p_amount_cents: cents,
    p_payload: payload,
  });

  if (error) {
    /*
      H-02: nunca un 500 que pierda el pago. Lo que mandó el Atajo se guarda en
      los rechazos con el motivo, para verlo en Ajustes y poder recuperarlo.
      Si es un problema de los DATOS (no se arregla reintentando) responde 422
      como cualquier otro rechazo; si la base está caída o saturada, 500 para
      que el Atajo reintente (con el mismo external_id no se duplica).
    */
    console.error("ingest rpc error", error.message);
    if (esErrorDeDatos(error)) return rechazar("DB_ERROR");
    await supabase
      .rpc("record_ingest_rejection", { p_token: token, p_reason: "DB_ERROR", p_payload: payload as never })
      .then(
        () => undefined,
        () => undefined,
      );
    return json({ ok: false, error: "server_error" }, 500);
  }

  const result = data as {
    ok: boolean;
    error?: string;
    id?: string;
    duplicate?: boolean;
    status?: string;
    category?: string | null;
    user_id?: string;
    merchant?: string | null;
    account?: string | null;
    inherited?: boolean;
    merged?: boolean;
    kind?: string;
    to_account?: string | null;
    note?: string | null;
  };

  if (!result.ok) {
    if (result.error === "unauthorized") return json(result, 401);
    if (result.error === "rate_limited")
      return json(result, 429, { "Retry-After": "600" });
    return json(result, 422);
  }

  /*
    El aviso, en el momento del pago. Es la confirmación de que el Atajo ha
    funcionado, y hasta ahora solo se sabía abriendo la app.

    No se avisa de un duplicado: el atajo reintenta al agotarse el tiempo de
    espera, y dos avisos del mismo café harían dudar de si se cobró dos veces.

    Y NO se aplica la ventana de silencio, al contrario que en los avisos de la
    tarea programada. Aquí el aviso responde a algo que acabas de hacer: si
    pagas en un bar a las 23:30 estás despierto, y callarse justo cuando la
    gente gasta —de noche, fuera de casa— dejaría el aviso inútil precisamente
    cuando sirve.
  */
  if (!result.duplicate && result.user_id && configurarPush()) {
    const aviso = avisoDePago({ ...result, cents });

    /*
      `after` y no una promesa suelta.

      Un `void enviarAviso(...)` parecía correcto —no bloquea la respuesta— y no
      enviaba nada: en cuanto la función devuelve la respuesta, la plataforma la
      congela y el trabajo pendiente se descarta. El pago se registraba y el
      aviso no salía nunca, sin ningún error por ningún lado.

      `after` le dice a la plataforma que mantenga la invocación viva hasta
      terminar, sin retrasar la respuesta al atajo. Es la diferencia entre «no
      espero el resultado» y «que no lo ejecuten».

      El texto lo decide `avisoDePago` (lib/ingesta.ts): con categoría dice a
      cuál se ha asignado; sin ella, invita a entrar a ponérsela.
    */
    const userId = result.user_id;
    after(async () => {
      const r = await enviarAviso(supabase, userId, [aviso]).catch((e) => {
        console.error("aviso de ingesta fallido", (e as Error).message);
        return null;
      });
      // Una línea en los registros por pago: sin ella, «no me llegó el aviso»
      // no se distingue de «no había dispositivo» o «Apple lo rechazó».
      if (r) console.info("aviso de ingesta", JSON.stringify(r));
    });
  }

  // Un duplicado responde 200 a propósito. El atajo reintenta tras agotar el
  // tiempo de espera, y si le devolviéramos un error el usuario recibiría un
  // aviso de fallo por un cargo que sí se registró.
  return json(result, 200);
}

/** Para que el atajo pueda comprobar que el token sigue vivo sin crear nada. */
export async function GET() {
  return json({ ok: true, service: "cartera-ingest" }, 200);
}
