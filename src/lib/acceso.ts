/**
 * Adónde va cada petición según la sesión que trae. Es la decisión del proxy
 * (`src/proxy.ts`), separada aquí para poder probarla sin levantar Next ni
 * Supabase.
 *
 * Esto es comodidad, no seguridad: quien de verdad impide ver o tocar datos sin
 * segundo factor son las políticas de la base de datos, que no devuelven ni una
 * fila a quien tiene un factor verificado y no lo ha superado (aal2). Aquí solo
 * se evita que alguien se quede mirando pantallas vacías, o a medio funcionar,
 * sin entender por qué.
 */

/**
 * Lo único que se abre SIN sesión: la pantalla de acceso y la de aceptar una
 * invitación (quien llega del correo todavía no tiene la sesión en cookies:
 * la establece esa misma página).
 *
 * El segundo factor NO está aquí. `/2fa` y `/2fa/alta` solo tienen sentido con
 * una sesión de primer factor; sin ella, sus llamadas a Supabase fallan y la
 * pantalla se queda en un error que no explica nada.
 */
export const RUTAS_SIN_SESION = ["/entrar", "/invitacion"];

/** Las pantallas del flujo de acceso: ya dentro, no pintan nada. */
export const RUTAS_DE_ACCESO = ["/entrar", "/2fa", "/2fa/alta", "/invitacion"];

/**
 * Aceptar una invitación es lo único que va ANTES del segundo factor: quien
 * llega del correo tiene sesión pero todavía no tiene contraseña. Si el
 * encaminamiento normal lo mandara a dar de alta el TOTP, se quedaría con una
 * cuenta sin contraseña y sin manera de volver a entrar.
 */
export const RUTA_INVITACION = "/invitacion";

/** Lo que devuelve `supabase.auth.mfa.getAuthenticatorAssuranceLevel()`. */
export type NivelDeGarantia = {
  currentLevel: string | null;
  nextLevel: string | null;
} | null;

function enAlguna(path: string, rutas: readonly string[]): boolean {
  return rutas.some((ruta) => path === ruta || path.startsWith(`${ruta}/`));
}

/** Sin sesión: `null` si puede pasar; si no, adónde mandarlo. */
export function destinoSinSesion(path: string): string | null {
  return enAlguna(path, RUTAS_SIN_SESION) ? null : "/entrar";
}

/** ¿Hace falta preguntar el nivel de garantía para decidir? */
export function necesitaNivel(path: string): boolean {
  return path !== RUTA_INVITACION;
}

/**
 * ¿Tiene esta cuenta un segundo factor verificado? Supabase lo dice en
 * `nextLevel`: aal2 si hay alguno (código o llave), aal1 si no.
 */
export function tieneSegundoFactor(nivel: NivelDeGarantia): boolean {
  return nivel?.nextLevel === "aal2";
}

/**
 * ¿Está dentro del todo? El segundo factor es OPCIONAL: quien no lo tiene entra
 * con la contraseña (aal1); quien lo tiene, solo tras superarlo (aal2). Es la
 * misma regla que aplica la base de datos en `private.segundo_factor_cumplido()`
 * (migración 20261019090000_segundo_factor_opcional.sql).
 */
export function estaDentro(nivel: NivelDeGarantia): boolean {
  if (!nivel) return false;
  return nivel.currentLevel === "aal2" || !tieneSegundoFactor(nivel);
}

/**
 * Con sesión: `null` si puede pasar; si no, adónde mandarlo.
 *
 *   · Con factor y sin superarlo: solo `/2fa`, como siempre.
 *   · Sin factor: dentro. `/2fa/alta` sigue abierto, porque activarlo es
 *     opcional y se llega desde Ajustes o desde la bienvenida.
 *   · Con factor superado: dentro; las pantallas de acceso ya no pintan nada.
 *   · Si no se pudo leer el nivel, a `/2fa`, que lo vuelve a mirar en el
 *     cliente. Nunca dentro sin saberlo (aunque la base, de todas formas, no
 *     daría nada a quien no cumpla).
 */
export function destinoConSesion(path: string, nivel: NivelDeGarantia): string | null {
  if (!necesitaNivel(path)) return null;

  if (!estaDentro(nivel)) return path === "/2fa" ? null : "/2fa";

  if (path === "/2fa/alta" || path.startsWith("/2fa/alta/")) {
    return tieneSegundoFactor(nivel) ? "/resumen" : null;
  }
  return enAlguna(path, RUTAS_DE_ACCESO) ? "/resumen" : null;
}
