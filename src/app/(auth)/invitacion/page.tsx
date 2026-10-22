"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { PasosAcceso } from "@/components/auth/pasos-acceso";
import { VerificarSegundoFactor } from "@/components/auth/verificar-segundo-factor";
import { Button, ButtonLink } from "@/components/ui/button";
import { FieldError, Label, PasswordInput } from "@/components/ui/input";
import { authErrorMessage } from "@/lib/auth-errors";
import { detalleDeEnlace } from "@/lib/invitacion";
import { createClient } from "@/lib/supabase/client";

/**
 * La bienvenida de quien llega con una invitación (o con un enlace para volver
 * a poner contraseña), y el primer paso: elegir la contraseña.
 *
 * NO SE CANJEA NADA AL CARGAR. El enlace llega por WhatsApp, y WhatsApp abre
 * los enlaces para dibujar la vista previa; los antivirus y los clientes de
 * correo hacen lo mismo. Si esta página canjeara el token al cargar, esa visita
 * se lo gastaría y a la persona de verdad le llegaría un enlace muerto. Por eso
 * primero se enseña qué es Cartera y qué va a pasar, y el token se canjea al
 * pulsar «Empezar», que solo pulsa una persona.
 *
 * El enlace puede llegar de dos formas:
 *
 *   ?token_hash=…&type=invite|recovery   el que genera Cartera (Ajustes o los scripts)
 *   ?code=…                              flujo PKCE de un correo de Supabase
 *
 * NO se acepta el flujo implícito (`#access_token=…&refresh_token=…`). Esos
 * tokens son una sesión ya hecha, y cualquiera con cuenta puede fabricar la
 * suya: un enlace así dejaba a quien lo abriera dentro de la cuenta de OTRO, y
 * lo que apuntara a partir de ahí acababa en ella (fase 2 de seguridad). Un
 * `token_hash` lo emite solo un administrador, y un `code` PKCE no se canjea
 * sin el verificador que guardó este mismo navegador.
 */
export default function InvitacionPage() {
  return (
    <Suspense fallback={<div className="h-40 esqueleto rounded-lg" />}>
      <Invitacion />
    </Suspense>
  );
}

type Estado =
  /** Mirando qué trae la URL, sin canjear nada. */
  | "comprobando"
  /** Hay enlace (o sesión): la bienvenida con el botón «Empezar». */
  | "bienvenida"
  /** Canjeando el enlace tras pulsar «Empezar». */
  | "canjeando"
  /** Quien ya tenía cuenta y segundo factor: tiene que superarlo antes. */
  | "necesita-factor"
  | "contrasena"
  | "invalido"
  /** Se abrió /invitacion sin enlace. */
  | "sin-enlace";

/**
 * `red`: el fallo fue de conexión. Entonces el enlace NO se ha gastado (la
 * petición no llegó), y lo que toca es reintentar, no decir que caducó.
 */
type Resultado = { ok: true } | { ok: false; red?: boolean };

function fallo(error: { message?: string } | null): Resultado {
  return { ok: false, red: /network|fetch|failed to fetch|load failed/i.test(error?.message ?? "") };
}

const TIPOS_OTP = ["invite", "recovery", "magiclink", "signup", "email"] as const;
type TipoOtp = (typeof TIPOS_OTP)[number];

