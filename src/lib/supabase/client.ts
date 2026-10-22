import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

/**
 * Cliente para el navegador. Usa la clave publicable, que es pública por
 * diseño: lo que protege los datos es la seguridad a nivel de fila, no que esta
 * clave sea secreta.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
