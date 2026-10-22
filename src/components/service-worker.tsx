"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
// El icono suelto y no `ui/icon`: este componente va en la raíz (también en
// /entrar y /sin-conexion), y el mapa de iconos pesaría en todas.
import { X } from "lucide-react";

/** Cada cuánto, como mucho, se pregunta al servidor si hay un despliegue nuevo. */
const MINUTOS_ENTRE_COMPROBACIONES = 15;

/**
 * Registra el service worker, que es lo que permite instalar la app y que
 * arranque sin conexión. Solo en producción: en desarrollo estorbaría al
 * recargado en caliente.
 *
 * Avisa de las versiones nuevas. Cada despliegue publica un `/sw.js` con otros
 * bytes (ver `src/app/sw.js/route.ts`); el navegador lo descarga, lo instala y
 * lo deja ESPERANDO. Entonces sale «Hay una versión nueva · Actualizar», y solo
 * al pulsarlo el nuevo toma el relevo y la página se recarga. Nunca se recarga
 * sola: a mitad de un formulario, una recarga perdería lo escrito. Mientras
 * tanto la app sigue funcionando con la versión que cargó.
 *
 * Una PWA puede pasarse días abierta sin navegar a nada nuevo, así que además
 * se pregunta por la versión al volver a la app (como mucho cada
 * `MINUTOS_ENTRE_COMPROBACIONES`): `registration.update()` es una petición a
 * `/sw.js`, que es estático.
 *
 * Y escucha al service worker cuando pide llevar la app a una pantalla. Al
 * tocar una notificación, el service worker intenta navegar él mismo; si no
 * puede —en una PWA instalada `navigate` puede rechazar—, manda este mensaje y
 * navega la propia app.
 */
export function ServiceWorker() {
  const router = useRouter();
  const [esperando, setEsperando] = useState<ServiceWorker | null>(null);
  const [descartado, setDescartado] = useState(false);
  const actualizando = useRef(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const alMensaje = (evento: MessageEvent) => {
      const datos = evento.data;
      if (datos && datos.tipo === "ir-a" && typeof datos.url === "string") {
        router.push(datos.url);
      }
    };

    navigator.serviceWorker.addEventListener("message", alMensaje);
    return () => navigator.serviceWorker.removeEventListener("message", alMensaje);
  }, [router]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const sw = navigator.serviceWorker;
    let registro: ServiceWorkerRegistration | null = null;
    let ultimaComprobacion = Date.now();
    let cancelado = false;

    // Solo hay «versión nueva» si ya había una controlando la página; la
    // primera instalación no es una actualización.
    const vigilar = (nuevo: ServiceWorker | null) => {
      if (!nuevo) return;
      const comprobar = () => {
        if (nuevo.state === "installed" && sw.controller && !cancelado) setEsperando(nuevo);
      };
      comprobar();
      nuevo.addEventListener("statechange", comprobar);
    };

    const alEncontrar = () => vigilar(registro?.installing ?? null);

    // Al pulsar «Actualizar», el nuevo toma el control: entonces, y solo
    // entonces, se recarga.
    const alCambiarControl = () => {
      if (actualizando.current) window.location.reload();
    };

    const alVolver = () => {
      if (document.visibilityState !== "visible" || !registro) return;
      if (Date.now() - ultimaComprobacion < MINUTOS_ENTRE_COMPROBACIONES * 60_000) return;
      ultimaComprobacion = Date.now();
      registro.update().catch(() => {
        // Sin red no hay versión que buscar; ya se intentará.
      });
    };

    const registrar = () => {
      sw.register("/sw.js")
        .then((r) => {
          if (cancelado) return;
          registro = r;
          vigilar(r.waiting);
          vigilar(r.installing);
          r.addEventListener("updatefound", alEncontrar);
        })
        .catch(() => {
          // Que falle el registro no puede tumbar la app: sin él simplemente no
          // habrá modo sin conexión.
        });
    };

    sw.addEventListener("controllerchange", alCambiarControl);
    document.addEventListener("visibilitychange", alVolver);
    if (document.readyState === "complete") registrar();
    else window.addEventListener("load", registrar);

    return () => {
      cancelado = true;
      sw.removeEventListener("controllerchange", alCambiarControl);
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("load", registrar);
      registro?.removeEventListener("updatefound", alEncontrar);
    };
  }, []);

  if (!esperando || descartado) return null;

  return (
    /*
      Flota sobre la barra de pestañas en móvil y en la esquina en escritorio:
      es lo único de la pantalla que va encima de todo, así que lleva la sombra
      de lo que flota. Entra con un fundido y un empujón corto (@starting-style,
      interrumpible); con movimiento reducido, solo el fundido.
    */
    <div
      role="status"
      className={[
        "fixed inset-x-4 bottom-[calc(64px+env(safe-area-inset-bottom))] z-50 mx-auto max-w-sm",
        "lg:inset-x-auto lg:right-6 lg:bottom-6 lg:mx-0",
        "flex items-center gap-3 rounded-lg hair border-hairline bg-surface py-2 pr-2 pl-4 shadow-overlay",
        "transition-[opacity,translate] duration-200 ease-out",
        "starting:translate-y-2 starting:opacity-0 motion-reduce:starting:translate-y-0",
      ].join(" ")}
    >
      <p className="min-w-0 flex-1 text-[15px] leading-5">Hay una versión nueva</p>
      <button
        type="button"
        onClick={() => {
          actualizando.current = true;
          esperando.postMessage({ tipo: "activar" });
        }}
        className="pulsable toque relative h-9 shrink-0 rounded-sm px-3 text-[15px] font-semibold text-accent-text"
      >
        Actualizar
      </button>
      <button
        type="button"
        aria-label="Ahora no"
        onClick={() => setDescartado(true)}
        className="pulsable toque relative flex size-9 shrink-0 items-center justify-center rounded-full text-muted"
      >
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}
