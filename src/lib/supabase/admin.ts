import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Cliente con service_role: se salta la RLS. SOLO para el servidor.
 *
 * Existe para escribir los datos COMPARTIDOS de mercado (catálogo de
 * instrumentos, precios diarios, tipos de cambio), que ningún usuario puede
 * escribir: si pudiera, movería el patrimonio de los demás. Nada de lo que es
 * de un usuario (posiciones, libro de participaciones, movimientos) se escribe
 * con este cliente: eso va siempre con el de la sesión (`./server`), para que la
 * RLS y las claves foráneas compuestas hagan su trabajo.
 *
 * La clave NO lleva prefijo NEXT_PUBLIC_ (invariante 8) y este módulo no se
 * importa desde ningún componente de cliente (la CI falla si un fichero con la
 * directiva de cliente nombra la variable; por eso este comentario no la
 * escribe entre comillas: la CI la busca literal). La comprobación de `window` es un cinturón
 * más: si alguien lo importara en el navegador, revienta en vez de intentarlo.
 */
export function createAdminClient() {
  if (typeof window !== "undefined") {
    throw new Error("El cliente de service_role no puede usarse en el navegador");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !clave) throw new Error("Falta la configuración de Supabase del servidor");

  return createClient<Database>(url, clave, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
