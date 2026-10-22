"use client";

import { KeyRound, ScanFace, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Grupo } from "@/components/ui/card";
import { FieldError } from "@/components/ui/input";
import { biometriaDe, mensajeFalloLlave, type FactorResumen } from "@/lib/segundo-factor";

/**
 * La verificación en dos pasos de la cuenta.
 *
 * Es OPCIONAL: sin ella se entra con la contraseña. Aquí se ve si está activada
 * y, si no, se activa (lleva a /2fa/alta, que vuelve aquí al terminar). Con ella
 * activada se listan los factores; y si el dispositivo tiene lector y Supabase
 * tiene WebAuthn activado (hoy no), se puede sumar Face ID sin quitar el código.
 *
 * Quitar factores no se ofrece a propósito: para los casos raros está
 * `scripts/reset-2fa.mjs`. Y Supabase exige aal2 para quitar uno verificado, así
 * que quien solo sepa la contraseña tampoco podría.
 */
export function SeguridadSettings({ factores }: { factores: FactorResumen[] }) {
  const router = useRouter();
  const [llaves, setLlaves] = useState(false);
  const [biometria, setBiometria] = useState("Face ID");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verificados = factores.filter((f) => f.status === "verified");
  const codigos = verificados.filter((f) => f.factor_type === "totp");
  const conLlave = verificados.filter((f) => f.factor_type === "webauthn");
  const activada = verificados.length > 0;

  useEffect(() => {
    if (!activada) return;
    let vivo = true;
    // Se carga al montar, no con la página: Ajustes no arrastra el cliente de
    // Supabase en su paquete inicial por una comprobación.
    Promise.all([import("@/lib/supabase/client"), import("@/components/auth/llave")]).then(
      async ([{ createClient }, m]) => {
        const disponible = await m.llavesDisponibles(createClient());
        if (!vivo) return;
        setBiometria(biometriaDe(m.dispositivoActual()));
        setLlaves(disponible);
      },
    );
    return () => {
      vivo = false;
    };
  }, [activada]);

  async function anadirLlave() {
    setError(null);
    setAviso(null);
    setBusy(true);
    const [{ createClient }, { crearLlave }] = await Promise.all([
      import("@/lib/supabase/client"),
      import("@/components/auth/llave"),
    ]);
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const r = await crearLlave(supabase, data.session?.user.email);
    setBusy(false);
    if (r.ok) {
      setAviso(`Listo: la próxima vez podrás entrar con ${biometria}.`);
      router.refresh();
      return;
    }
    if (r.motivo === "no-habilitado") setLlaves(false);
    setError(mensajeFalloLlave(r.motivo, biometria));
  }

  const fecha = (iso?: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" })
      : null;

  if (!activada) {
    return (
      <Grupo titulo="Seguridad">
        <div className="flex min-h-[60px] items-center gap-3 px-[18px] py-2">
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
            <ShieldCheck size={16} aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-semibold">Verificación en dos pasos</span>
            <span className="text-[13px] leading-[18px] text-muted">Desactivada</span>
          </span>
          <ButtonLink href="/2fa/alta?desde=ajustes" variant="secondary" size="compact">
            Activar
          </ButtonLink>
        </div>
        <p className="hair-t border-separator px-[18px] py-3 text-[13px] leading-[18px] text-muted">
          Ahora entras solo con la contraseña. Con la verificación activada, además te pedirá un
          código que genera tu móvil: aunque alguien averigüe tu contraseña, no podrá ver tus
          cuentas.
        </p>
      </Grupo>
    );
  }

  return (
    <Grupo titulo="Seguridad">
      {codigos.map((f) => (
        <div
          key={f.id}
          className="flex min-h-[60px] items-center gap-3 hair-t border-separator px-[18px] py-2 first:border-t-0"
        >
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
            <KeyRound size={16} aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-semibold">Código de 6 dígitos</span>
            <span className="text-[13px] leading-[18px] text-muted">
              App de códigos{fecha(f.created_at) ? ` · desde el ${fecha(f.created_at)}` : ""}
            </span>
          </span>
        </div>
      ))}

      {conLlave.map((f) => (
        <div
          key={f.id}
          className="flex min-h-[60px] items-center gap-3 hair-t border-separator px-[18px] py-2 first:border-t-0"
        >
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
            <ScanFace size={16} aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-semibold">Face ID / huella</span>
            <span className="truncate text-[13px] leading-[18px] text-muted">
              {f.friendly_name ?? "Llave de acceso"}
            </span>
          </span>
        </div>
      ))}

      <p className="hair-t border-separator px-[18px] py-3 text-[13px] leading-[18px] text-muted">
        Verificación en dos pasos activada: para entrar hace falta la contraseña y, además, el
        segundo paso.
      </p>

      {/* Solo si el dispositivo tiene lector y Supabase lo tiene activado. */}
      {llaves || error || aviso ? (
        <div className="flex flex-col gap-2 hair-t border-separator p-3">
          {llaves ? (
            <Button
              variant="secondary"
              size="compact"
              className="w-full"
              disabled={busy}
              onClick={anadirLlave}
            >
              <ScanFace size={16} aria-hidden />
              {busy
                ? "Esperando…"
                : conLlave.length > 0
                  ? `Añadir ${biometria} en este dispositivo`
                  : `Añadir ${biometria}`}
            </Button>
          ) : null}
          <FieldError>{error}</FieldError>
          {aviso ? (
            <p role="status" className="px-[6px] text-[13px] leading-[18px] font-semibold text-income">
              {aviso}
            </p>
          ) : null}
        </div>
      ) : null}
    </Grupo>
  );
}
