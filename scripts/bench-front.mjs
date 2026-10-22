/**
 * Banco de medición del front de Cartera contra un despliegue real.
 *
 *   node scripts/bench-front.mjs [--base URL] [--sesion sesion-de-prueba.txt]
 *        [--rutas /resumen,/movimientos] [--perfiles movil,escritorio]
 *        [--veces 3] [--salida docs/pruebas/datos/bench.json] [--ttfb 5]
 *
 * Qué hace, pantalla a pantalla y para cada perfil:
 *
 *   · FRÍO: un contexto nuevo (sin caché HTTP ni service worker) navega a la
 *     ruta y mide TTFB, FCP, LCP, CLS, TBT, «interactivo» (fin de la última
 *     tarea larga antes de 5 s de calma), bytes transferidos y nº de peticiones,
 *     separando JS, CSS, fuentes, documentos y peticiones RSC (prefetch).
 *   · CALIENTE: en el mismo contexto, con el service worker ya activo y la
 *     caché llena, vuelve a navegar a la misma ruta y mide lo mismo.
 *
 * Se repite `--veces` (3 por defecto) y se da la MEDIANA. Perfil móvil = 390 ×
 * 844, táctil, CPU 4× más lenta y la red «4G lenta» de Lighthouse (562,5 ms de
 * RTT aplicado, 1,47 Mb/s de bajada, 675 kb/s de subida). Escritorio = 1440 ×
 * 900 sin estrangular.
 *
 * Además (`--ttfb N`) pide N veces el HTML de cada ruta con la cookie de sesión,
 * sin navegador, y da mediana y p90 del tiempo hasta el primer byte y hasta el
 * último: es el coste del servidor (proxy + render + consultas a Supabase).
 *
 * Carga: secuencial, una navegación cada vez. Con las 11 rutas, 2 perfiles y 3
 * vueltas son ~130 documentos más los prefetch; pensado para no estresar
 * producción. Solo con el USUARIO DE PRUEBAS (ver sesion-prod.mjs).
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { argumento, asegurarSesion, BASE_PROD, ESTADO_POR_DEFECTO } from "./sesion-prod.mjs";

const RUTAS_POR_DEFECTO = [
  "/resumen",
  "/movimientos",
  "/movimientos/nuevo",
  "/cuentas",
  "/patrimonio",
  "/inversiones",
  "/fijos",
  "/prestamos",
  "/metas",
  "/analisis",
  "/ajustes",
];

const PERFILES = {
  movil: {
    contexto: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    },
    cpu: 4,
    red: { latency: 562.5, downloadThroughput: (1474.56 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 },
  },
  escritorio: {
    contexto: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    cpu: 1,
    red: null,
  },
};

/** Observadores instalados antes de que cargue nada: tareas largas, LCP, CLS. */
function observadores() {
  window.__m = { lt: [], lcp: 0, cls: 0, ev: [] };
  const obs = (type, fn) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true });
    } catch {}
  };
  obs("longtask", (e) => window.__m.lt.push([e.startTime, e.duration]));
  obs("largest-contentful-paint", (e) => (window.__m.lcp = e.startTime));
  obs("layout-shift", (e) => {
    if (!e.hadRecentInput) window.__m.cls += e.value;
  });
}

