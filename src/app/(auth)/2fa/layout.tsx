import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Pone el título de la pestaña (las páginas son de cliente y no pueden exportar
 * `metadata`; el marco de acceso lo da el layout del grupo) y vuelve a exigir
 * el primer factor.
 *
 * El proxy ya manda a /entrar a quien llega aquí sin sesión; esto es la segunda
 * cerradura, por si un cambio en su `matcher` dejara pasar la ruta. Sin sesión,
 * `/2fa` y `/2fa/alta` no pueden hacer nada útil: sus llamadas a Supabase
 * fallarían y la pantalla se quedaría en un error sin explicación. Cubre las dos
 * páginas, porque `/2fa/alta` cuelga de este layout.
 */
export const metadata = { title: "Segundo factor" };

export default async function Layout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/entrar");

  return children;
}
