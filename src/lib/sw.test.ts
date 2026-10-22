import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * El service worker (`src/sw/service-worker.js`, que sirve la ruta `/sw.js` con
 * la versión del despliegue delante) con un navegador de mentira alrededor:
 * `self`, `caches` y `fetch` simulados. Lo que se vigila es lo que NUNCA debe
 * pasar —guardar una página con datos de una persona, una respuesta de la API o
 * de otro origen, un error, una redirección o algo marcado privado—, que un
 * icono nuevo llegue sin tener que subir la versión, que la página sin conexión
 * se guarde CON lo que necesita para arrancar y que una versión nueva espere a
 * que la persona pulse «Actualizar».
 */

const FUENTE = readFileSync("src/sw/service-worker.js", "utf8");
const CODIGO = `const VERSION = "cartera-prueba";\n${FUENTE}`;
const ORIGEN = "https://cartera.test";

type Respuesta = {
  ok: boolean;
  status: number;
  type: string;
  redirected: boolean;
  headers: Headers;
  cuerpo: string;
  clone: () => Respuesta;
  text: () => Promise<string>;
};

function respuesta(
  cuerpo: string,
  extra: Partial<Omit<Respuesta, "headers" | "clone" | "text">> & { cacheControl?: string } = {},
): Respuesta {
  const { cacheControl, ...resto } = extra;
  const r: Respuesta = {
    ok: true,
    status: 200,
    type: "basic",
    redirected: false,
    headers: new Headers(cacheControl ? { "Cache-Control": cacheControl } : {}),
    cuerpo,
    clone: () => ({ ...r }),
    text: async () => r.cuerpo,
    ...resto,
  };
  if (r.status >= 400) r.ok = false;
  return r;
}

type Peticion = { url: string; method: string; mode: string };
const peticion = (ruta: string, extra: Partial<Peticion> = {}): Peticion => ({
  url: ruta.startsWith("http") ? ruta : `${ORIGEN}${ruta}`,
  method: "GET",
  mode: "no-cors",
  ...extra,
});

function cargar(
  red: (p: Peticion) => Promise<Respuesta>,
  { activo = false }: { activo?: boolean } = {},
) {
  const oyentes: Record<string, (evento: unknown) => void> = {};
  const almacen = new Map<string, Respuesta>();
  // El service worker pide a veces con una cadena (`fetch("/sin-conexion")`):
  // se normaliza a petición para que la red de mentira vea siempre lo mismo.
  const fetch = vi.fn((p: Peticion | string) => red(typeof p === "string" ? peticion(p) : p));
  const clave = (p: Peticion | string) => (typeof p === "string" ? `${ORIGEN}${p}` : p.url);
  const match = async (p: Peticion | string) => almacen.get(clave(p));
  const caches = {
    open: async () => ({
      put: async (p: Peticion | string, r: Respuesta) => {
        almacen.set(clave(p), r);
      },
      add: async (p: string) => {
        const r = await fetch(p);
        if (!r.ok) throw new TypeError("add: respuesta no válida");
        almacen.set(clave(p), r);
      },
      match,
    }),
    match,
    keys: async () => [],
    delete: async () => true,
  };
  const skipWaiting = vi.fn(() => Promise.resolve());
  const self = {
    addEventListener: (tipo: string, f: (evento: unknown) => void) => (oyentes[tipo] = f),
    location: { origin: ORIGEN },
    registration: { active: activo ? {} : null },
    skipWaiting,
    clients: { claim: () => Promise.resolve() },
  };
  runInNewContext(CODIGO, { self, caches, fetch, URL, Response, Promise, Headers });

  /** Lanza la instalación y espera a que termine (o falle). */
  async function instalar() {
    let espera: Promise<unknown> = Promise.resolve();
    oyentes.install({ waitUntil: (x: Promise<unknown>) => (espera = x) });
    await espera.catch(() => {});
  }

  async function pedir(p: Peticion) {
    let respondida: Promise<Respuesta> | undefined;
    const esperas: Promise<unknown>[] = [];
    oyentes.fetch({
      request: p,
      respondWith: (x: Promise<Respuesta>) => (respondida = Promise.resolve(x)),
      waitUntil: (x: Promise<unknown>) => esperas.push(x),
    });
    const r = respondida ? await respondida : undefined;
    // Las escrituras en segundo plano se encadenan: se espera hasta que no
    // quede ninguna pendiente.
    for (let vistas = -1; vistas !== esperas.length; ) {
      vistas = esperas.length;
      await Promise.allSettled(esperas);
      await new Promise((fin) => setTimeout(fin, 0));
    }
    return { interceptada: respondida !== undefined, respuesta: r };
  }

  return { oyentes, almacen, fetch, pedir, instalar, skipWaiting };
}

