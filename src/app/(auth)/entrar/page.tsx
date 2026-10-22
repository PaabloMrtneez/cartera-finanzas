"use client";

import { UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, PasswordInput } from "@/components/ui/input";
import { authErrorMessage } from "@/lib/auth-errors";

/**
 * El cliente de Supabase (supabase-js, ~64 KB gzip) se carga APARTE, no con la
 * página: era lo más pesado de la primera pantalla de un dispositivo nuevo, y
 * para pintar el formulario no hace falta. Se pide en cuanto el formulario
 * recibe el foco (el correo lo tiene nada más montar) y, como tarde, al
 * enviar. El acceso en sí no cambia: mismo cliente, misma llamada.
 */
const cargarCliente = () => import("@/lib/supabase/client");

export default function EntrarPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const { createClient } = await cargarCliente();
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: String(form.get("email") ?? "").trim(),
      password: String(form.get("password") ?? ""),
    });

    if (signInError) {
      setError(authErrorMessage(signInError));
      setBusy(false);
      return;
    }

    // A dónde va después lo decide el proxy según el segundo factor: si lo
    // tiene, a pedirlo; si no (es opcional), ya al resumen.
    router.replace("/resumen");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} onFocus={() => void cargarCliente()} className="flex flex-col gap-4">
      <h2 className="text-[19px] leading-6 font-semibold">Entra en tu cuenta</h2>

      <div className="flex flex-col gap-[6px]">
        <Label htmlFor="email">Correo</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          placeholder="tu@correo.com"
        />
      </div>

      <div className="flex flex-col gap-[6px]">
        <Label htmlFor="password">Contraseña</Label>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
        />
      </div>

      <FieldError>{error}</FieldError>

      <Button type="submit" disabled={busy} className="mt-2 lg:h-[50px] lg:text-[17px]">
        {busy ? "Entrando…" : "Entrar"}
      </Button>

      {/*
        Para quien no tiene cuenta. Antes era una línea pequeña al pie, y dos
        personas invitadas se quedaron delante de este formulario buscando dónde
        registrarse. No hay registro: hay que abrir el enlace que les mandaron.
      */}
      <div className="mt-1 flex items-start gap-3 hair-t border-separator pt-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <UserPlus size={18} aria-hidden />
        </span>
        <div className="flex flex-col gap-[2px]">
          <p className="text-[15px] leading-5 font-semibold">¿Es tu primera vez?</p>
          <p className="text-[13px] leading-[18px] text-muted">
            Cartera es por invitación: abre el enlace que te mandaron (por WhatsApp o por correo) y
            te guiará paso a paso. Aquí no hace falta registrarse.
          </p>
        </div>
      </div>
    </form>
  );
}
