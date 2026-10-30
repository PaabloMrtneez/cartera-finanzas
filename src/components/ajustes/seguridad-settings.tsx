"use client";

import { KeyRound, ScanFace, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ContenidoFila, FILA_AJUSTE, SeccionAjustes } from "@/components/ajustes/seccion";
import { Button, ButtonLink } from "@/components/ui/button";
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
      <SeccionAjustes
        titulo="Seguridad"
        descripcion="Ahora entras solo con la contraseña. Con la verificación activada, además te pedirá un código que genera tu móvil: aunque alguien averigüe tu contraseña, no podrá ver tus cuentas."
      >
        <div className={FILA_AJUSTE}>
          <ContenidoFila
            icono={<ShieldCheck size={17} aria-hidden />}
            titulo="Verificación en dos pasos"
            detalle="Desactivada"
          />
          <ButtonLink href="/2fa/alta?desde=ajustes" variant="secondary" size="compact">
            Activar
          </ButtonLink>
        </div>
      </SeccionAjustes>
    );
  }

  return (
    <SeccionAjustes
      titulo="Seguridad"
      descripcion="Verificación en dos pasos activada: para entrar hace falta la contraseña y, además, el segundo paso."
    >
      {codigos.map((f) => (
        <div key={f.id} className={FILA_AJUSTE}>
          <ContenidoFila
            icono={<KeyRound size={17} aria-hidden />}
            titulo="Código de 6 dígitos"
            detalle={`App de códigos${fecha(f.created_at) ? ` · desde el ${fecha(f.created_at)}` : ""}`}
          />
        </div>
      ))}

      {conLlave.map((f) => (
        <div key={f.id} className={FILA_AJUSTE}>
          <ContenidoFila
            icono={<ScanFace size={17} aria-hidden />}
            claseIcono="bg-accent-soft text-accent-text"
            titulo="Face ID / huella"
            detalle={f.friendly_name ?? "Llave de acceso"}
          />
        </div>
      ))}

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
    </SeccionAjustes>
  );
}
