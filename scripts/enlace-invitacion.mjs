/**
 * Lo común a `invitar.mjs` y `enlace-directo.mjs`: generar el enlace de
 * invitación de Cartera SIN mandar correo y guardarlo en un fichero.
 *
 * Es lo mismo que hace Ajustes → «Invitar a alguien» (ver
 * `src/lib/invitacion.ts` y `src/app/(app)/ajustes/invitar-actions.ts`): se
 * pide a Supabase el token con `admin/generate_link` y se construye un enlace a
 * NUESTRA página, `/invitacion?token_hash=…&type=…`. No el `action_link` de
 * Supabase, que se canjea con un simple GET y lo gastan la vista previa de
 * WhatsApp o el antivirus del correo antes de que llegue la persona.
 *
 * El enlace es una credencial de un solo uso: se escribe en un fichero
 * (ignorado por git: `enlace-*.txt`), nunca en la pantalla.
 */
import { writeFileSync } from "node:fs";

export const BASE_POR_DEFECTO = "https://tu-dominio.vercel.app";

function yaTieneCuenta(status, body) {
  if (status !== 422 && status !== 400) return false;
  return /email_exists|user_already_exists|already (been )?registered|already exists/i.test(
    JSON.stringify(body),
  );
}

/**
 * Pide el token a Supabase. Primero como invitación (crea la cuenta); si la
 * persona ya existe, como recuperación (aterriza en la misma página y sirve
 * igual para elegir contraseña).
 */
export async function generarEnlace({ api, secret, email, base }) {
  const cabeceras = {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
  const pedir = (type) =>
    fetch(`${api}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: cabeceras,
      body: JSON.stringify({ type, email, options: { redirect_to: `${base}/invitacion` } }),
    });

  let tipo = "invite";
  let response = await pedir(tipo);
  let body = await response.json().catch(() => ({}));

  if (!response.ok && yaTieneCuenta(response.status, body)) {
    tipo = "recovery";
    response = await pedir(tipo);
    body = await response.json().catch(() => ({}));
  }

  if (!response.ok) {
    // El cuerpo de un error no lleva el token; se enseña recortado para
    // diagnosticar.
    throw new Error(`Supabase respondió ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }

  const tokenHash = body.properties?.hashed_token ?? body.hashed_token;
  if (!tokenHash) throw new Error("La respuesta de Supabase no traía el token.");

  const url = new URL("/invitacion", base);
  url.searchParams.set("token_hash", tokenHash);
  url.searchParams.set("type", tipo);
  return { enlace: url.toString(), tipo, id: body.id ?? body.user?.id ?? null };
}

/** Guarda el enlace en un fichero y lo cuenta sin enseñarlo. */
export function guardarEnlace(fichero, { enlace, tipo, id }, email) {
  writeFileSync(fichero, `${enlace}\n`, "utf8");
  console.log(`Enlace generado para ${email} (${tipo === "invite" ? "cuenta nueva" : "ya tenía cuenta: recuperación"})`);
  if (id) console.log(`  id de usuario: ${id}`);
  console.log(`  escrito en:    ${fichero}`);
  console.log("");
  console.log("Mándaselo tú (WhatsApp, por ejemplo). Abrirlo para ver la vista previa no lo gasta:");
  console.log("se gasta cuando la persona pulsa «Empezar». Caduca según «Email OTP Expiration»");
  console.log("del panel de Supabase (1 hora si no se ha cambiado) y solo vale una vez.");
  console.log("Borra el fichero cuando lo hayas mandado.");
}
