/**
 * Lista las peticiones RSC (prefetch y navegación) que dispara una pantalla.
 *
 *   node scripts/prefetch-rsc.mjs [--base URL] [--ruta /resumen] [--ancho 1440]
 *        [--navegar /movimientos]
 *
 * Con `--navegar`, tras cargar la ruta pulsa el enlace a esa otra pantalla y
 * mide la transición en cliente: cuánto tarda la respuesta RSC, si venía ya del
 * prefetch y las tareas largas del cambio de pantalla.
 *
 * Usa el estado de sesión de `sesion-prod.mjs` (usuario de pruebas).
 */
import { chromium } from "playwright";
import { argumento, asegurarSesion, BASE_PROD, ESTADO_POR_DEFECTO } from "./sesion-prod.mjs";

const base = argumento("base", BASE_PROD);
const ruta = argumento("ruta", "/resumen");
const ancho = Number(argumento("ancho", "1440"));
const navegar = argumento("navegar", null);
const estado = argumento("estado", ESTADO_POR_DEFECTO);
await asegurarSesion({ base, sesion: argumento("sesion", "sesion-de-prueba.txt"), estado });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  storageState: estado,
  baseURL: base,
  viewport: { width: ancho, height: ancho >= 1024 ? 900 : 844 },
});
await ctx.addInitScript(() => {
  window.__lt = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([e.startTime, e.duration]))).observe({
    type: "longtask",
    buffered: true,
  });
});
const page = await ctx.newPage();
const filas = [];
page.on("requestfinished", async (req) => {
  const u = new URL(req.url());
  const h = req.headers();
  if (!u.searchParams.has("_rsc") && !h["rsc"]) return;
  const t = req.timing();
  const s = await req.sizes().catch(() => ({}));
  filas.push({
    ruta: u.pathname,
    prefetch: h["next-router-prefetch"] ?? "-",
    segmento: (h["next-router-segment-prefetch"] ?? "-").slice(0, 28),
    ms: Math.round(t.responseEnd),
    kb: Math.round(((s.responseBodySize ?? 0) / 1024) * 10) / 10,
    estado: (await req.response())?.status(),
  });
});
await page.goto(ruta, { waitUntil: "load" });
await page.waitForTimeout(6_000);
console.log(`${ruta} a ${ancho} px: ${filas.length} peticiones RSC tras cargar`);
console.table(filas);

if (navegar) {
  filas.length = 0;
  const antes = await page.evaluate(() => window.__lt.length);
  const t0 = await page.evaluate(() => performance.now());
  await page.locator(`a[href="${navegar}"]:visible`).first().click();
  await page.waitForURL((u) => u.pathname === navegar);
  await page.locator("h1").first().waitFor();
  const t1 = await page.evaluate(() => performance.now());
  const tareas = await page.evaluate((n) => window.__lt.slice(n), antes);
  console.log(
    `Transición ${ruta} → ${navegar}: ${Math.round(t1 - t0)} ms hasta el h1; tareas largas: ${tareas
      .map(([, d]) => Math.round(d))
      .join(", ") || "ninguna"}`,
  );
  console.table(filas);
}
await browser.close();
