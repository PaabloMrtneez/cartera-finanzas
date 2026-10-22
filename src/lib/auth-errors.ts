/**
 * Supabase devuelve los errores en inglés y con detalle técnico. Aquí se
 * traducen a algo que una persona entienda, sin revelar de más: en el acceso no
 * se distingue «no existe ese correo» de «la contraseña no es esa», porque eso
 * permitiría averiguar quién tiene cuenta.
 */
export function authErrorMessage(error: { message?: string; code?: string } | null): string | null {
  if (!error) return null;
  const code = error.code ?? "";
  const message = error.message ?? "";

  if (code === "invalid_credentials" || /invalid login credentials/i.test(message)) {
    return "El correo o la contraseña no son correctos.";
  }
  if (code === "email_not_confirmed" || /email not confirmed/i.test(message)) {
    return "Esta cuenta todavía no ha confirmado su correo.";
  }
  if (code === "signup_disabled" || /signups not allowed/i.test(message)) {
    return "El registro está cerrado: esta app es privada.";
  }
  if (code === "over_request_rate_limit" || /rate limit/i.test(message)) {
    return "Demasiados intentos seguidos. Espera un minuto y vuelve a probar.";
  }
  if (code === "mfa_verification_failed" || /invalid totp code|invalid mfa/i.test(message)) {
    return "Ese código no es válido. Comprueba que sea el actual de tu app.";
  }
  if (/expired/i.test(message)) {
    return "El código ha caducado. Escribe el que muestre ahora tu app.";
  }
  if (/network|fetch/i.test(message)) {
    return "No se ha podido conectar. Revisa tu conexión.";
  }
  // Sin sesión (caducó, o se llegó aquí sin pasar por el acceso). Supabase lo
  // dice en inglés y con jerga: «This endpoint requires a valid Bearer token».
  if (
    code === "session_not_found" ||
    code === "no_authorization" ||
    /bearer token|session (missing|not found)|not authenticated|jwt/i.test(message)
  ) {
    return "Tu sesión ha caducado. Vuelve a entrar.";
  }
  // Lo que no se reconoce no se enseña en inglés: un mensaje genérico en
  // español, y el original a la consola para poder diagnosticarlo.
  if (message) console.error("Error de acceso no traducido:", code, message);
  return "Ha ocurrido un error inesperado. Vuelve a intentarlo.";
}
