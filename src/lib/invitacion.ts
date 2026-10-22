/**
 * Las invitaciones a Cartera: quién puede crearlas y cómo es el enlace.
 *
 * Todo lo de aquí es lógica pura, sin Supabase ni Next, para poder probarlo. La
 * acción que de verdad genera el enlace (con la clave de servicio) vive en
 * `src/app/(app)/ajustes/invitar-actions.ts`, y solo corre en el servidor.
 *
 * POR QUÉ UN ENLACE PROPIO Y NO EL DE SUPABASE
 *
 * El `action_link` que devuelve Supabase canjea el token en cuanto alguien lo
 * abre con un GET. Y lo abre mucha gente que no es la persona invitada: la vista
 * previa de WhatsApp, el antivirus del correo, el escáner de enlaces del móvil…
 * Cuando llega la persona de verdad, el enlace ya está gastado.
 *
 * El enlace que se construye aquí lleva solo el `token_hash` hacia NUESTRA
 * página, `/invitacion`, que no canjea nada al cargar: enseña la bienvenida y
 * espera a que se pulse «Empezar». Un GET de una vista previa no gasta nada.
 */

/** Los dos tipos de enlace que se generan: alta nueva o volver a poner contraseña. */
export type TipoEnlace = "invite" | "recovery";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Los administradores, leídos de `CARTERA_ADMIN_IDS` (uuids separados por
 * comas). Lo que no parezca un uuid se descarta en silencio: mejor un
 * administrador menos que dar permisos por un valor mal escrito.
 */
export function idsDeAdministrador(valor: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const trozo of (valor ?? "").split(",")) {
    const id = trozo.trim().toLowerCase();
    if (UUID.test(id)) ids.add(id);
  }
  return ids;
}

/**
 * ¿Puede invitar? El id tiene que venir de `getUser()` —validado por el
 * servidor de autenticación—, nunca de la cookie decodificada a mano.
 */
export function esAdministrador(
  userId: string | null | undefined,
  valor: string | null | undefined,
): boolean {
  if (!userId) return false;
  return idsDeAdministrador(valor).has(userId.toLowerCase());
}

/** El enlace que se comparte: a nuestra página, con el token sin canjear. */
export function construirEnlaceInvitacion(
  origen: string,
  tokenHash: string,
  tipo: TipoEnlace,
): string {
  const url = new URL("/invitacion", origen);
  url.searchParams.set("token_hash", tokenHash);
  url.searchParams.set("type", tipo);
  return url.toString();
}

/**
 * Cuánto dura el enlace, para avisar a quien lo comparte.
 *
 * La caducidad de verdad la decide Supabase («Email OTP Expiration» en el
 * panel: 1 hora por defecto, 24 como máximo). La app no puede leerla, así que
 * `CARTERA_ENLACE_CADUCA_HORAS` tiene que decir lo mismo que el panel. Sin
 * valor, o con uno que no cuadra, se asume lo de fábrica: 1 hora.
 */
export function horasDeCaducidad(valor: string | null | undefined): number {
  const horas = Number.parseInt(valor ?? "", 10);
  if (!Number.isInteger(horas) || horas < 1 || horas > 24) return 1;
  return horas;
}

export function textoCaducidad(horas: number): string {
  return horas === 1 ? "1 hora" : `${horas} horas`;
}

/** El mensaje que acompaña al enlace al compartirlo por WhatsApp. */
export function mensajeInvitacion(tipo: TipoEnlace): string {
  return tipo === "invite"
    ? "Te invito a Cartera. Abre este enlace en tu móvil y sigue los pasos (son dos minutos):"
    : "Aquí tienes un enlace para volver a entrar en Cartera y elegir una contraseña nueva:";
}

/**
 * ¿El error de Supabase dice que esa persona ya tiene cuenta? Entonces no se la
 * puede invitar otra vez, y lo que toca es un enlace de recuperación, que
 * aterriza en la misma página y sirve igual para elegir contraseña.
 */
export function yaTieneCuenta(error: { code?: string; message?: string; status?: number } | null) {
  if (!error) return false;
  if (error.code === "email_exists" || error.code === "user_already_exists") return true;
  return /already (been )?registered|already exists/i.test(error.message ?? "");
}

/**
 * El detalle de por qué un enlace no vale, a partir del `error_code` que
 * Supabase deja en la URL al redirigir. Solo textos FIJOS: el
 * `error_description` de la URL no se enseña nunca, porque cualquiera puede
 * escribir ahí lo que quiera y saldría en nuestra página como si lo dijera
 * Cartera («Detalle: tu cuenta está bloqueada, entra en…»). Un código que no
 * se conoce no da detalle: el mensaje general ya dice qué hacer.
 */
export function detalleDeEnlace(codigo: string | null | undefined): string | null {
  switch (codigo) {
    case "otp_expired":
      return "El enlace ha caducado o ya se usó.";
    case "flow_state_expired":
    case "flow_state_not_found":
    case "bad_code_verifier":
      return "El enlace se abrió en otro navegador o ya no es válido.";
    case "user_banned":
      return "Esta cuenta está desactivada.";
    default:
      return null;
  }
}
