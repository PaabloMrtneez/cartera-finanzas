/**
 * Service worker de Cartera.
 *
 * Deliberadamente conservador. El servidor es SIEMPRE la única fuente de
 * verdad: aquí no se guarda ni un dato financiero. iOS puede vaciar el
 * almacenamiento de una app web que lleve semanas sin usarse, así que cualquier
 * cosa que viviera solo aquí acabaría perdiéndose sin avisar.
 *
 * Lo único que se cachea:
 *
 *   · los ficheros estáticos del build (`/_next/static/`), que llevan hash en el
 *     nombre y por tanto nunca quedan obsoletos: primero la caché;
 *   · los iconos y el manifiesto, que NO llevan hash: se sirven de la caché al
 *     instante y se revalidan con la red en segundo plano, así que un logo nuevo
 *     llega en la visita siguiente sin tener que subir la versión;
 *   · la página de cortesía para cuando no hay conexión, CON lo que necesita
 *     para arrancar (sus scripts, su CSS y sus fuentes).
 *
 * Y nunca: HTML de la app (las páginas llevan datos de una persona), respuestas
 * de `/api/` o de `/auth/`, nada de otro origen (Supabase incluido), nada que no
 * llegara bien, nada que viniera de una redirección y nada que el servidor
 * marque `no-store` o `private`.
 *
 * ESTE FICHERO NO SE SIRVE TAL CUAL. Lo sirve la ruta `src/app/sw.js/route.ts`,
 * que le antepone `const VERSION = "cartera-<despliegue>";`. Así cada despliegue
 * publica un service worker con otros bytes: el navegador lo detecta como
 * versión nueva, la app avisa («Hay una versión nueva · Actualizar») y la caché
 * del despliegue anterior se vacía al activarse el nuevo. Antes la versión era
 * una constante escrita a mano que no cambiaba entre despliegues.
 */

/* global VERSION */
const OFFLINE_URL = "/sin-conexion";

/**
 * Los recursos del build que referencia una página: sus scripts, su CSS y sus
 * fuentes, en los atributos y dentro de la carga de React (donde van entre
 * comillas escapadas). Todos viven en `/_next/static/` y llevan hash.
 */
