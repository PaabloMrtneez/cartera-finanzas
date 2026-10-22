import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";
import { ZONA_HORARIA } from "./dates";
import type { Database } from "./supabase/database.types";

/**
 * Envío de avisos push, en un solo sitio.
 *
 * Estaba metido dentro de la tarea programada, que era el único que enviaba.
 * Ahora también avisa la ingesta del Atajo en el momento del pago, y dos copias
 * de esta lógica acabarían tratando distinto un dispositivo caducado.
 */

export type Aviso = {
  title: string;
  body: string;
  url: string;
  /** Agrupa avisos: uno nuevo con el mismo `tag` sustituye al anterior. */
  tag: string;
};

/** Hora actual en Madrid, sin depender de la zona del servidor. */
export function horaMadrid(): number {
  const texto = new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    hour12: false,
    timeZone: ZONA_HORARIA,
  }).format(new Date());
  return Number(texto);
}

export const INICIO_SILENCIO = 23;
export const FIN_SILENCIO = 8;

/**
 * La ventana de silencio, para lo que NO ha pedido nadie.
 *
 * Se aplica a los avisos que salen por su cuenta: un límite que se acerca, el
 * resumen del mes. Un aviso a las tres de la mañana por algo que puede esperar
 * hasta el desayuno solo enseña a apagar las notificaciones.
 *
 * NO se aplica a la confirmación de un pago. Ahí el aviso es la respuesta a algo
 * que acabas de hacer: si pagas en un bar a las 23:30 estás despierto, y
 * callarse justo cuando la gente gasta —de noche, fuera de casa— dejaría el
 * aviso inútil precisamente cuando sirve.
 */
export function enSilencio(hora = horaMadrid()): boolean {
  return hora >= INICIO_SILENCIO || hora < FIN_SILENCIO;
}

/**
 * El `sub` de VAPID: a quién contacta el servicio push si hay problemas.
 *
 * RFC 8292 exige un `mailto:` o un `https:` REALES. El antiguo valor por
 * defecto, `mailto:avisos@cartera.local`, apunta a un dominio inexistente y no
 * es entregable; algunos servicios (Apple, FCM) rechazan los envíos con un `sub`
 * así. Por eso: se usa `VAPID_SUBJECT` si trae un contacto válido; si no, se
 * deriva del dominio de producción un `https:` —que sí es real y alcanzable—;
 * y si tampoco hay dominio (local), no se inventa nada.
 */
function sujetoVapid(): string | null {
  const configurado = process.env.VAPID_SUBJECT?.trim();
  if (configurado && /^(mailto:[^@\s]+@[^@\s]+\.[^@\s]+|https:\/\/\S+)$/.test(configurado)) {
    return configurado;
  }

  const dominio = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (dominio) return `https://${dominio}`;

  return null;
}

/** Configura VAPID. Devuelve false si faltan las claves o un sujeto entregable. */
export function configurarPush(): boolean {
  const publica = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privada = process.env.VAPID_PRIVATE_KEY;
  if (!publica || !privada) return false;

  const sujeto = sujetoVapid();
  if (!sujeto) return false;

  webpush.setVapidDetails(sujeto, publica, privada);
  return true;
}

/**
 * Manda un aviso a todos los dispositivos de una persona.
 *
 * Nunca lanza: un push que falla no puede tumbar lo que lo provocó. Si la
 * ingesta de un pago se cayera porque el aviso no salió, se perdería el gasto
 * por no haber podido avisar de él, que es el peor intercambio posible.
 */
export async function enviarAviso(
  supabase: SupabaseClient<Database>,
  userId: string,
  avisos: Aviso[],
): Promise<{ enviados: number; caducados: number; fallidos: number; destinos: number }> {
  let enviados = 0;
  let caducados = 0;
  let fallidos = 0;

  const { data: destinos, error: errorDestinos } = await supabase
    .from("push_subscription")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId)
    .is("failed_at", null);

  if (errorDestinos) {
    console.error("push: no se han podido leer los destinos", errorDestinos.message);
    // Sin destinos que leer, nada ha salido: cuenta como fallo, no como «nadie».
    return { enviados: 0, caducados: 0, fallidos: avisos.length, destinos: 0 };
  }

  for (const destino of destinos ?? []) {
    for (const aviso of avisos) {
      try {
        await webpush.sendNotification(
          { endpoint: destino.endpoint, keys: { p256dh: destino.p256dh, auth: destino.auth } },
          JSON.stringify(aviso),
          // Un servicio push colgado no puede comerse los 60 s de la función y
          // dejar sin enviar todo lo demás (H-14).
          { timeout: TIEMPO_PUSH_MS },
        );
        enviados++;
      } catch (error) {
        const codigo = (error as { statusCode?: number }).statusCode;
        // 404 y 410 significan que ese dispositivo ya no existe. Se marca en
        // lugar de borrarlo, para que en Ajustes se vea que dejó de recibir.
        if (codigo === 404 || codigo === 410) {
          await supabase
            .from("push_subscription")
            .update({ failed_at: new Date().toISOString() })
            .eq("id", destino.id);
          caducados++;
        } else {
          fallidos++;
          console.error("push fallido", codigo, (error as Error).message);
        }
        break;
      }
    }

    await supabase
      .from("push_subscription")
      .update({ last_sent_at: new Date().toISOString() })
      .eq("id", destino.id);
  }

  return { enviados, caducados, fallidos, destinos: destinos?.length ?? 0 };
}

/** Lo más que se espera a un servicio push antes de darlo por fallido. */
export const TIEMPO_PUSH_MS = 10_000;
