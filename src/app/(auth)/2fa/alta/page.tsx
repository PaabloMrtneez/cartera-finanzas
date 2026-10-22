"use client";

import { Check, KeyRound, ScanFace, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { CampoCodigo, leerCodigo } from "@/components/auth/campo-codigo";
import {
  crearLlave,
  dispositivoActual,
  limpiarFactoresSinVerificar,
  llavesDisponibles,
} from "@/components/auth/llave";
import { PasosAcceso } from "@/components/auth/pasos-acceso";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { FieldError } from "@/components/ui/input";
import { authErrorMessage } from "@/lib/auth-errors";
import { biometriaDe, mensajeFalloLlave } from "@/lib/segundo-factor";
import { createClient } from "@/lib/supabase/client";

type Cliente = ReturnType<typeof createClient>;

/**
 * Activar la verificación en dos pasos. Es OPCIONAL (recomendada): quien no la
 * tiene entra con la contraseña, y quien la tiene, solo tras superarla. Por eso
 * esta pantalla siempre tiene un «Ahora no» bien visible.
 *
 * Se llega desde dos sitios:
 *   · `?desde=invitacion`: el paso 2 de la bienvenida, con el indicador de
 *     pasos y, al terminar (o al saltarlo), la pantalla de «Todo listo».
 *   · `?desde=ajustes`: Ajustes → Seguridad → «Activar». Al terminar, vuelve.
 *
 * La opción principal es el código de 6 dígitos. Face ID / huella (WebAuthn)
 * solo aparece si el dispositivo tiene lector Y el proyecto de Supabase lo tiene
 * activado (hoy no: es un complemento aparte). El día que lo esté, aparecerá
 * sola por delante del código, sin tocar nada aquí.
 */
export default function AltaDosFactoresPage() {
  return (
    <Suspense fallback={<div className="h-[260px] esqueleto rounded-lg" />}>
      <Alta />
    </Suspense>
  );
}

type Modo = "preparando" | "elegir" | "codigo" | "listo";
type Final = "llave" | "codigo" | "omitido";

function Alta() {
  const router = useRouter();
  const desde = useSearchParams().get("desde");
  const desdeInvitacion = desde === "invitacion";
  const supabase = useMemo(() => createClient(), []);

  const [modo, setModo] = useState<Modo>("preparando");
  const [conLlave, setConLlave] = useState(false);
  const [biometria, setBiometria] = useState("Face ID");
  const [cuenta, setCuenta] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [final, setFinal] = useState<Final>("codigo");
  const empezado = useRef(false);

  useEffect(() => {
    // En desarrollo React monta dos veces; sin esto se limpiaría dos veces.
    if (empezado.current) return;
    empezado.current = true;

    (async () => {
      // Restos de un intento anterior que no llegó a verificarse: fuera, o
      // Supabase puede rechazar el alta nueva.
      await limpiarFactoresSinVerificar(supabase);

      const { data } = await supabase.auth.getSession();
      setCuenta(data.session?.user.email ?? null);
      setBiometria(biometriaDe(dispositivoActual()));
      setConLlave(await llavesDisponibles(supabase));
      setModo("elegir");
    })();
  }, [supabase]);

  /** Fuera de esta pantalla, según de dónde se vino. */
  function salir() {
    router.replace(desde === "ajustes" ? "/ajustes" : "/resumen");
    router.refresh();
  }

  function terminar(como: Final) {
    if (desdeInvitacion) {
      setFinal(como);
      setModo("listo");
      return;
    }
    salir();
  }

  async function activarLlave() {
    setError(null);
    setBusy(true);
    const r = await crearLlave(supabase, cuenta);
    setBusy(false);
    if (r.ok) {
      terminar("llave");
      return;
    }

    const mensaje = mensajeFalloLlave(r.motivo, biometria);
    // Lo que no se arregla insistiendo se resuelve con el código.
    if (r.motivo === "no-habilitado" || r.motivo === "sin-soporte" || r.motivo === "dominio") {
      setConLlave(false);
      setAviso(mensaje);
      setModo("codigo");
      return;
    }
    setError(mensaje);
  }

  async function volver() {
    setError(null);
    setAviso(null);
    setModo("preparando");
    // El código a medias que se dejó atrás no se queda colgando.
    await limpiarFactoresSinVerificar(supabase);
    setModo("elegir");
  }

  const paso = desdeInvitacion ? <PasosAcceso actual={modo === "listo" ? 3 : 2} /> : null;

  if (modo === "preparando") {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        {paso}
        <div className="h-7 w-2/3 esqueleto rounded-sm" />
        <div className="h-[180px] esqueleto rounded-lg" />
        <span className="sr-only">Preparando…</span>
      </div>
    );
  }

  if (modo === "listo") {
    const como =
      final === "llave"
        ? `tu correo, tu contraseña y ${biometria}`
        : final === "codigo"
          ? "tu correo, tu contraseña y el código de tu app"
          : "tu correo y tu contraseña";
    return (
      <div className="flex flex-col gap-5">
        {paso}
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent-text">
            <Check size={28} strokeWidth={2.5} aria-hidden />
          </span>
          <h2 className="text-[22px] leading-7 font-semibold">Todo listo</h2>
          <p className="text-[15px] leading-5 text-muted">Para entrar: {como}.</p>
          {final === "omitido" ? (
            <p className="text-[13px] leading-[18px] text-muted">
              Cuando quieras proteger más tu cuenta, activa la verificación en dos pasos en
              Ajustes → Seguridad.
            </p>
          ) : null}
        </div>
        <Button onClick={salir} className="lg:h-[50px] lg:text-[17px]">
          Entrar en Cartera
        </Button>
      </div>
    );
  }

  if (modo === "codigo") {
    return (
      <div className="flex flex-col gap-5">
        {paso}
        <AltaCodigo
          supabase={supabase}
          aviso={aviso}
          onListo={() => terminar("codigo")}
          onVolver={volver}
        />
      </div>
    );
  }

  // ── Elegir: activarla (código, o Face ID si se puede) o dejarlo para luego ─
  return (
    <div className="flex flex-col gap-5">
      {paso}

      <div className="flex flex-col gap-1">
        <p className="text-[13px] leading-[18px] font-semibold tracking-[0.03em] text-accent-text uppercase">
          Recomendado
        </p>
        <h2 className="text-[22px] leading-7 font-semibold">Protege tu cuenta</h2>
        <p className="text-[15px] leading-5 text-muted">
          Con la verificación en dos pasos, además de la contraseña Cartera te pedirá{" "}
          {conLlave ? `${biometria} o ` : ""}un código que genera tu móvil. Así, aunque alguien
          averigüe tu contraseña, no podrá entrar.
        </p>
      </div>

      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <ShieldCheck size={24} aria-hidden />
        </span>
        <p className="text-[15px] leading-5">
          <span className="font-semibold">Es opcional.</span>{" "}
          <span className="text-muted">
            Puedes activarla ahora o más adelante, en Ajustes → Seguridad.
          </span>
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {conLlave ? (
          <>
            <Button onClick={activarLlave} disabled={busy} className="lg:h-[50px] lg:text-[17px]">
              <ScanFace size={20} aria-hidden />
              {busy ? "Esperando…" : `Activar ${biometria}`}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setError(null);
                setModo("codigo");
              }}
              className="lg:h-[50px] lg:text-[17px]"
            >
              <KeyRound size={18} aria-hidden />
              Prefiero un código de 6 dígitos
            </Button>
          </>
        ) : (
          <Button
            onClick={() => {
              setError(null);
              setModo("codigo");
            }}
            className="lg:h-[50px] lg:text-[17px]"
          >
            <KeyRound size={18} aria-hidden />
            Activar código de 6 dígitos
          </Button>
        )}
        <FieldError>{error}</FieldError>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => terminar("omitido")}
          className="lg:h-[50px] lg:text-[17px]"
        >
          Ahora no
        </Button>
      </div>
    </div>
  );
}

