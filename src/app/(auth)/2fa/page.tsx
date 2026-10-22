"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { VerificarSegundoFactor } from "@/components/auth/verificar-segundo-factor";
import { createClient } from "@/lib/supabase/client";

/**
 * Segundo paso del acceso. Con una llave dada de alta, el botón principal es
 * «Entrar con Face ID» y el código queda debajo como alternativa; con solo el
 * código, es la pantalla de siempre (y la que recorre el e2e).
 */
export default function DosFactoresPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const alVerificar = useCallback(() => {
    router.replace("/resumen");
    router.refresh();
  }, [router]);

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/entrar");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <VerificarSegundoFactor supabase={supabase} contexto="entrar" onVerificado={alVerificar} />

      <button
        type="button"
        onClick={signOut}
        // 44 px de alto: era una línea de texto de 18 px, difícil de acertar.
        className="pulsable min-h-11 text-center text-[13px] leading-[18px] font-semibold text-muted"
      >
        Salir y usar otra cuenta
      </button>
    </div>
  );
}
