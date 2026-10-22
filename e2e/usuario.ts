import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";

/**
 * Qué usuario de pruebas usa esta corrida y cómo se reserva para ella sola.
 *
 * ── Un usuario por «dueño» de la corrida (B-7) ────────────────────────────
 * El arnés le BORRA el segundo factor y le RESIEMBRA los datos al usuario en
 * cada corrida. Dos corridas sobre el mismo usuario se pisan: la segunda revoca
 * la sesión de la primera y le borra lo que estaba creando. Por eso:
 *
 *   · la CI usa `ci@cartera.local` (lo fija `.github/workflows/e2e.yml`);
 *   · el trabajo local y los agentes, `fase3@cartera.local` por defecto, u
 *     otro `…@cartera.local` con `E2E_EMAIL` (ver `e2e/README.md`).
 *
 * Fuera de la CI el arnés se niega a usar el usuario de la CI salvo que se
 * pida a propósito con `E2E_PERMITIR_CI=1` (p. ej., si se sabe que la CI no va
 * a correr y el usuario local está ocupado).
 *
 * ── El cerrojo ─────────────────────────────────────────────────────────────
 * Además, cada corrida RESERVA su usuario con un cerrojo consultivo de Postgres
 * (`pg_advisory_lock`) en una conexión que se mantiene abierta hasta el final.
 * Si otra corrida (otro agente, otro worktree) ya lo tiene, esta espera en fila
 * en lugar de resetearle el factor a mitad. `sesion-de-prueba.mjs` comprueba el
 * mismo cerrojo y se niega a tocar un usuario reservado.
 */

export const USUARIO_CI = "ci@cartera.local";
export const USUARIO_LOCAL = "fase3@cartera.local";

export function usuarioDePrueba(): string {
  const email = (process.env.E2E_EMAIL ?? (process.env.CI ? USUARIO_CI : USUARIO_LOCAL))
    .trim()
    .toLowerCase();
  if (!email.endsWith("@cartera.local")) {
    throw new Error(`E2E_EMAIL=«${email}»: el arnés solo acepta usuarios de prueba @cartera.local.`);
  }
  if (email === USUARIO_CI && !process.env.CI && process.env.E2E_PERMITIR_CI !== "1") {
    throw new Error(
      `${USUARIO_CI} es el usuario de la CI: usarlo en local le resetea el factor a una corrida ` +
        "de la CI en marcha. Usa el local (sin E2E_EMAIL) u otro @cartera.local, o, si sabes " +
        "que la CI no está corriendo, E2E_PERMITIR_CI=1.",
    );
  }
  return email;
}

/**
 * El fichero de entorno con los secretos (Supabase y DATABASE_URL). Por
 * defecto `.env.local` del directorio de trabajo; en un worktree se puede
 * apuntar al del repo principal con `E2E_ENV_FILE`, sin copiarlo.
 */
export function ficheroDeEntorno(): string {
  return path.resolve(process.env.E2E_ENV_FILE ?? ".env.local");
}

/** La clave del cerrojo; la MISMA que comprueba `scripts/sesion-de-prueba.mjs`. */
export const claveCerrojo = (email: string) => `e2e:${email}`;

/**
 * Reserva el usuario para esta corrida. Devuelve la función que lo libera.
 * Si está ocupado, espera hasta `E2E_ESPERA_MIN` minutos (15 por defecto).
 */
export async function reservarUsuario(email: string): Promise<() => Promise<void>> {
  const entorno = parseEnv(readFileSync(ficheroDeEntorno(), "utf8"));
  const url = entorno.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error(`Falta DATABASE_URL en ${ficheroDeEntorno()}`);

  const cliente = new pg.Client({
    connectionString: url,
    // La misma CA que `scripts/db-ssl.mjs` (que no se puede importar desde aquí:
    // es un .mjs con import.meta y el cargador de Playwright lo trataría como CJS).
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(path.resolve("supabase", "prod-ca-2021.crt"), "utf8"),
    },
    keepAlive: true,
  });
  await cliente.connect();

  const esperaMax = Number(process.env.E2E_ESPERA_MIN ?? "15") * 60_000;
  const inicio = Date.now();
  let avisado = false;
  for (;;) {
    const { rows } = await cliente.query<{ ok: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as ok",
      [claveCerrojo(email)],
    );
    if (rows[0]?.ok) break;
    if (Date.now() - inicio > esperaMax) {
      await cliente.end();
      throw new Error(
        `${email} lleva más de ${esperaMax / 60_000} min reservado por otra corrida del e2e. ` +
          "Usa otro usuario de prueba (E2E_EMAIL) o espera a que termine.",
      );
    }
    if (!avisado) {
      console.log(`[e2e] ${email} está en uso por otra corrida; espero a que termine…`);
      avisado = true;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }

  return async () => {
    await cliente
      .query("select pg_advisory_unlock(hashtext($1))", [claveCerrojo(email)])
      .catch(() => {});
    await cliente.end().catch(() => {});
  };
}
