/**
 * Movimientos con volumen, antes y después: tamaño del HTML, nodos de DOM,
 * cuántas filas se pintan (lista + tabla), precargas RSC y lo que cuesta un
 * «Cargar más». Con el usuario de pruebas y el estado de sesión de
 * `sesion-prod.mjs`.
 *
 *   node scripts/medir-movimientos.mjs --base http://localhost:3107 \
 *        --estado e2e/.auth/local-state.json [--anchos 390,1440]
 *
 * Pensado para correr con los datos de estrés sembrados (`estres-datos.mjs`).
 */
import { chromium } from "playwright";
import { argumento } from "./sesion-prod.mjs";

const base = argumento("base", "http://localhost:3107");
const estado = argumento("estado", "e2e/.auth/local-state.json");
const anchos = argumento("anchos", "390,1440").split(",").map(Number);

const cookies = (await import("node:fs")).readFileSync(estado, "utf8");
const cabeceraCookie = JSON.parse(cookies)
  .cookies.map((c) => `${c.name}=${c.value}`)
  .join("; ");

// 1 · El HTML sin navegador.
for (const ruta of ["/movimientos", "/movimientos?filas=500"]) {
  const t0 = performance.now();
  const r = await fetch(`${base}${ruta}`, { headers: { cookie: cabeceraCookie } });
  const html = await r.text();
  console.log(
    `HTML ${ruta.padEnd(24)} ${r.status} · ${Math.round(html.length / 1024)} KB · ${Math.round(performance.now() - t0)} ms`,
  );
}

const browser = await chromium.launch();
for (const ancho of anchos) {
  const ctx = await browser.newContext({
    storageState: estado,
    baseURL: base,
    viewport: { width: ancho, height: ancho >= 1024 ? 900 : 844 },
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  const rsc = [];
  page.on("request", (req) => {
    const h = req.headers();
    if (h.rsc || h["next-router-prefetch"]) rsc.push({ url: req.url(), prefetch: !!h["next-router-prefetch"] });
  });
  const acciones = [];
  page.on("requestfinished", async (req) => {
    const h = req.headers();
    // Lo que trae «Cargar más»: la acción (después) o la navegación RSC (antes).
    if ((req.method() === "POST" && h["next-action"]) || (h.rsc && !h["next-router-prefetch"])) {
      const res = await req.response();
      const cuerpo = await res?.body().catch(() => null);
      acciones.push(cuerpo ? cuerpo.length : 0);
    }
  });

  await page.goto("/movimientos?filas=500", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const antes = await page.evaluate(() => ({
    dom: document.querySelectorAll("*").length,
    enlacesFila: document.querySelectorAll('a[href^="/movimientos/"]:not([href="/movimientos/nuevo"])').length,
    anchoPagina: document.documentElement.scrollWidth,
  }));
  const precargas = rsc.filter((r) => r.prefetch).length;
  console.log(
    `${ancho} px · ?filas=500 · DOM ${antes.dom} · enlaces de fila ${antes.enlacesFila} · ancho ${antes.anchoPagina} · precargas ${precargas}`,
  );

  // «Cargar más»: lo que viaja.
  await page.goto("/movimientos", { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const boton = page.getByRole("button", { name: /^Cargar \d+ más$/ });
  if (await boton.count()) {
    rsc.length = 0;
    acciones.length = 0;
    const filas0 = await page.locator('a[href^="/movimientos/"]:not([href="/movimientos/nuevo"])').count();
    const t0 = Date.now();
    await boton.click();
    await page.waitForFunction(
      (n) => document.querySelectorAll('a[href^="/movimientos/"]:not([href="/movimientos/nuevo"])').length > n,
      filas0,
      { timeout: 90_000 },
    );
    const ms = Date.now() - t0;
    await page.waitForTimeout(500);
    const filas1 = await page.locator('a[href^="/movimientos/"]:not([href="/movimientos/nuevo"])').count();
    const ids = await page.$$eval('a[href^="/movimientos/"]:not([href="/movimientos/nuevo"])', (as) => as.map((a) => a.getAttribute("href")));
    const dup = ids.length - new Set(ids).size;
    const rscKb = rsc.length;
    console.log(
      `${ancho} px · Cargar más: ${filas0} → ${filas1} enlaces en ${ms} ms · acción ${acciones.map((b) => Math.round(b / 1024) + " KB").join(", ") || "—"} · peticiones RSC ${rscKb} · duplicados ${dup} · url ${new URL(page.url()).search}`,
    );
  } else {
    console.log(`${ancho} px · sin «Cargar más»`);
  }
  await ctx.close();
}
await browser.close();
