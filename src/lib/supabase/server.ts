import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";

/**
 * Cliente para componentes y acciones de servidor. La sesión viaja en cookies,
 * que es lo que permite renderizar en el servidor ya autenticado.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Los componentes de servidor no pueden escribir cookies. No pasa
            // nada: el proxy ya refrescó la sesión antes de llegar aquí.
          }
        },
      },
    },
  );
}
