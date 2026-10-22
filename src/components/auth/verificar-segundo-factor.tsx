"use client";

import { ScanFace } from "lucide-react";
import { useEffect, useState } from "react";
import { CampoCodigo, leerCodigo } from "@/components/auth/campo-codigo";
import { dispositivoActual, hayApiDeLlaves, usarLlave } from "@/components/auth/llave";
import { Button, ButtonLink } from "@/components/ui/button";
import { FieldError } from "@/components/ui/input";
import { authErrorMessage } from "@/lib/auth-errors";
import {
  biometriaDe,
  mensajeFalloLlave,
  planDeVerificacion,
  type FactorResumen,
  type PlanVerificacion,
} from "@/lib/segundo-factor";
import type { createClient } from "@/lib/supabase/client";

type Cliente = ReturnType<typeof createClient>;

/**
 * Superar el segundo factor con lo que la persona tenga: la llave (Face ID,
 * huella) si la tiene y el navegador puede, y si no, el código de 6 dígitos.
 *
 * Lo usan dos pantallas: `/2fa` al entrar, y `/invitacion` cuando quien abre
 * un enlace ya tenía cuenta (Supabase exige el segundo factor para cambiar la
 * contraseña). Recibe el cliente de la página porque en la invitación tiene
 * que ser EL MISMO que estableció la sesión.
 */