function fragmento(): URLSearchParams {
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

function Invitacion() {
  const router = useRouter();
  /*
   * La consulta TAL COMO LLEGÓ, congelada. Al canjear se limpia la URL (el
   * token no tiene por qué quedarse en el historial), y eso cambia
   * `useSearchParams`: si la página reaccionara, volvería a la bienvenida a
   * mitad del recorrido, ya sin enlace.
   */
  const consulta = useSearchParams();
  const [params] = useState(consulta);
  const [estado, setEstado] = useState<Estado>("comprobando");
  const [motivo, setMotivo] = useState<string | null>(null);
  const [cuenta, setCuenta] = useState<string | null>(null);
  const [esRecuperacion, setEsRecuperacion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * UNA sola instancia para toda la página.
   *
   * Antes se llamaba a createClient() en cada sitio, y la que establecía la
   * sesión no era la misma que luego guardaba la contraseña. La segunda no
   * llevaba sesión, así que la petición salía sin autenticar y se perdía sin
   * dar error: la pantalla decía que todo había ido bien y la contraseña nunca
   * llegaba a cambiar.
   */
  const supabase = useMemo(() => createClient(), []);

  // ── Al cargar: solo MIRAR la URL ──────────────────────────────────────────
  useEffect(() => {
    let vivo = true;
    (async () => {
      const hash = fragmento();
      // Supabase manda los fallos en la propia URL (enlace caducado, gastado).
      // De ahí solo se lee el CÓDIGO, que se traduce a un texto fijo: el
      // `error_description` lo puede escribir cualquiera que fabrique el enlace,
      // y enseñarlo tal cual dejaba poner texto propio en nuestra página.
      const codigo = hash.get("error_code") ?? params.get("error_code");
      const hayError =
        hash.get("error") ||
        params.get("error") ||
        codigo ||
        hash.get("error_description") ||
        params.get("error_description");
      if (hayError) {
        setMotivo(detalleDeEnlace(codigo));
        setEstado("invalido");
        return;
      }

      const tipo = params.get("type") ?? hash.get("type");
      setEsRecuperacion(tipo === "recovery");

      const trae = (params.get("token_hash") && params.get("type")) || params.get("code");
      if (trae) {
        setEstado("bienvenida");
        return;
      }

      // Sin enlace en la URL: puede que ya se canjeara antes (se recargó la
      // página a medias). Con sesión se puede seguir; sin ella, no hay nada.
      const { data } = await supabase.auth.getSession();
      if (!vivo) return;
      setEstado(data.session ? "bienvenida" : "sin-enlace");
    })();
    return () => {
      vivo = false;
    };
  }, [params, supabase]);

  // ── Al pulsar «Empezar»: canjear ──────────────────────────────────────────
  async function canjear(): Promise<Resultado> {
    /*
     * ORDEN IMPORTANTE: primero las credenciales de la URL, después la sesión
     * que hubiera guardada. Al revés, una sesión de un intento anterior tapaba
     * el enlace nuevo y la página razonaba sobre una sesión vieja. Quien trae un
     * enlace en la mano viene a usarlo: manda la URL.
     */

    // 1) El enlace de Cartera: token sin canjear.
    const tokenHash = params.get("token_hash");
    const tipo = params.get("type");
    if (tokenHash && tipo) {
      if (!TIPOS_OTP.includes(tipo as TipoOtp)) return { ok: false };
      const { error: otpErr } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: tipo as TipoOtp,
      });
      if (otpErr) return fallo(otpErr);
      // El token ya no vale, pero no tiene por qué quedarse en el historial.
      window.history.replaceState(null, "", window.location.pathname);
      return { ok: true };
    }

    // 2) Flujo PKCE: un código que hay que canjear. (El implícito, con la
    //    sesión en el fragmento, no se acepta: ver el comentario de arriba.)
    const code = params.get("code");
    if (code) {
      const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
      if (exErr) return fallo(exErr);
      return { ok: true };
    }

    // 3) Sin credenciales: la sesión que ya hubiera.
    const { data } = await supabase.auth.getSession();
    return data.session ? { ok: true } : { ok: false };
  }

  async function empezar() {
    setError(null);
    setEstado("canjeando");
    // Una excepción (la red, sobre todo) no puede dejar el botón girando para
    // siempre: se trata como fallo de conexión, que se puede reintentar.
    const resultado = await canjear().catch(
      (e: unknown): Resultado => fallo(e instanceof Error ? e : { message: "network" }),
    );
    if (!resultado.ok) {
      if (resultado.red) {
        setError("No se ha podido conectar. Revisa tu conexión y vuelve a pulsar «Empezar».");
        setEstado("bienvenida");
        return;
      }
      setEstado("invalido");
      return;
    }

    const { data: sesion } = await supabase.auth.getSession();
    setCuenta(sesion.session?.user.email ?? null);

    /*
     * Con el segundo factor ya dado de alta, Supabase exige haberlo superado
     * para poder cambiar la contraseña. El enlace solo da sesión de primer
     * nivel, así que quien tenga factor y no tenga contraseña se quedaría
     * encerrado: no puede entrar porque no sabe la contraseña, y no puede
     * ponerla porque le falta el segundo factor. Se le pide aquí, antes de la
     * contraseña, y el nudo se deshace.
     */
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    setEstado(
      aal?.currentLevel !== "aal2" && aal?.nextLevel === "aal2" ? "necesita-factor" : "contrasena",
    );
  }

  const alSuperarFactor = useCallback(() => setEstado("contrasena"), []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const clave = String(form.get("password") ?? "");
    const repetida = String(form.get("password2") ?? "");

    if (clave.length < 12) {
      setError("Usa al menos 12 caracteres. Es tu dinero: merece una contraseña larga.");
      return;
    }
    if (clave !== repetida) {
      setError("Las dos contraseñas no coinciden.");
      return;
    }

    setBusy(true);
    const { data, error: updateError } = await supabase.auth.updateUser({ password: clave });

    if (updateError) {
      setError(authErrorMessage(updateError));
      setBusy(false);
      return;
    }

    // No basta con que no haya error: si la petición saliera sin sesión, la API
    // no devolvería usuario y el cambio se habría perdido en silencio.
    if (!data?.user) {
      setError("No se ha podido guardar la contraseña. Abre otra vez el enlace.");
      setBusy(false);
      return;
    }

    // Quien ya tenía segundo factor (y lo acaba de superar) ha terminado; los
    // demás pasan al paso 2, proteger la cuenta, que es opcional.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    router.replace(aal?.currentLevel === "aal2" ? "/resumen" : "/2fa/alta?desde=invitacion");
    router.refresh();
  }

  // ── Pantallas ─────────────────────────────────────────────────────────────

  if (estado === "comprobando") {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <div className="h-7 w-2/3 esqueleto rounded-sm" />
        <div className="h-32 esqueleto rounded-lg" />
        <span className="sr-only">Comprobando el enlace…</span>
      </div>
    );
  }

  if (estado === "sin-enlace" || estado === "invalido") {
    const caducado = estado === "invalido";
    return (
      <div className="flex flex-col gap-4 text-center">
        <h2 className="text-[22px] leading-7 font-semibold">
          {caducado ? "Este enlace ya no vale" : "Te falta el enlace"}
        </h2>
        <p className="text-[17px] leading-[22px] font-semibold">
          Pide a quien te invitó un enlace nuevo.
        </p>
        <p className="text-[15px] leading-5 text-muted">
          {caducado
            ? "Los enlaces caducan al poco tiempo y solo valen una vez. Si ya lo abriste antes (o lo abrió alguien más), está gastado."
            : "Para entrar en Cartera por primera vez hace falta el enlace de invitación que te mandaron, tal cual, sin recortarlo."}
        </p>
        {caducado && motivo ? (
          <p className="text-[13px] leading-[18px] text-muted">Detalle: {motivo}</p>
        ) : null}
        <ButtonLink href="/entrar" variant="secondary">
          Ya tengo cuenta: entrar
        </ButtonLink>
      </div>
    );
  }

  if (estado === "bienvenida" || estado === "canjeando") {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h2 className="text-[24px] leading-[30px] font-semibold">
            {esRecuperacion ? "Vuelve a entrar en Cartera" : "Te han invitado a Cartera"}
          </h2>
          <p className="text-[15px] leading-5 text-muted">
            {esRecuperacion
              ? "Con este enlace eliges una contraseña nueva para tu cuenta."
              : "Cartera es una app privada para llevar tus cuentas, tus gastos y tus inversiones en un solo sitio. Solo entra quien recibe una invitación."}
          </p>
        </div>

        {esRecuperacion ? null : (
          <ol className="flex flex-col gap-3" aria-label="Lo que vas a hacer">
            {[
              ["Elige una contraseña", "Solo la sabrás tú."],
              [
                "Protege tu cuenta (recomendado)",
                "Con un código que genera tu móvil: así nadie entra aunque sepa tu contraseña. Puedes dejarlo para luego.",
              ],
              ["Listo", "Son dos minutos."],
            ].map(([titulo, detalle], i) => (
              <li key={titulo} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[13px] font-semibold tabular-nums"
                >
                  {i + 1}
                </span>
                <span className="flex flex-col pt-[3px]">
                  <span className="text-[15px] leading-5 font-semibold">{titulo}</span>
                  <span className="text-[13px] leading-[18px] text-muted">{detalle}</span>
                </span>
              </li>
            ))}
          </ol>
        )}

        <div className="flex flex-col gap-3">
          <Button
            onClick={empezar}
            disabled={estado === "canjeando"}
            className="lg:h-[50px] lg:text-[17px]"
          >
            {estado === "canjeando" ? "Un momento…" : "Empezar"}
          </Button>
          <FieldError>{error}</FieldError>
        </div>
      </div>
    );
  }

  if (estado === "necesita-factor") {
    return (
      <VerificarSegundoFactor
        supabase={supabase}
        contexto="invitacion"
        onVerificado={alSuperarFactor}
      />
    );
  }

  // ── Paso 1: la contraseña ─────────────────────────────────────────────────
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      {esRecuperacion ? null : <PasosAcceso actual={1} />}

      <div className="flex flex-col gap-1">
        <h2 className="text-[22px] leading-7 font-semibold">Elige tu contraseña</h2>
        <p className="text-[15px] leading-5 text-muted">
          {cuenta ? (
            <>
              Para <span className="font-semibold text-fg">{cuenta}</span>. Solo la sabrás tú.
            </>
          ) : (
            "Solo la sabrás tú."
          )}
        </p>
      </div>

      {/*
        El usuario, oculto, para el llavero. Sin un campo `username` junto a la
        contraseña nueva, el llavero de iCloud (y el de Chrome) guarda la clave
        sin cuenta asociada, y luego no la ofrece en /entrar. Va fuera de la
        vista pero no `display:none`, que algunos gestores ignoran.
      */}
      <input
        type="email"
        name="username"
        autoComplete="username"
        value={cuenta ?? ""}
        readOnly
        tabIndex={-1}
        aria-label="Correo de tu cuenta"
        className="sr-only"
      />

      <div className="flex flex-col gap-[6px]">
        <Label htmlFor="password">Contraseña</Label>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={12}
          autoFocus
          placeholder="Al menos 12 caracteres"
        />
      </div>

      <div className="flex flex-col gap-[6px]">
        <Label htmlFor="password2">Repítela</Label>
        <PasswordInput
          id="password2"
          name="password2"
          autoComplete="new-password"
          required
          minLength={12}
          placeholder="Otra vez"
        />
      </div>

      <FieldError>{error}</FieldError>

      <Button type="submit" disabled={busy} className="lg:h-[50px] lg:text-[17px]">
        {busy ? "Guardando…" : "Continuar"}
      </Button>
    </form>
  );
}