function recursosDe(html) {
  const encontrados = html.match(/\/_next\/static\/[^"'\\\s)<>]+/g) || [];
  return [...new Set(encontrados)];
}

/**
 * Guarda la página sin conexión Y todo lo que necesita para arrancar.
 *
 * Antes solo se guardaba su HTML. Sin red, el navegador pintaba ese HTML pero
 * al hidratar pedía un chunk de JavaScript que nunca se había descargado, y la
 * app reventaba con `ChunkLoadError` («La app no ha podido arrancar»). Ahora se
 * lee el HTML y se guardan también sus recursos, cada uno por separado: que
 * falle uno no deja sin guardar la página.
 */
function guardarPaginaSinConexion() {
  return caches.open(VERSION).then((cache) =>
    fetch(OFFLINE_URL, { cache: "reload" }).then((respuesta) => {
      // Aquí no vale `guardable`: la página es dinámica y Next la marca
      // `private, no-store`, pero no lleva ningún dato de nadie y es justo lo
      // que hay que guardar. Basta con que haya llegado bien y sin redirigir.
      if (!respuesta.ok || respuesta.redirected) {
        throw new Error("No se ha podido descargar la página sin conexión");
      }
      return respuesta
        .clone()
        .text()
        .then((html) =>
          cache.put(OFFLINE_URL, respuesta).then(() =>
            Promise.all(
              recursosDe(html).map((url) =>
                cache.match(url).then((ya) => ya || cache.add(url).catch(() => {})),
              ),
            ),
          ),
        );
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    guardarPaginaSinConexion().then(() => {
      // La PRIMERA vez no hay nada que respetar: se activa ya. Si ya hay uno
      // activo, el nuevo ESPERA: la app avisa «Hay una versión nueva ·
      // Actualizar» y es la persona quien decide cuándo; nunca se recarga sola
      // a mitad de un formulario. Ver `src/components/service-worker.tsx`.
      if (!self.registration || !self.registration.active) return self.skipWaiting();
    }),
  );
});

// «Actualizar»: la app pide al que espera que tome el relevo.
self.addEventListener("message", (event) => {
  if (event.data && event.data.tipo === "activar") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/**
 * ¿Se puede guardar esta respuesta?
 *
 *   · `ok`: un 404 o un 500 guardado aquí se serviría ya para siempre.
 *   · `basic`: del mismo origen y legible (ni opaca ni CORS).
 *   · sin redirección: si el proxy mandara un icono a /entrar, se guardaría el
 *     HTML de la pantalla de acceso con el nombre del icono.
 *   · sin `no-store` ni `private`: el servidor dice que no es para guardar.
 */
function guardable(respuesta) {
  if (!respuesta || !respuesta.ok || respuesta.type !== "basic" || respuesta.redirected) return false;
  const cacheControl = respuesta.headers.get("Cache-Control") || "";
  return !/no-store|private/i.test(cacheControl);
}

/** Guarda una copia sin retrasar la respuesta. */
function guardar(event, request, respuesta) {
  if (!guardable(respuesta)) return;
  const copia = respuesta.clone();
  const escritura = caches
    .open(VERSION)
    .then((cache) => cache.put(request, copia))
    .catch(() => {});
  try {
    event.waitUntil(escritura);
  } catch {
    // El evento ya terminó: la escritura sigue su curso igualmente.
  }
}

/** A la red, guardando lo que llegue bien. */
function deLaRed(event, request) {
  return fetch(request).then((respuesta) => {
    guardar(event, request, respuesta);
    return respuesta;
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Nada de la API ni de la autenticación se cachea jamás.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Estáticos del build: llevan hash, así que la caché nunca miente.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(caches.match(request).then((guardada) => guardada || deLaRed(event, request)));
    return;
  }

  // Iconos y manifiesto: lo guardado al instante y, a la vez, se pide a la red
  // para la próxima vez. Sin nada guardado, la red; sin red, lo guardado.
  if (/\.(png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((guardada) => {
        const red = deLaRed(event, request);
        if (!guardada) return red;
        event.waitUntil(red.catch(() => {}));
        return guardada;
      }),
    );
    return;
  }

  // Navegación: siempre a la red, y lo que vuelve NO se guarda (lleva datos de
  // una persona). Si no hay red, la página de cortesía.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((pagina) => pagina ?? Response.error()),
      ),
    );
  }
});

/* -------------------------------------------------------------------------
   Notificaciones push.

   En el iPhone solo llegan si la app está instalada en la pantalla de inicio;
   desde una pestaña de Safari, no.
------------------------------------------------------------------------- */

self.addEventListener("push", (event) => {
  let datos = {};
  try {
    datos = event.data ? event.data.json() : {};
  } catch {
    datos = { title: "Cartera", body: event.data ? event.data.text() : "" };
  }

  const titulo = datos.title || "Cartera";
  const opciones = {
    body: datos.body || "",
    icon: "/icono-192.png",
    badge: "/icono-192.png",
    lang: "es-ES",
    // Agrupar por etiqueta evita apilar cinco avisos del mismo límite.
    tag: datos.tag || "cartera",
    renotify: Boolean(datos.renotify),
    data: { url: datos.url || "/resumen" },
  };

  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destino = (event.notification.data && event.notification.data.url) || "/resumen";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (ventanas) => {
        // Si la app ya está abierta, se reutiliza en lugar de abrir otra.
        for (const ventana of ventanas) {
          if (!ventana.url.includes(self.location.origin)) continue;

          // `navigate` no siempre está disponible ni siempre funciona: en una
          // PWA instalada puede rechazar si la ventana no está controlada por
          // este service worker. Sin la reserva, el toque no hacía nada.
          try {
            if (typeof ventana.navigate === "function") {
              const movida = await ventana.navigate(destino);
              return (movida || ventana).focus();
            }
          } catch {
            // Se intenta enfocar y avisar a la app por mensaje, que es lo que
            // queda cuando el service worker no puede navegar por ella.
          }

          try {
            ventana.postMessage({ tipo: "ir-a", url: destino });
          } catch {
            // Sin canal de mensajes, al menos se trae la app al frente.
          }
          return ventana.focus();
        }

        return self.clients.openWindow(destino);
      }),
  );
});
