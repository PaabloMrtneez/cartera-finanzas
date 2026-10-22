import type { createClient } from "@/lib/supabase/client";
import {
  OPCIONES_CREAR_LLAVE,
  OPCIONES_PEDIR_LLAVE,
  dispositivoDe,
  motivoFalloLlave,
  nombreDeLlave,
  type MotivoFalloLlave,
} from "@/lib/segundo-factor";

/**
 * La llave de acceso (WebAuthn) en el navegador: comprobar si se puede, crearla
 * y usarla. Solo para componentes de cliente: todo esto toca `window`.
 *
 * La API de Supabase para WebAuthn es experimental (auth-js 2.112). Por eso el
 * alta NO usa su atajo `register()`: si falla el alta, ese atajo borra un factor
 * VERIFICADO con el mismo nombre, y si se cancela el aviso de Face ID deja uno
 * sin verificar colgando. Aquí se hace paso a paso —alta, reto, verificación— y
 * lo que se queda a medias se limpia.
 */

type Cliente = ReturnType<typeof createClient>;

export type ResultadoLlave = { ok: true } | { ok: false; motivo: MotivoFalloLlave; error: unknown };

/** ¿Existe la API? Basta para USAR una llave (también la del móvil, por QR). */
export function hayApiDeLlaves(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials?.create === "function"
  );
}

/**
 * ¿Tiene este dispositivo un lector propio (Face ID, Touch ID, huella, Windows
 * Hello)? Es lo que hace falta para CREAR la llave aquí.
 */
export async function hayLectorEnElDispositivo(): Promise<boolean> {
  if (!hayApiDeLlaves()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

const SONDA = "cartera-llaves-en-supabase";

/**
 * ¿Se puede usar Face ID aquí, de verdad? Hacen falta DOS cosas: un lector en
 * el dispositivo, y que el proyecto de Supabase tenga WebAuthn activado (hoy
 * no lo tiene: es un complemento aparte). Lo segundo no se puede preguntar, así
 * que se sondea: se da de alta una llave sin verificar y se borra al momento.
 * Si Supabase responde que no está activado, la opción de Face ID no aparece;
 * el día que lo esté, aparecerá sola.
 *
 * El resultado se guarda para la sesión del navegador, para no repetir la
 * sonda en cada visita a Ajustes.
 */
export async function llavesDisponibles(supabase: Cliente): Promise<boolean> {
  if (!(await hayLectorEnElDispositivo())) return false;
  try {
    const guardado = sessionStorage.getItem(SONDA);
    if (guardado !== null) return guardado === "1";
  } catch {
    // Sin sessionStorage (modo privado estricto): se sondea igual.
  }

  let disponible = false;
  try {
    const { data, error } = await supabase.auth.mfa.webauthn.enroll({
      friendlyName: `sonda-${Date.now()}`,
    });
    if (data) {
      disponible = true;
      await supabase.auth.mfa.unenroll({ factorId: data.id }).catch(() => undefined);
    } else if (motivoFalloLlave(error) !== "no-habilitado") {
      // Otro fallo (red, sesión): no se sabe. No se guarda, y no se ofrece.
      return false;
    }
  } catch {
    return false;
  }

  try {
    sessionStorage.setItem(SONDA, disponible ? "1" : "0");
  } catch {
    // Sin dónde guardarlo, se volverá a sondear.
  }
  return disponible;
}

/** «iPhone», «Android», «Mac»… del dispositivo actual. */
export function dispositivoActual(): string {
  if (typeof navigator === "undefined") return "Este dispositivo";
  return dispositivoDe(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

function sitio() {
  return { rpId: window.location.hostname, rpOrigins: [window.location.origin] };
}

function fallo(error: unknown): ResultadoLlave {
  return { ok: false, motivo: motivoFalloLlave(error), error };
}

/**
 * Da de alta una llave en este dispositivo y la verifica. Al terminar bien, la
 * sesión ya es aal2.
 *
 * `cuenta` es el correo: es lo que el llavero enseña como nombre de la llave.
 * Sin él, auth-js pondría «<uuid>:<nombre del factor>», que en la app
 * Contraseñas del iPhone no dice nada a nadie.
 */
export async function crearLlave(supabase: Cliente, cuenta?: string | null): Promise<ResultadoLlave> {
  const { data: alta, error: errorAlta } = await supabase.auth.mfa.webauthn.enroll({
    friendlyName: nombreDeLlave(dispositivoActual(), new Date()),
  });
  if (!alta) return fallo(errorAlta);

  const deshacer = async () => {
    // Si no se llega a verificar, se borra: un factor sin verificar no sirve
    // para nada y, si se acumulan, Supabase acaba rechazando altas nuevas.
    await supabase.auth.mfa.unenroll({ factorId: alta.id }).catch(() => undefined);
  };

  try {
    const { rpId, rpOrigins } = sitio();
    const crear = {
      ...OPCIONES_CREAR_LLAVE,
      ...(cuenta ? { user: { name: cuenta, displayName: cuenta } } : {}),
    };
    const { data: reto, error: errorReto } = await supabase.auth.mfa.webauthn.challenge(
      { factorId: alta.id, friendlyName: alta.friendly_name, webauthn: { rpId, rpOrigins } },
      // Los tipos de auth-js exigen el objeto completo; aquí solo se pisan
      // algunas claves, y auth-js las mezcla con las del servidor.
      { create: crear as never },
    );
    if (!reto) {
      await deshacer();
      return fallo(errorReto);
    }
    if (reto.webauthn.type !== "create") {
      await deshacer();
      return fallo(new Error("Respuesta inesperada al crear la llave"));
    }

    const { error: errorVerificar } = await supabase.auth.mfa.webauthn.verify({
      factorId: alta.id,
      challengeId: reto.challengeId,
      // El tipo de auth-js no estrecha la respuesta por `type`; ya se ha
      // comprobado arriba que es de creación.
      webauthn: {
        rpId,
        rpOrigins,
        type: "create",
        credential_response: reto.webauthn.credential_response as never,
      },
    });
    if (errorVerificar) {
      await deshacer();
      return fallo(errorVerificar);
    }
    return { ok: true };
  } catch (error) {
    await deshacer();
    return fallo(error);
  }
}

/** Supera el segundo factor con una llave ya dada de alta. */
export async function usarLlave(supabase: Cliente, factorId: string): Promise<ResultadoLlave> {
  try {
    const { rpId, rpOrigins } = sitio();
    const { error } = await supabase.auth.mfa.webauthn.authenticate(
      { factorId, webauthn: { rpId, rpOrigins } },
      OPCIONES_PEDIR_LLAVE as never,
    );
    return error ? fallo(error) : { ok: true };
  } catch (error) {
    return fallo(error);
  }
}

/**
 * Borra los factores sin verificar de intentos anteriores. Sin esto, Supabase
 * puede rechazar un alta nueva por nombre o por número de factores.
 */
export async function limpiarFactoresSinVerificar(supabase: Cliente): Promise<void> {
  const { data } = await supabase.auth.mfa.listFactors();
  for (const factor of data?.all ?? []) {
    if (factor.status !== "verified") {
      await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => undefined);
    }
  }
}
