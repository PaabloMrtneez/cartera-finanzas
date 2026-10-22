"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      variant="secondary"
      size="compact"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // El cliente de Supabase se carga al pulsar, no al pintar Ajustes: cerrar
        // sesión es puntual y así la pantalla no lo arrastra en su paquete inicial.
        const { createClient } = await import("@/lib/supabase/client");
        await createClient().auth.signOut();
        router.replace("/entrar");
        router.refresh();
      }}
    >
      {busy ? "Saliendo…" : "Cerrar sesión"}
    </Button>
  );
}