/** La página sin conexión, con referencias a sus recursos como las pone Next. */
const PAGINA_SIN_CONEXION = [
  '<html><head><link rel="stylesheet" href="/_next/static/chunks/estilo.css">',
  '<link rel="preload" href="/_next/static/media/inter.woff2" as="font">',
  '<script src="/_next/static/chunks/arranque.js" async=""></script></head>',
  '<body><h1>No hay conexión</h1>',
  '<script>self.__next_f.push([1,"1:I[\\"123\\",[\\"/_next/static/chunks/pagina.js\\"],\\"default\\"]"])</script>',
  "</body></html>",
].join("");

describe("service worker", () => {
  it("la versión la pone el despliegue, no el fichero", () => {
    // Si el fichero declarara su propia versión, chocaría con la que antepone
    // la ruta `/sw.js` y el service worker no arrancaría.
    expect(FUENTE).not.toMatch(/^\s*(const|let|var)\s+VERSION\b/m);
    const ruta = readFileSync("src/app/sw.js/route.ts", "utf8");
    expect(ruta).toMatch(/const VERSION = \$\{JSON\.stringify/);
    expect(ruta).toMatch(/src\/sw\/service-worker\.js/);
  });

  it("al instalarse guarda la página sin conexión Y lo que necesita para arrancar", async () => {
    const sw = cargar(async (p) =>
      p.url.endsWith("/sin-conexion")
        ? respuesta(PAGINA_SIN_CONEXION, { cacheControl: "private, no-cache, no-store" })
        : respuesta(`contenido de ${p.url}`),
    );
    await sw.instalar();
    for (const ruta of [
      "/sin-conexion",
      "/_next/static/chunks/estilo.css",
      "/_next/static/media/inter.woff2",
      "/_next/static/chunks/arranque.js",
      // El chunk de la página va DENTRO de la carga de React, entre comillas
      // escapadas: era el que faltaba y tumbaba la hidratación sin red.
      "/_next/static/chunks/pagina.js",
    ]) {
      expect(sw.almacen.has(`${ORIGEN}${ruta}`), ruta).toBe(true);
    }
  });

  it("un recurso que falla no deja sin guardar la página", async () => {
    const sw = cargar(async (p) =>
      p.url.endsWith("/sin-conexion")
        ? respuesta(PAGINA_SIN_CONEXION)
        : p.url.endsWith("pagina.js")
          ? respuesta("no", { status: 500 })
          : respuesta("ok"),
    );
    await sw.instalar();
    expect(sw.almacen.has(`${ORIGEN}/sin-conexion`)).toBe(true);
    expect(sw.almacen.has(`${ORIGEN}/_next/static/chunks/pagina.js`)).toBe(false);
  });

  it("la primera instalación se activa sola; una versión nueva ESPERA a «Actualizar»", async () => {
    const red = async () => respuesta(PAGINA_SIN_CONEXION);
    const primera = cargar(red);
    await primera.instalar();
    expect(primera.skipWaiting).toHaveBeenCalledTimes(1);

    const nueva = cargar(red, { activo: true });
    await nueva.instalar();
    expect(nueva.skipWaiting).not.toHaveBeenCalled();
    nueva.oyentes.message({ data: { tipo: "activar" } });
    expect(nueva.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("una página de la app va a la red y NO se guarda", async () => {
    const sw = cargar(async () => respuesta("<html>tu saldo</html>"));
    const { interceptada, respuesta: r } = await sw.pedir(peticion("/resumen", { mode: "navigate" }));
    expect(interceptada).toBe(true);
    expect(r?.cuerpo).toBe("<html>tu saldo</html>");
    expect(sw.almacen.has(`${ORIGEN}/resumen`)).toBe(false);
  });

  it("sin red, la navegación recibe la página de cortesía", async () => {
    let hayRed = true;
    const sw = cargar(async () => {
      if (!hayRed) throw new TypeError("sin red");
      return respuesta(PAGINA_SIN_CONEXION);
    });
    await sw.instalar();
    hayRed = false;
    const { respuesta: r } = await sw.pedir(peticion("/movimientos", { mode: "navigate" }));
    expect(r?.cuerpo).toBe(PAGINA_SIN_CONEXION);
    // Y su chunk sale de la caché, sin red.
    const chunk = await sw.pedir(peticion("/_next/static/chunks/pagina.js"));
    expect(chunk.respuesta?.ok).toBe(true);
  });

  it.each([
    ["la API", peticion("/api/exportar")],
    ["la autenticación", peticion("/auth/callback")],
    ["otro origen (Supabase)", peticion("https://xyz.supabase.co/rest/v1/transaction")],
    ["un POST", peticion("/icono-192.png", { method: "POST" })],
    ["los datos de una página (RSC)", peticion("/resumen?_rsc=abc")],
  ])("no intercepta %s", async (_, p) => {
    const sw = cargar(async () => respuesta("x"));
    const { interceptada } = await sw.pedir(p);
    expect(interceptada).toBe(false);
    expect(sw.almacen.size).toBe(0);
  });

  it("los estáticos con hash salen de la caché a la segunda", async () => {
    const sw = cargar(async () => respuesta("chunk", { cacheControl: "public, max-age=31536000, immutable" }));
    const p = peticion("/_next/static/chunks/a1b2.js");
    await sw.pedir(p);
    const { respuesta: r } = await sw.pedir(p);
    expect(r?.cuerpo).toBe("chunk");
    expect(sw.fetch).toHaveBeenCalledTimes(1);
  });

  it("un icono se sirve de la caché y se revalida: el logo nuevo llega a la siguiente", async () => {
    let version = "logo viejo";
    const sw = cargar(async () => respuesta(version));
    const p = peticion("/icono-192.png");

    expect((await sw.pedir(p)).respuesta?.cuerpo).toBe("logo viejo");

    version = "logo nuevo";
    // Al instante, lo guardado; por detrás, ya se ha pedido el nuevo…
    expect((await sw.pedir(p)).respuesta?.cuerpo).toBe("logo viejo");
    expect(sw.fetch).toHaveBeenCalledTimes(2);
    // …y la visita siguiente lo ve.
    expect((await sw.pedir(p)).respuesta?.cuerpo).toBe("logo nuevo");
  });

  it("el manifiesto también se revalida", async () => {
    const sw = cargar(async () => respuesta("{}"));
    const p = peticion("/manifest.webmanifest");
    await sw.pedir(p);
    await sw.pedir(p);
    expect(sw.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["un 404", respuesta("no", { status: 404 })],
    ["un 500", respuesta("no", { status: 500 })],
    ["una redirección (p. ej. a /entrar)", respuesta("<html>entrar</html>", { redirected: true })],
    ["una respuesta opaca", respuesta("", { type: "opaque" })],
    ["una respuesta CORS", respuesta("x", { type: "cors" })],
    ["algo marcado no-store", respuesta("x", { cacheControl: "no-store" })],
    ["algo marcado private", respuesta("x", { cacheControl: "private, max-age=60" })],
  ])("no guarda %s", async (_, r) => {
    const sw = cargar(async () => r);
    await sw.pedir(peticion("/icono-512.png"));
    await sw.pedir(peticion("/_next/static/chunks/c3.js"));
    expect(sw.almacen.size).toBe(0);
  });
});