function mediana(xs) {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function percentil(xs, p) {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

/** Lleva la cuenta de lo que pasa por la red de una página (vía CDP). */
async function contador(cdp) {
  const peticiones = new Map();
  cdp.on("Network.requestWillBeSent", (e) => {
    peticiones.set(e.requestId, {
      url: e.request.url,
      tipo: e.type,
      rsc: /[?&]_rsc=/.test(e.request.url) || !!e.request.headers?.RSC || !!e.request.headers?.rsc,
      bytes: 0,
      sw: false,
      cache: false,
    });
  });
  cdp.on("Network.responseReceived", (e) => {
    const p = peticiones.get(e.requestId);
    if (!p) return;
    p.estado = e.response.status;
    p.sw = !!e.response.fromServiceWorker;
    p.cache = !!e.response.fromDiskCache || !!e.response.fromPrefetchCache;
  });
  cdp.on("Network.loadingFinished", (e) => {
    const p = peticiones.get(e.requestId);
    if (p) p.bytes = e.encodedDataLength;
  });
  await cdp.send("Network.enable");
  return {
    reiniciar: () => peticiones.clear(),
    resumen() {
      const todas = [...peticiones.values()];
      const suma = (f) => todas.filter(f).reduce((s, p) => s + p.bytes, 0);
      return {
        peticiones: todas.length,
        kb: Math.round(suma(() => true) / 1024),
        kbJs: Math.round(suma((p) => p.tipo === "Script") / 1024),
        kbCss: Math.round(suma((p) => p.tipo === "Stylesheet") / 1024),
        kbFuentes: Math.round(suma((p) => p.tipo === "Font") / 1024),
        kbDoc: Math.round(suma((p) => p.tipo === "Document") / 1024),
        rsc: todas.filter((p) => p.rsc).length,
        desdeSw: todas.filter((p) => p.sw).length,
        desdeCache: todas.filter((p) => p.cache).length,
      };
    },
  };
}

async function medirCarga(page, red, url) {
  red.reiniciar();
  const t0 = Date.now();
  const resp = await page.goto(url, { waitUntil: "load", timeout: 90_000 });
  const final = page.url();
  // Ventana de calma: 5 s para que aparezcan tareas largas tardías, LCP, CLS y prefetch.
  await page.waitForTimeout(5_000);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
    const lt = window.__m?.lt ?? [];
    // TBT: tareas largas entre FCP y «interactivo».
    let interactivo = Math.max(fcp ?? 0, nav?.domContentLoadedEventEnd ?? 0);
    for (const [ini, dur] of lt) if (ini + dur > interactivo && ini < interactivo + 5000) interactivo = ini + dur;
    const tbt = lt
      .filter(([ini]) => ini >= (fcp ?? 0) && ini < interactivo)
      .reduce((s, [, d]) => s + Math.max(0, d - 50), 0);
    return {
      // Vercel responde con «103 Early Hints»: en Chrome `responseStart` apunta a
      // esa respuesta provisional y da un TTFB de mentira. El bueno es el de las
      // cabeceras finales.
      ttfb: nav ? (nav.finalResponseHeadersStart || nav.responseStart) - nav.startTime : null,
      ttfbProvisional: nav ? nav.responseStart - nav.startTime : null,
      fcp,
      lcp: window.__m?.lcp || null,
      cls: window.__m?.cls ?? null,
      tbt,
      tareasLargas: lt.length,
      tareaMasLarga: lt.reduce((m, [, d]) => Math.max(m, d), 0),
      interactivo,
      dcl: nav?.domContentLoadedEventEnd ?? null,
      nodos: document.getElementsByTagName("*").length,
      load: nav?.loadEventEnd ?? null,
    };
  });
  return { estado: resp?.status() ?? null, final, muro: Date.now() - t0, ...m, ...red.resumen() };
}

async function vuelta(browser, estado, base, ruta, perfil) {
  const cfg = PERFILES[perfil];
  const ctx = await browser.newContext({ ...cfg.contexto, storageState: estado, baseURL: base, serviceWorkers: "allow" });
  await ctx.addInitScript(observadores);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const red = await contador(cdp);
  if (cfg.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cfg.cpu });
  if (cfg.red) await cdp.send("Network.emulateNetworkConditions", { offline: false, ...cfg.red });
  try {
    const frio = await medirCarga(page, red, ruta);
    // Asegura que el service worker está activo y controla la página antes de la vuelta en caliente.
    await page.evaluate(() =>
      "serviceWorker" in navigator
        ? Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 5000))])
        : null,
    );
    const caliente = await medirCarga(page, red, ruta);
    return { frio, caliente };
  } finally {
    await ctx.close();
  }
}

