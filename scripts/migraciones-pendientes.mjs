/**
 * Migraciones de `supabase/migrations/` que la base todavía NO tiene aplicadas
 * (las que no figuran en `supabase_migrations.schema_migrations`), para
 * probarlas DENTRO de una transacción que se deshace, sin aplicarlas de verdad.
 *
 *   import { aplicarPendientes } from "./migraciones-pendientes.mjs";
 *   await client.query("begin");
 *   const aplicadas = await aplicarPendientes(client);   // [] si no falta ninguna
 *   …
 *   await client.query("rollback");
 *
 * Cada una se registra también en `schema_migrations` (dentro de la misma
 * transacción, así que se deshace con ella): una prueba que pregunte después
 * qué hay aplicado ve lo mismo que verá la base cuando se apliquen.
 *
 * Con `hasta` se aplican solo las de versión <= hasta (para comparar «antes» y
 * «después» de una en concreto).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIR_MIGRACIONES = join(raiz, "supabase", "migrations");

/** Todas las migraciones del repositorio, en orden: { version, nombre, fichero, sql }. */
export function migracionesDelRepo() {
  return readdirSync(DIR_MIGRACIONES)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: f.slice(0, 14),
      nombre: f.slice(15, -4),
      fichero: f,
      sql: readFileSync(join(DIR_MIGRACIONES, f), "utf8"),
    }));
}

export async function versionesAplicadas(client) {
  const r = await client.query("select version from supabase_migrations.schema_migrations");
  return new Set(r.rows.map((x) => x.version));
}

export async function migracionesPendientes(client, { hasta } = {}) {
  const aplicadas = await versionesAplicadas(client);
  return migracionesDelRepo().filter((m) => !aplicadas.has(m.version) && (!hasta || m.version <= hasta));
}

/** Aplica las pendientes (dentro de la transacción en curso) y devuelve sus ficheros. */
export async function aplicarPendientes(client, opciones = {}) {
  const pendientes = await migracionesPendientes(client, opciones);
  for (const m of pendientes) {
    // Cada una en su savepoint: si choca (interbloqueo, 40P01) con una lectura
    // de la app que tenía ya una vista y espera por una tabla que esta
    // migración ha bloqueado, se deshace solo esa migración y se reintenta.
    for (let intento = 1; ; intento++) {
      await client.query("savepoint migracion_pendiente");
      try {
        await client.query(m.sql);
        await client.query("release savepoint migracion_pendiente");
        break;
      } catch (e) {
        await client.query("rollback to savepoint migracion_pendiente");
        await client.query("release savepoint migracion_pendiente");
        if (e.code === "40P01" && intento < 6) {
          await new Promise((ok) => setTimeout(ok, 500 * intento));
          continue;
        }
        e.message = `${m.fichero}: ${e.message}`;
        throw e;
      }
    }
    await client.query(
      "insert into supabase_migrations.schema_migrations (version, name) values ($1, $2) on conflict do nothing",
      [m.version, m.nombre],
    );
  }
  return pendientes.map((m) => m.fichero);
}
