/**
 * El segundo factor: qué se le ofrece a cada persona y cómo se leen los fallos.
 *
 * Es OPCIONAL: sin factor se entra con la contraseña; con factor, solo tras
 * superarlo (aal2). Hay dos tipos: el código de 6 dígitos (TOTP), que es el que
 * se ofrece, y la llave de acceso (WebAuthn: Face ID, Touch ID, la huella), que
 * solo aparece si el proyecto de Supabase la tiene activada (hoy no).
 *
 * Los dos llevan la sesión a `aal2`, y la base de datos no distingue con cuál
 * se llegó (`private.segundo_factor_cumplido()` mira `aal`, no `amr`).
 *
 * Aquí solo hay lógica pura, para poder probarla sin navegador ni Supabase.
 */

/** Lo que devuelve `mfa.listFactors()` de cada factor, en lo que importa. */
export type FactorResumen = {
  id: string;
  factor_type: string;
  status: string;
  friendly_name?: string | null;
  created_at?: string | null;
};

/** Qué pantalla de verificación toca. */
export type PlanVerificacion =
  /** Hay llave y el navegador puede usarla: botón principal «Entrar con Face ID». */
  | { modo: "llave"; llaves: FactorResumen[]; totp: FactorResumen | null }
  /** Solo código, o hay llave pero este navegador no la puede usar. */
  | { modo: "codigo"; totp: FactorResumen; llaveSinSoporte: boolean }
  /** Solo hay llave y este navegador no puede usarla: no hay manera de seguir aquí. */
  | { modo: "sin-soporte" }
  /** Ningún factor verificado. */
  | { modo: "ninguno" };

function porFechaDesc(a: FactorResumen, b: FactorResumen) {
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

/**
 * Decide qué se ofrece al entrar.
 *
 * Con varias llaves (el iPhone y un Android, por ejemplo), va primero la que se
 * dio de alta en un dispositivo como este —se reconoce por el nombre, que lo
 * lleva— y, a igualdad, la más reciente. Cada llave vive en UN dispositivo (o en
 * un llavero sincronizado): pedir la de otro acaba en un «no hay ninguna».
 */
export function planDeVerificacion(
  factores: readonly FactorResumen[],
  soportaLlave: boolean,
  dispositivo: string | null = null,
): PlanVerificacion {
  const verificados = factores.filter((f) => f.status === "verified");
  const totp = verificados.filter((f) => f.factor_type === "totp").sort(porFechaDesc)[0] ?? null;
  const llaves = verificados
    .filter((f) => f.factor_type === "webauthn")
    .sort((a, b) => {
      if (dispositivo) {
        const enA = (a.friendly_name ?? "").includes(dispositivo) ? 0 : 1;
        const enB = (b.friendly_name ?? "").includes(dispositivo) ? 0 : 1;
        if (enA !== enB) return enA - enB;
      }
      return porFechaDesc(a, b);
    });

  if (llaves.length > 0 && soportaLlave) return { modo: "llave", llaves, totp };
  if (totp) return { modo: "codigo", totp, llaveSinSoporte: llaves.length > 0 };
  if (llaves.length > 0) return { modo: "sin-soporte" };
  return { modo: "ninguno" };
}

/** Por qué ha fallado la llave, en categorías con las que se puede hacer algo. */
export type MotivoFalloLlave =
  /** WebAuthn no está activado en el proyecto de Supabase: toca el código. */
  | "no-habilitado"
  /** La persona cerró el aviso de Face ID, o se agotó el tiempo. */
  | "cancelado"
  /** El navegador no puede. */
  | "sin-soporte"
  /** Este dispositivo ya tenía una llave de esta cuenta. */
  | "ya-registrada"
  /** El dominio no cuadra (una vista previa de Vercel, por ejemplo). */
  | "dominio"
  | "otro";

type ErrorConCodigo = {
  code?: string;
  name?: string;
  message?: string;
  cause?: unknown;
};

/**
 * Clasifica un error de `mfa.webauthn.*` o de `mfa.enroll`.
 *
 * Los errores llegan de dos sitios: de Supabase (con `code` como
 * `mfa_webauthn_enroll_not_enabled`) y del navegador, envueltos por auth-js en
 * un `WebAuthnError` cuyo `cause` es la excepción original (`NotAllowedError`
 * cuando se cancela el aviso del sistema).
 */
export function motivoFalloLlave(error: unknown): MotivoFalloLlave {
  if (!error || typeof error !== "object") return "otro";
  const e = error as ErrorConCodigo;
  const causa = (e.cause && typeof e.cause === "object" ? e.cause : {}) as ErrorConCodigo;
  const code = e.code ?? "";
  const texto = `${e.message ?? ""} ${causa.message ?? ""}`;

  if (code === "mfa_webauthn_enroll_not_enabled" || code === "mfa_webauthn_verify_not_enabled") {
    return "no-habilitado";
  }
  // Servidores más viejos no conocen el tipo y lo rechazan como dato no válido.
  if (/webauthn/i.test(texto) && /(not enabled|disabled|not supported|invalid factor)/i.test(texto)) {
    return "no-habilitado";
  }
  if (code === "validation_failed" && /factor.?type/i.test(texto)) return "no-habilitado";

  if (
    code === "ERROR_CEREMONY_ABORTED" ||
    e.name === "NotAllowedError" ||
    e.name === "AbortError" ||
    causa.name === "NotAllowedError" ||
    causa.name === "AbortError"
  ) {
    return "cancelado";
  }
  if (/does not support webauthn/i.test(texto)) return "sin-soporte";
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || causa.name === "InvalidStateError") {
    return "ya-registrada";
  }
  if (code === "ERROR_INVALID_DOMAIN" || code === "ERROR_INVALID_RP_ID" || causa.name === "SecurityError") {
    return "dominio";
  }
  return "otro";
}