/** Tiempo de respuesta del HTML sin navegador (coste puro de servidor). */
async function ttfbHtml(base, estado, ruta, n) {
  const { cookies } = JSON.parse(readFileSync(estado, "utf8"));
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const cabeceras = [];
  const primeros = [];
  const totales = [];
  let bytes = 0;
  let estadoHttp = null;
  let cacheControl = null;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await fetch(base + ruta, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
    cabeceras.push(performance.now() - t0);
    cacheControl = r.headers.get("cache-control");
    const lector = r.body.getReader();
    let primero = null;
    let total = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (primero === null) primero = performance.now() - t0;
      if (done) break;
      total += value.length;
    }
    primeros.push(primero);
    totales.push(performance.now() - t0);
    bytes = total;
    estadoHttp = r.status;
  }
  return {
    estado: estadoHttp,
    cabecerasMediana: Math.round(mediana(cabeceras)),
    ttfbMediana: Math.round(mediana(primeros)),
    ttfbP90: Math.round(percentil(primeros, 90)),
    totalMediana: Math.round(mediana(totales)),
    kbHtml: Math.round(bytes / 1024),
    cacheControl,
  };
}

const r0 = (x) => (x == null ? null : Math.round(x));
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

function agregar(muestras) {
  const campos = ["ttfb", "ttfbProvisional", "fcp", "lcp", "tbt", "interactivo", "muro", "peticiones", "kb", "kbJs", "kbCss", "kbFuentes", "kbDoc", "rsc", "desdeSw", "desdeCache", "tareasLargas", "tareaMasLarga", "nodos"];
  const out = {};
  for (const c of campos) out[c] = r0(mediana(muestras.map((m) => m[c])));
  out.cls = r3(mediana(muestras.map((m) => m.cls)));
  out.final = [...new Set(muestras.map((m) => new URL(m.final).pathname))].join(",");
  return out;
}

async function main() {
  const base = argumento("base", BASE_PROD);
  const sesion = argumento("sesion", "sesion-de-prueba.txt");
  const estado = argumento("estado", ESTADO_POR_DEFECTO);
  const rutas = argumento("rutas", RUTAS_POR_DEFECTO.join(",")).split(",");
  const perfiles = argumento("perfiles", "movil,escritorio").split(",");
  const veces = Number(argumento("veces", "3"));
  const nTtfb = Number(argumento("ttfb", "5"));
  const salida = argumento("salida", "docs/pruebas/datos/bench.json");

  await asegurarSesion({ base, sesion, estado });
  const browser = await chromium.launch();
  const resultado = { base, fecha: new Date().toISOString(), veces, rutas: {} };
  try {
    for (const ruta of rutas) {
      resultado.rutas[ruta] = {};
      for (const perfil of perfiles) {
        const frios = [];
        const calientes = [];
        for (let i = 0; i < veces; i++) {
          const { frio, caliente } = await vuelta(browser, estado, base, ruta, perfil);
          frios.push(frio);
          calientes.push(caliente);
        }
        resultado.rutas[ruta][perfil] = { frio: agregar(frios), caliente: agregar(calientes), crudo: { frios, calientes } };
        const f = resultado.rutas[ruta][perfil].frio;
        const c = resultado.rutas[ruta][perfil].caliente;
        console.log(
          `${ruta.padEnd(20)} ${perfil.padEnd(10)} frío: TTFB ${f.ttfb} FCP ${f.fcp} LCP ${f.lcp} CLS ${f.cls} TBT ${f.tbt} TTI ${f.interactivo} · DOM ${f.nodos} · ${f.kb} KB/${f.peticiones} pet (JS ${f.kbJs}, RSC ${f.rsc}) | caliente: LCP ${c.lcp} TBT ${c.tbt} · ${c.kb} KB/${c.peticiones} pet (SW ${c.desdeSw})`,
        );
      }
      if (nTtfb > 0) {
        resultado.rutas[ruta].html = await ttfbHtml(base, estado, ruta, nTtfb);
        const h = resultado.rutas[ruta].html;
        console.log(`${ruta.padEnd(20)} html       ${h.estado} cabeceras ${h.cabecerasMediana} · 1er trozo med ${h.ttfbMediana} p90 ${h.ttfbP90} total ${h.totalMediana} · ${h.kbHtml} KB`);
      }
    }
  } finally {
    await browser.close();
  }
  mkdirSync(path.dirname(salida), { recursive: true });
  writeFileSync(salida, JSON.stringify(resultado, null, 2));
  console.log(`Resultados en ${salida}`);
}

await main();
