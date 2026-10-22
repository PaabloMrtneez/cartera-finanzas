/**
 * Invita a alguien a Cartera.
 *
 * El registro está cerrado a propósito, así que esta (o Ajustes → «Invitar a
 * alguien», o `enlace-directo.mjs`) es la única forma de crear una cuenta. La
 * persona abre el enlace y elige ella misma la contraseña: nadie más llega a
 * conocerla.
 *
 *   node --env-file=.env.local scripts/invitar.mjs <correo> [url-base]
 *
 * NO manda correo: genera el enlace de Cartera y lo deja en
 * `enlace-invitacion.txt` para que lo mandes tú por WhatsApp. Es lo fiable: el
 * correo integrado de Supabase tiene un cupo de pocos envíos por hora, cae en
 * spam, puede no entregar fuera del equipo, y su enlace lo gasta cualquier
 * vista previa o antivirus que lo abra antes que la persona.
 *
 * Antes había un modo `--correo` que dejaba a Supabase mandar su propio correo.
 * Se quitó en la fase 2 de seguridad: ese correo lleva la sesión en el
 * fragmento de la URL (flujo implícito), y /invitacion ya no acepta enlaces así
 * porque cualquiera con cuenta puede fabricar uno con la suya.
 */
import { BASE_POR_DEFECTO, generarEnlace, guardarEnlace } from "./enlace-invitacion.mjs";

const argumentos = process.argv.slice(2);
const [emailCrudo, baseCruda] = argumentos.filter((a) => !a.startsWith("--"));
const email = emailCrudo?.trim().toLowerCase();
const base = (baseCruda ?? BASE_POR_DEFECTO).replace(/\/$/, "");

if (!email || !email.includes("@")) {
  console.error("Uso: node --env-file=.env.local scripts/invitar.mjs <correo> [url-base]");
  process.exit(2);
}

const api = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!api || !secret) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

try {
  guardarEnlace("enlace-invitacion.txt", await generarEnlace({ api, secret, email, base }), email);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

