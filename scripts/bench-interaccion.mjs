/**
 * Tirones en la interacción: transiciones de pantalla y lectura de gráficos.
 *
 *   node scripts/bench-interaccion.mjs [--base URL] [--perfil movil|escritorio] [--veces 3]
 *
 * 1. TRANSICIONES. Con la app cargada, pulsa la pestaña de la barra y mide:
 *    · ms hasta la primera señal visible (cambia la pestaña activa, aparece un
 *      esqueleto o cambia el h1): cuánto tiempo «no pasa nada» tras el toque;
 *    · ms hasta que la pantalla nueva tiene su h1;
 *    · tareas largas (> 50 ms) y la peor, durante el cambio;
 *    · la duración del evento del toque (Event Timing), que es lo que mide INP.
 * 2. GRÁFICOS. En cada pantalla con un gráfico interactivo (`[role=group]` con
 *    tabIndex, el de `linea-interactiva`, o el primer `svg` grande) barre el
 *    puntero de izquierda a derecha en 60 pasos y mide los fotogramas (rAF):
 *    p95, el peor y cuántos pasan de 50 ms, más las tareas largas.
 *
 * Perfil móvil = CPU 4× y 4G lenta (como `bench-front.mjs`). Solo con el
 * usuario de pruebas; solo lectura.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { argumento, asegurarSesion, BASE_PROD, ESTADO_POR_DEFECTO } from "./sesion-prod.mjs";

const base = argumento("base", BASE_PROD);
const estado = argumento("estado", ESTADO_POR_DEFECTO);
const perfil = argumento("perfil", "movil");
const veces = Number(argumento("veces", "3"));
const salida = argumento("salida", `docs/pruebas/datos/interaccion-${perfil}.json`);
await asegurarSesion({ base, sesion: argumento("sesion", "sesion-de-prueba.txt"), estado });

const MOVIL = perfil === "movil";
const contexto = MOVIL
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
  : { viewport: { width: 1440, height: 900 } };

function instalar() {
  window.__lt = [];
  window.__ev = [];
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([e.startTime, e.duration]))).observe({
      type: "longtask",
      buffered: true,
    });
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => window.__ev.push([e.name, e.startTime, e.duration, e.interactionId])),
    ).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch {}
}

const mediana = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

const SALTOS = MOVIL
  ? ["/resumen", "/movimientos", "/cuentas", "/patrimonio", "/resumen"]
  : ["/resumen", "/movimientos", "/cuentas", "/patrimonio", "/inversiones", "/analisis", "/resumen"];
const GRAFICOS = ["/patrimonio", "/inversiones", "/resumen", "/cuentas", "/analisis", "/prestamos"];

const browser = await chromium.launch();
const resultado = { base, perfil, fecha: new Date().toISOString(), transiciones: {}, graficos: {} };
try {
  for (let v = 0; v < veces; v++) {
    const ctx = await browser.newContext({ ...contexto, storageState: estado, baseURL: base });
    await ctx.addInitScript(instalar);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    if (MOVIL) {
      await cdp.send("Network.enable");
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 562.5,
        downloadThroughput: (1474.56 * 1024) / 8,
        uploadThroughput: (675 * 1024) / 8,
      });
    }
    await page.goto(SALTOS[0], { waitUntil: "load" });
    await page.waitForTimeout(3_000);

    // 1 · Transiciones por la barra de navegación.
    for (let i = 1; i < SALTOS.length; i++) {
      const de = SALTOS[i - 1];
      const a = SALTOS[i];
      const clave = `${de} → ${a}`;
      const enlace = page.locator(`a[href="${a}"]:visible`).first();
      const h1Antes = await page.locator("h1").first().innerText();
      const marca = await page.evaluate(() => ({ lt: window.__lt.length, ev: window.__ev.length, t: performance.now() }));
      await enlace.click();
      // Primera señal: algo en pantalla cambia (aria-current en el destino, un
      // esqueleto `[aria-busy]`, o el h1).
      const senal = await page
        .waitForFunction(
          ({ a, h1Antes }) => {
            const destino = document.querySelector(`a[href="${a}"][aria-current="page"]`);
            const ocupado = document.querySelector("[aria-busy='true'], [data-cargando]");
            const h1 = document.querySelector("h1")?.textContent;
            return destino || ocupado || h1 !== h1Antes ? performance.now() : false;
          },
          { a, h1Antes },
          { polling: "raf", timeout: 30_000 },
        )
        .then((h) => h.jsonValue());
      await page.waitForURL((u) => u.pathname === a, { timeout: 30_000 });
      await page.waitForFunction((h) => document.querySelector("h1")?.textContent !== h, h1Antes, { timeout: 30_000 });
      const fin = await page.evaluate(() => performance.now());
      await page.waitForTimeout(1_500);
      const datos = await page.evaluate((m) => {
        const lt = window.__lt.slice(m.lt);
        const ev = window.__ev.slice(m.ev).filter((e) => ["pointerdown", "pointerup", "click", "touchstart", "touchend"].includes(e[0]));
        return {
          tareas: lt.length,
          peor: Math.round(lt.reduce((x, [, d]) => Math.max(x, d), 0)),
          tbt: Math.round(lt.reduce((s, [, d]) => s + Math.max(0, d - 50), 0)),
          eventoMax: Math.round(ev.reduce((x, e) => Math.max(x, e[2]), 0)),
        };
      }, marca);
      const fila = { senalMs: Math.round(senal - marca.t), pantallaMs: Math.round(fin - marca.t), ...datos };
      (resultado.transiciones[clave] ??= []).push(fila);
    }

    // 2 · Barrido del puntero sobre el gráfico principal de cada pantalla.
    for (const ruta of GRAFICOS) {
      await page.goto(ruta, { waitUntil: "load" });
      await page.locator("h1").first().waitFor();
      await page.waitForTimeout(2_000);
      const grafico = page.locator('[role="group"][tabindex="0"]:visible, [role="img"]:visible svg').first();
      if (!(await grafico.count())) {
        (resultado.graficos[ruta] ??= []).push({ sinGrafico: true });
        continue;
      }
      await grafico.scrollIntoViewIfNeeded();
      const caja = await grafico.boundingBox();
      if (!caja) continue;
      const marca = await page.evaluate(() => {
        window.__frames = [];
        let previo = performance.now();
        window.__rafVivo = true;
        const bucle = (t) => {
          window.__frames.push(t - previo);
          previo = t;
          if (window.__rafVivo) requestAnimationFrame(bucle);
        };
        requestAnimationFrame(bucle);
        return { lt: window.__lt.length };
      });
      const y = caja.y + caja.height / 2;
      for (let k = 0; k <= 60; k++) {
        await page.mouse.move(caja.x + 2 + ((caja.width - 4) * k) / 60, y);
        await page.waitForTimeout(16);
      }
      const r = await page.evaluate((m) => {
        window.__rafVivo = false;
        const f = window.__frames.slice(1).sort((a, b) => a - b);
        const lt = window.__lt.slice(m.lt);
        return {
          fotogramas: f.length,
          p95: Math.round(f[Math.floor(f.length * 0.95)] ?? 0),
          peor: Math.round(f[f.length - 1] ?? 0),
          tirones: f.filter((x) => x > 50).length,
          tareas: lt.length,
          tareaPeor: Math.round(lt.reduce((x, [, d]) => Math.max(x, d), 0)),
        };
      }, marca);
      (resultado.graficos[ruta] ??= []).push(r);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

for (const [k, filas] of Object.entries(resultado.transiciones)) {
  const m = (c) => mediana(filas.map((f) => f[c]));
  console.log(
    `${perfil} transición ${k.padEnd(28)} señal ${m("senalMs")} ms · pantalla ${m("pantallaMs")} ms · tareas ${m("tareas")} (peor ${m("peor")} ms, TBT ${m("tbt")}) · evento ${m("eventoMax")} ms`,
  );
}
for (const [k, filas] of Object.entries(resultado.graficos)) {
  if (filas[0]?.sinGrafico) {
    console.log(`${perfil} gráfico ${k}: sin gráfico interactivo`);
    continue;
  }
  const m = (c) => mediana(filas.map((f) => f[c]));
  console.log(
    `${perfil} gráfico ${k.padEnd(14)} fotogramas p95 ${m("p95")} ms · peor ${m("peor")} ms · >50 ms: ${m("tirones")} · tareas ${m("tareas")} (peor ${m("tareaPeor")} ms)`,
  );
}
mkdirSync(path.dirname(salida), { recursive: true });
writeFileSync(salida, JSON.stringify(resultado, null, 2));
