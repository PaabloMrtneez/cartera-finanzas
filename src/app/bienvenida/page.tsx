import { redirect } from "next/navigation";
import { Onboarding } from "@/components/bienvenida/onboarding";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Bienvenida" };

/**
 * Primer arranque. Vive fuera del grupo `(app)` a propósito: sin barra de
 * pestañas ni barra lateral, porque todavía no hay nada que navegar, y así
 * tampoco puede entrar en bucle con el redirigido que trae aquí desde el
 * armazón de la app.
 */
export default async function BienvenidaPage() {
  const supabase = await createClient();
  const { count } = await supabase.from("account").select("*", { count: "exact", head: true });

  // Con cuentas ya creadas esto no pinta nada: se entra directo.
  if ((count ?? 0) > 0) redirect("/resumen");

  return <Onboarding />;
}
