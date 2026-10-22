import { cache } from "react";
import { createClient } from "./server";

/**
 * Consultas que piden a la vez el armazón de la app (`(app)/layout.tsx`) y
 * alguna pantalla, memorizadas con `cache()` de React: dentro de UNA misma
 * petición, la segunda llamada reutiliza el resultado de la primera en lugar de
 * volver a la base.
 *
 * Al abrir Resumen, por ejemplo, el armazón cuenta los pendientes del Atajo
 * para la insignia de la barra y Resumen los vuelve a contar para su aviso: dos
 * consultas idénticas en el mismo render. Con esto, una.
 *
 * `cache()` dura lo que dura la petición: no comparte nada entre peticiones ni,
 * por tanto, entre usuarios. Y cada consulta va con la sesión de quien pide,
 * así que la RLS sigue mandando.
 */

/** Movimientos del Atajo pendientes de confirmar. */
export const contarPendientes = cache(async (): Promise<number> => {
  const supabase = await createClient();
  const { count } = await supabase
    .from("transaction")
    .select("*", { count: "exact", head: true })
    .eq("status", "PENDING");
  return count ?? 0;
});

/** Cuántas cuentas hay (archivadas incluidas). */
export const contarCuentas = cache(async (): Promise<number> => {
  const supabase = await createClient();
  const { count } = await supabase.from("account").select("*", { count: "exact", head: true });
  return count ?? 0;
});