export function VerificarSegundoFactor({
  supabase,
  contexto,
  onVerificado,
}: {
  supabase: Cliente;
  /** «entrar» en /2fa; «invitacion» para quien ya tenía cuenta. */
  contexto: "entrar" | "invitacion";
  onVerificado: () => void;
}) {
  const [plan, setPlan] = useState<PlanVerificacion | null>(null);
  const [biometria, setBiometria] = useState("Face ID");
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [conCodigo, setConCodigo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (!vivo) return;
      // Primero el error: si no se pudieron leer los factores, «no hay ninguno»
      // no es verdad.
      if (listError || !data) {
        setErrorCarga(authErrorMessage(listError) ?? "No se han podido leer tus datos de acceso.");
        return;
      }
      // Lo que depende del navegador se calcula aquí, ya montado: en el
      // servidor no hay `navigator` y el texto no casaría al hidratar.
      const dispositivo = dispositivoActual();
      setBiometria(biometriaDe(dispositivo));
      setPlan(planDeVerificacion(data.all as FactorResumen[], hayApiDeLlaves(), dispositivo));
    })();
    return () => {
      vivo = false;
    };
  }, [supabase]);

  // En la invitación, sin factor no hay nada que superar: se sigue a la
  // contraseña en vez de dejar a la persona ante una pregunta sin respuesta.
  useEffect(() => {
    if (contexto === "invitacion" && plan?.modo === "ninguno") onVerificado();
  }, [contexto, plan, onVerificado]);

  async function conLlave(factorId: string) {
    setError(null);
    setBusy(true);
    const r = await usarLlave(supabase, factorId);
    if (r.ok) {
      onVerificado();
      return;
    }
    setBusy(false);
    const mensaje = mensajeFalloLlave(r.motivo, biometria);
    // Si el proyecto no tiene WebAuthn activo, insistir no sirve: al código.
    if (r.motivo === "no-habilitado" && plan?.modo === "llave" && plan.totp) {
      setAviso(mensaje);
      setConCodigo(true);
      return;
    }
    setError(mensaje);
  }

  async function conCodigoSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const totp = plan?.modo === "codigo" ? plan.totp : plan?.modo === "llave" ? plan.totp : null;
    if (!totp) return;

    setError(null);
    setBusy(true);
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: totp.id,
      code: leerCodigo(event.currentTarget),
    });
    if (verifyError) {
      setError(authErrorMessage(verifyError));
      setBusy(false);
      return;
    }
    onVerificado();
  }

  const titulo = contexto === "entrar" ? "Confirma que eres tú" : "Primero, confirma que eres tú";
  const porQue =
    contexto === "invitacion"
      ? "Tu cuenta ya tiene el segundo factor activado, y hace falta superarlo para poder cambiar la contraseña. "
      : "";

  if (errorCarga) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-[22px] leading-7 font-semibold">{titulo}</h2>
        <FieldError>{errorCarga}</FieldError>
        <ButtonLink href="/entrar" variant="secondary">
          Volver a entrar
        </ButtonLink>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <div className="h-7 w-2/3 esqueleto rounded-sm" />
        <div className="h-[50px] esqueleto rounded-md" />
        <span className="sr-only">Comprobando tu cuenta…</span>
      </div>
    );
  }

  if (plan.modo === "ninguno") {
    if (contexto === "invitacion") return null;
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-[22px] leading-7 font-semibold">{titulo}</h2>
        <p className="text-[15px] leading-5 text-muted">
          Tu cuenta no tiene la verificación en dos pasos activada: con la contraseña basta. Puedes
          activarla cuando quieras en Ajustes → Seguridad.
        </p>
        <ButtonLink href="/resumen">Continuar</ButtonLink>
      </div>
    );
  }

  if (plan.modo === "sin-soporte") {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="text-[22px] leading-7 font-semibold">{titulo}</h2>
        <p className="text-[15px] leading-5 text-muted">
          Tu cuenta se protege con Face ID o con la huella, y este navegador no puede usarlos.
          Entra desde el móvil donde lo activaste.
        </p>
        <p className="text-[13px] leading-[18px] text-muted">
          Si ya no tienes ese móvil, pide a quien te invitó que te restablezca el acceso.
        </p>
      </div>
    );
  }

  // ── Con la llave ─────────────────────────────────────────────────────────
  if (plan.modo === "llave" && !conCodigo) {
    const [principal, ...otras] = plan.llaves;
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-[22px] leading-7 font-semibold">{titulo}</h2>
          <p className="text-[15px] leading-5 text-muted">
            {porQue}
            Te lo pedirá el sistema, como al desbloquear el móvil.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Button
            onClick={() => conLlave(principal.id)}
            disabled={busy}
            className="lg:h-[50px] lg:text-[17px]"
          >
            <ScanFace size={20} aria-hidden />
            {busy ? "Esperando…" : `${contexto === "entrar" ? "Entrar" : "Continuar"} con ${biometria}`}
          </Button>
          <FieldError>{error}</FieldError>
        </div>

        {otras.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] leading-[18px] text-muted">
              ¿Lo activaste en otro dispositivo? Elige cuál:
            </p>
            {otras.map((llave) => (
              <Button
                key={llave.id}
                variant="secondary"
                size="compact"
                disabled={busy}
                onClick={() => conLlave(llave.id)}
              >
                {llave.friendly_name ?? "Otra llave"}
              </Button>
            ))}
          </div>
        ) : null}

        {plan.totp ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConCodigo(true);
            }}
            className="pulsable min-h-11 text-center text-[15px] leading-5 font-semibold text-accent-text"
          >
            Usar el código de 6 dígitos
          </button>
        ) : null}
      </div>
    );
  }

  // ── Con el código ────────────────────────────────────────────────────────
  const avisoCodigo =
    aviso ??
    (plan.modo === "codigo" && plan.llaveSinSoporte
      ? `Este navegador no puede usar ${biometria}: usa el código de tu app.`
      : null);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[22px] leading-7 font-semibold">{titulo}</h2>
        <p className="text-[15px] leading-5 text-muted">
          {porQue}
          Escribe el código que muestra ahora tu app de autenticación (o el llavero del iPhone).
        </p>
      </div>

      {avisoCodigo ? (
        <p className="rounded-md bg-surface-2 px-4 py-3 text-[13px] leading-[18px] text-muted">
          {avisoCodigo}
        </p>
      ) : null}

      <form onSubmit={conCodigoSubmit} className="flex flex-col gap-4">
        <CampoCodigo autoFocus />
        <FieldError>{error}</FieldError>
        <Button type="submit" disabled={busy} className="lg:h-[50px] lg:text-[17px]">
          {busy ? "Comprobando…" : contexto === "entrar" ? "Entrar" : "Continuar"}
        </Button>
      </form>

      {plan.modo === "llave" && !aviso ? (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConCodigo(false);
          }}
          className="pulsable min-h-11 text-center text-[15px] leading-5 font-semibold text-accent-text"
        >
          Usar {biometria}
        </button>
      ) : null}
    </div>
  );
}
