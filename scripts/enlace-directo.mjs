/**
 * Genera un enlace de acceso SIN mandar correo.
 *
 * Para cuando el enlace del correo llega ya gastado (hay clientes de correo y
 * antivirus que abren los enlaces para inspeccionarlos, y como son de un solo
 * uso, los consumen antes de que llegues tú), o para invitar a alguien sin
 * depender del correo de Supabase.
 *
 *   node --env-file=.env.local scripts/enlace-directo.mjs <correo> [url-base]
 *
 * Si la persona no tiene cuenta, se le crea (invitación); si la tiene, el enlace
 * sirve para elegir contraseña nueva. En los dos casos va a /invitacion con el
 * token SIN canjear, así que la vista previa de WhatsApp no lo gasta.
 *
 * El enlace se escribe en un fichero, no en pantalla: es una credencial de un
 * solo uso y no conviene que quede en el historial de la terminal.
 */
import { BASE_POR_DEFECTO, generarEnlace, guardarEnlace } from "./enlace-invitacion.mjs";

const email = process.argv[2]?.trim().toLowerCase();
const base = (process.argv[3] ?? BASE_POR_DEFECTO).replace(/\/$/, "");

if (!email || !email.includes("@")) {
  console.error("Uso: node --env-file=.env.local scripts/enlace-directo.mjs <correo> [url-base]");
  process.exit(2);
}

const api = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!api || !secret) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

try {
  guardarEnlace("enlace-acceso.txt", await generarEnlace({ api, secret, email, base }), email);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
