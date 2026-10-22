"use server";

import { getBaseUrl } from "@/lib/base-url";
import {
  construirEnlaceInvitacion,
  esAdministrador,
  horasDeCaducidad,
  yaTieneCuenta,
  type TipoEnlace,
} from "@/lib/invitacion";
import { firstIssue, invitarSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ResultadoInvitacion =
  | { ok: true; enlace: string; tipo: TipoEnlace; horas: number; email: string }
  | { ok: false; error: string };

const SIN_PERMISO = "No tienes permiso para invitar.";

/**
 * Genera un enlace de invitación SIN mandar ningún correo: quien invita lo
 * comparte él mismo (por WhatsApp, normalmente).
 *
 * Por qué así:
 *   · El correo integrado de Supabase tiene un cupo de pocos envíos por hora,
 *     cae en spam y puede no entregar fuera del equipo.
 *   · El enlace de su correo se canjea con un simple GET, y la vista previa de
 *     WhatsApp o el antivirus lo gastan antes de que llegue la persona. El que
 *     se construye aquí apunta a /invitacion, que no canjea nada hasta que se
 *     pulsa «Empezar» (ver `lib/invitacion.ts`).
 *
 * Usa la clave de servicio, así que la puerta es estricta:
 *   1. Sesión validada con `getUser()` (contra el servidor de autenticación;
 *      nunca la cookie decodificada a mano).
 *   2. Esa sesión ha superado el segundo factor (aal2).
 *   3. Su id está en `CARTERA_ADMIN_IDS`, una variable del SERVIDOR.
 * Sin las tres, no se toca el cliente de administración.
 */
export async function generarInvitacion(email: unknown): Promise<ResultadoInvitacion> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Tu sesión ha caducado. Vuelve a entrar." };

  // El token ya lo ha validado getUser(); de él se lee el nivel alcanzado.
  const { data: nivel } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (nivel?.currentLevel !== "aal2") return { ok: false, error: SIN_PERMISO };
  if (!esAdministrador(user.id, process.env.CARTERA_ADMIN_IDS)) {
    return { ok: false, error: SIN_PERMISO };
  }

  const datos = invitarSchema.safeParse({ email });
  if (!datos.success) return { ok: false, error: firstIssue(datos.error) };
  const correo = datos.data.email;

  const origen = await getBaseUrl();
  const redirectTo = `${origen}/invitacion`;

  try {
    const admin = createAdminClient();

    // Primero, invitar: crea la cuenta (sin correo de por medio).
    let tipo: TipoEnlace = "invite";
    let { data, error } = await admin.auth.admin.generateLink({
      type: "invite",
      email: correo,
      options: { redirectTo },
    });

    // Si ya tenía cuenta (se le invitó antes, o la está recuperando), un enlace
    // de recuperación: aterriza en la misma página y sirve igual para elegir
    // contraseña.
    //
    // DECISIÓN CONSCIENTE (fase 2 de seguridad, 2026-10-20): esto deja a un
    // administrador poner contraseña nueva a CUALQUIER cuenta. Si la cuenta
    // tiene segundo factor, el enlace no basta (/invitacion lo pide antes de la
    // contraseña); si no lo tiene, sí. Se acepta: es la única forma de
    // recuperar una cuenta, porque no hay «olvidé mi contraseña» por correo.
    if (error && yaTieneCuenta(error)) {
      tipo = "recovery";
      ({ data, error } = await admin.auth.admin.generateLink({
        type: "recovery",
        email: correo,
        options: { redirectTo },
      }));
    }

    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) {
      // El detalle a los registros del servidor (sin el enlace, que es una
      // credencial); a la pantalla, algo que se entienda.
      console.error("generarInvitacion:", error?.code ?? error?.status ?? "sin token");
      return { ok: false, error: "Supabase no ha podido generar el enlace. Inténtalo en un rato." };
    }

    return {
      ok: true,
      enlace: construirEnlaceInvitacion(origen, tokenHash, tipo),
      tipo,
      horas: horasDeCaducidad(process.env.CARTERA_ENLACE_CADUCA_HORAS),
      email: correo,
    };
  } catch {
    return { ok: false, error: "No se ha podido generar el enlace. Inténtalo de nuevo." };
  }
}