/** El texto para la persona según el motivo, con el nombre de su biometría. */
export function mensajeFalloLlave(motivo: MotivoFalloLlave, biometria: string): string {
  switch (motivo) {
    case "no-habilitado":
      return `${biometria} todavía no está activado en Cartera. De momento, usa el código de 6 dígitos.`;
    case "cancelado":
      return `Se ha cancelado ${biometria}. Vuelve a pulsar el botón cuando quieras.`;
    case "sin-soporte":
      return `Este navegador no puede usar ${biometria}. Usa el código de 6 dígitos.`;
    case "ya-registrada":
      return "Este dispositivo ya tiene una llave de tu cuenta: no hace falta añadirla otra vez.";
    case "dominio":
      return `${biometria} solo funciona en la dirección principal de Cartera, no en esta.`;
    default:
      return `No se ha podido usar ${biometria}. Vuelve a intentarlo o usa el código de 6 dígitos.`;
  }
}

/**
 * El dispositivo, por su user agent. Sirve para dos cosas: poner nombre a la
 * llave («iPhone · 19/10/2026») y llamar a la biometría por su nombre.
 *
 * El iPad moderno se hace pasar por un Mac; lo delata la pantalla táctil.
 */
export function dispositivoDe(userAgent: string, puntosTactiles = 0): string {
  if (/iPhone|iPod/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && puntosTactiles > 1)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux|CrOS/.test(userAgent)) return "Linux";
  return "Este dispositivo";
}

/** Cómo se llama lo que pide el sistema al usar la llave en ese dispositivo. */
export function biometriaDe(dispositivo: string): string {
  switch (dispositivo) {
    case "iPhone":
    case "iPad":
      return "Face ID";
    case "Mac":
      return "Touch ID";
    case "Android":
      return "la huella";
    case "Windows":
      return "Windows Hello";
    default:
      return "Face ID / huella";
  }
}

/**
 * El nombre de la llave en Supabase. Lleva el dispositivo (para ordenarlas al
 * entrar) y la fecha con hora: Supabase rechaza dos factores con el mismo
 * nombre, y añadir dos en un día no es raro.
 */
export function nombreDeLlave(dispositivo: string, fecha: Date): string {
  const cuando = fecha.toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${dispositivo} · ${cuando}`;
}

/**
 * Opciones para el navegador al CREAR la llave.
 *
 * auth-js trae por defecto las de una llave USB (`cross-platform`, pista
 * `security-key`, atestación directa): en un iPhone eso abre el diálogo de
 * «usa tu llave de seguridad» en lugar de Face ID. Aquí se pide el autenticador
 * del propio dispositivo, con verificación de la persona (cara o huella), y sin
 * atestación, que no aporta nada y en Chrome añade un aviso de más.
 */
export const OPCIONES_CREAR_LLAVE = {
  hints: ["client-device"],
  attestation: "none",
  authenticatorSelection: {
    authenticatorAttachment: "platform",
    residentKey: "preferred",
    requireResidentKey: false,
    userVerification: "required",
  },
} as const;

/**
 * Opciones al USAR la llave. La pista `hybrid` deja que, desde un ordenador sin
 * lector, se pueda usar la del móvil escaneando un QR.
 */
export const OPCIONES_PEDIR_LLAVE = {
  hints: ["client-device", "hybrid"],
  userVerification: "required",
} as const;
