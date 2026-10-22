"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Grupo } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { FieldError } from "@/components/ui/input";

type Estado = "comprobando" | "no-soportado" | "sin-instalar" | "denegado" | "apagado" | "activo";

/**
 * La clave pública viene en base64 «url-safe» y la API de push la quiere en
 * bytes. Se reserva el ArrayBuffer explícitamente porque `applicationServerKey`
 * no admite un Uint8Array que pudiera estar respaldado por memoria compartida.
 */
function base64UrlABytes(base64: string): Uint8Array<ArrayBuffer> {
  const relleno = "=".repeat((4 - (base64.length % 4)) % 4);
  const normal = (base64 + relleno).replace(/-/g, "+").replace(/_/g, "/");
  const binario = atob(normal);

  const bytes = new Uint8Array(new ArrayBuffer(binario.length));
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

export function PushSettings({
  publicKey,
  suscripciones,
}: {
  publicKey: string | null;
  suscripciones: { id: string; user_agent: string | null; created_at: string }[];
}) {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>("comprobando");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setEstado("no-soportado");
        return;
      }

      // En iOS las notificaciones solo existen si la app está instalada.
      const instalada =
        window.matchMedia("(display-mode: standalone)").matches ||
        // Safari en iOS expone esto en vez del display-mode.
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
      const esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

      if (esIOS && !instalada) {
        setEstado("sin-instalar");
        return;
      }

      if (Notification.permission === "denied") {
        setEstado("denegado");
        return;
      }

      const registro = await navigator.serviceWorker.getRegistration();
      const actual = await registro?.pushManager.getSubscription();
      setEstado(actual ? "activo" : "apagado");
    })();
  }, [suscripciones.length]);

  async function activar() {
    setError(null);
    if (!publicKey) {
      setError("Falta configurar la clave pública de notificaciones en el servidor.");
      return;
    }

    // El permiso y la suscripción del navegador pueden LANZAR (el usuario cierra
    // el aviso del sistema, el servicio de push no responde). Sin esto, el
    // fallo se perdía y el interruptor se quedaba como si nada.
    try {
      const permiso = await Notification.requestPermission();
      if (permiso !== "granted") {
        setEstado(permiso === "denied" ? "denegado" : "apagado");
        return;
      }

      const registro = await navigator.serviceWorker.ready;
      const suscripcion = await registro.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlABytes(publicKey),
      });

      const bruto = suscripcion.toJSON();
      // `@supabase/supabase-js` se carga aquí, no al pintar Ajustes: activar los
      // avisos es una acción puntual y así la pantalla no arrastra el cliente.
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user || !bruto.keys) {
        setError("No se ha podido guardar la suscripción. Vuelve a intentarlo.");
        return;
      }

      const { error: guardarError } = await supabase.from("push_subscription").insert({
        user_id: user.id,
        endpoint: suscripcion.endpoint,
        p256dh: bruto.keys.p256dh,
        auth: bruto.keys.auth,
        user_agent: navigator.userAgent.slice(0, 200),
      });

      if (guardarError && !/duplicate key/i.test(guardarError.message)) {
        console.error("No se pudo guardar la suscripción:", guardarError.message);
        setError("No se ha podido guardar la suscripción. Vuelve a intentarlo.");
        return;
      }

      setEstado("activo");
      router.refresh();
    } catch (e) {
      console.error("No se pudieron activar los avisos:", e);
      setError("No se han podido activar los avisos. Vuelve a intentarlo.");
    }
  }

  async function desactivar() {
    const registro = await navigator.serviceWorker.getRegistration();
    const suscripcion = await registro?.pushManager.getSubscription();

    if (suscripcion) {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      await supabase.from("push_subscription").delete().eq("endpoint", suscripcion.endpoint);
      await suscripcion.unsubscribe();
    }

    setEstado("apagado");
    router.refresh();
  }

  return (
    <Grupo titulo="Avisos en el móvil">
      <p className="px-[18px] pt-4 pb-3 text-[13px] leading-[18px] text-muted">
        Tres cosas y nada más: un gasto del Atajo pendiente de confirmar, un límite que se acerca
        al tope, y el resumen del mes al cerrarlo. Nunca entre las 23:00 y las 08:00.
      </p>

      <div className="flex min-h-[60px] items-center gap-3 hair-t border-separator px-[18px] py-3">
        <Cuerpo estado={estado} />

        {estado === "apagado" ? (
          <Button
            size="compact"
            disabled={pending}
            onClick={() => startTransition(() => void activar())}
          >
            Activar
          </Button>
        ) : estado === "activo" ? (
          <Button
            variant="ghost"
            size="compact"
            className="text-expense"
            disabled={pending}
            onClick={() => startTransition(() => void desactivar())}
          >
            Desactivar
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="px-[18px] pb-3">
          <FieldError>{error}</FieldError>
        </div>
      ) : null}

      {/* Otros dispositivos ya suscritos, para poder limpiar los que sobran. */}
      {suscripciones.length > 1 ? (
        <p className="px-[18px] pb-3 text-[13px] leading-[18px] text-muted">
          Tienes {suscripciones.length} dispositivos recibiendo avisos.
        </p>
      ) : null}
    </Grupo>
  );
}

function Cuerpo({ estado }: { estado: Estado }) {
  const mapa: Record<Estado, { icono: string; titulo: string; detalle: string; tono: string }> = {
    comprobando: {
      icono: "circle-help",
      titulo: "Comprobando…",
      detalle: "Un instante.",
      tono: "text-muted",
    },
    "no-soportado": {
      icono: "triangle-alert",
      titulo: "Este navegador no las admite",
      detalle: "Prueba desde el móvil con la app instalada.",
      tono: "text-muted",
    },
    "sin-instalar": {
      icono: "smartphone",
      titulo: "Primero instala la app",
      detalle:
        "En el iPhone los avisos solo llegan si la añades a la pantalla de inicio desde Safari. Desde una pestaña, no.",
      tono: "text-warning",
    },
    denegado: {
      icono: "lock",
      titulo: "Bloqueados en el navegador",
      detalle:
        "Los denegaste antes. Hay que reactivarlos en los ajustes del sistema o del navegador; desde aquí ya no se puede pedir.",
      tono: "text-expense",
    },
    apagado: {
      icono: "inbox",
      titulo: "Avisos apagados",
      detalle: "Te pedirá permiso una sola vez.",
      tono: "text-muted",
    },
    activo: {
      icono: "check",
      titulo: "Avisos activados",
      detalle: "En este dispositivo.",
      tono: "text-income",
    },
  };

  const info = mapa[estado];

  return (
    <>
      <span
        className={`flex size-[38px] shrink-0 items-center justify-center rounded-full bg-surface-2 ${info.tono}`}
      >
        <Icon name={info.icono} size={19} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] font-semibold">{info.titulo}</span>
        <span className="text-[13px] leading-[18px] text-muted">{info.detalle}</span>
      </span>
    </>
  );
}