type Enrollment = { factorId: string; qr: string; secret: string; uri: string };

/**
 * El código de 6 dígitos (TOTP).
 *
 * La gente esperaba que «el código le llegara» por SMS o por correo, y se
 * quedaba mirando el móvil. Por eso lo primero, y en grande, es que NO llega:
 * lo genera una app. Y la recomendada es la que el iPhone ya trae —el llavero,
 * en la app Contraseñas—, que no obliga a instalar nada.
 *
 * Supabase NO genera códigos de respaldo. Por eso se enseña el secreto en texto
 * y se insiste en guardarlo: si se pierde el móvil y no está guardado, la única
 * salida es que el administrador borre el factor con la clave de servicio.
 */
function AltaCodigo({
  supabase,
  aviso,
  onListo,
  onVolver,
}: {
  supabase: Cliente;
  aviso: string | null;
  onListo: () => void;
  onVolver: () => void;
}) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // En desarrollo React monta dos veces; sin esto se darían de alta dos factores.
    if (started.current) return;
    started.current = true;

    (async () => {
      await limpiarFactoresSinVerificar(supabase);

      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Cartera ${new Date().toLocaleString("es-ES")}`,
      });

      if (enrollError || !data) {
        setError(authErrorMessage(enrollError));
        return;
      }

      setEnrollment({
        factorId: data.id,
        qr: data.totp.qr_code,
        secret: data.totp.secret,
        uri: data.totp.uri,
      });
    })();
  }, [supabase]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment) return;

    setError(null);
    setBusy(true);

    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: enrollment.factorId,
      code: leerCodigo(event.currentTarget),
    });

    if (verifyError) {
      setError(authErrorMessage(verifyError));
      setBusy(false);
      return;
    }

    onListo();
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-[22px] leading-7 font-semibold">Código de 6 dígitos</h2>
        {aviso ? <p className="text-[15px] leading-5 text-muted">{aviso}</p> : null}
      </div>

      {/* Lo que más se malinterpretaba, arriba y en grande. */}
      <div className="flex flex-col gap-1 rounded-md bg-accent-soft px-4 py-3">
        <p className="text-[17px] leading-[22px] font-semibold">
          El código NO llega por SMS ni por correo.
        </p>
        <p className="text-[15px] leading-5">
          Lo genera una app en tu móvil, y cambia cada 30 segundos.
        </p>
      </div>

      {error && !enrollment ? (
        // Sin salida no se queda: si el alta falla (la sesión caducó, la red
        // cayó), vuelve al acceso, que es lo que rehace todo el flujo.
        <div className="flex flex-col gap-4">
          <FieldError>{error}</FieldError>
          <ButtonLink href="/entrar" variant="secondary">
            Volver a entrar
          </ButtonLink>
        </div>
      ) : !enrollment ? (
        <div className="h-[200px] esqueleto rounded-lg" aria-busy="true">
          <span className="sr-only">Preparando el código…</span>
        </div>
      ) : (
        <>
          <ol className="flex flex-col gap-4">
            <li className="flex flex-col gap-3">
              <p className="text-[15px] leading-5">
                <span className="font-semibold">1. Añádelo a una app de códigos.</span>{" "}
                <span className="text-muted">
                  En el iPhone, el llavero (la app Contraseñas) ya lo hace, sin instalar nada. En
                  Android, Google Authenticator.
                </span>
              </p>

              {/*
                En el iPhone el QR está en la MISMA pantalla que tendría que
                escanearlo. El enlace otpauth:// abre las Contraseñas de iOS (o la
                app de códigos de Android) con la clave ya puesta.
              */}
              <a
                href={enrollment.uri}
                className={buttonClasses({ variant: "secondary", className: "lg:hidden" })}
              >
                <KeyRound size={18} aria-hidden />
                Añadir al llavero
              </a>

              <div className="flex flex-col items-center gap-2 rounded-lg bg-white p-4">
                {/* Supabase devuelve el QR ya dibujado, así que no hace falta
                    ninguna librería de códigos QR. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={enrollment.qr}
                  alt="Código QR para añadir Cartera a tu app de códigos"
                  width={180}
                  height={180}
                />
              </div>
              <p className="text-[13px] leading-[18px] text-muted">
                Desde un ordenador: apunta la cámara del iPhone al QR y toca «Añadir a Contraseñas».
              </p>
            </li>

            <li className="flex flex-col gap-2 rounded-lg bg-surface-2 p-4">
              <p className="text-[13px] leading-[18px] font-semibold tracking-[0.03em] text-muted uppercase">
                2. Guarda esta clave
              </p>
              <code className="font-mono text-[15px] leading-5 break-all select-all">
                {enrollment.secret}
              </code>
              <p className="text-[13px] leading-[18px] text-muted">
                Apúntala en tu gestor de contraseñas. Si pierdes el móvil y no la tienes, no hay
                códigos de respaldo: harían falta permisos de administrador para recuperar la
                cuenta.
              </p>
            </li>

            <li>
              <form onSubmit={onSubmit} className="flex flex-col gap-4">
                <p className="text-[15px] leading-5">
                  <span className="font-semibold">3. Escribe el código</span>{" "}
                  <span className="text-muted">que te enseña ahora la app.</span>
                </p>
                <CampoCodigo />
                <FieldError>{error}</FieldError>
                <Button type="submit" disabled={busy} className="lg:h-[50px] lg:text-[17px]">
                  {busy ? "Comprobando…" : "Activar y entrar"}
                </Button>
              </form>
            </li>
          </ol>
        </>
      )}

      <button
        type="button"
        onClick={onVolver}
        className="pulsable min-h-11 text-center text-[15px] leading-5 font-semibold text-accent-text"
      >
        Volver
      </button>
    </>
  );
}
