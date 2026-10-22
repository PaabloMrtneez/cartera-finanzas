/**
 * Prueba de estrés VISUAL: recorre las pantallas en varios anchos, busca
 * desbordes horizontales y elementos que se salen de la ventana, y guarda una
 * captura de página completa de cada combinación.
 *
 *   node scripts/estres-visual.mjs [--base URL] [--anchos 320,375,768,1024,1440]
 *        [--rutas /resumen,/movimientos] [--tema dark|light] [--dir docs/pruebas/capturas]
 *        [--etiqueta estres]
 *
 * Pensado para correr con los datos de `estres-datos.mjs crear` (nombres de 60
 * caracteres, 9.999.999,99 € y −9.999.999,99 €, 500+ movimientos). Usa la sesión
 * del usuario de pruebas (`sesion-prod.mjs`).
 *
 * Qué cuenta como roto:
 *   · `document.documentElement.scrollWidth > innerWidth` (la página entera se
 *     desplaza en horizontal);
 *   · cualquier elemento visible cuyo borde derecho pase del ancho de la
 *     ventana, salvo que viva dentro de un contenedor con scroll horizontal
 *     propio (eso es intencionado);
 *   · texto recortado sin puntos suspensivos: `scrollWidth > clientWidth` con
 *     `overflow: hidden` y `text-overflow` distinto de `ellipsis`.
 * Escribe un resumen JSON junto a las capturas.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { argumento, asegurarSesion, BASE_PROD, ESTADO_POR_DEFECTO } from "./sesion-prod.mjs";

const base = argumento("base", BASE_PROD);
const estado = argumento("estado", ESTADO_POR_DEFECTO);
const anchos = argumento("anchos", "320,375,768,1024,1440").split(",").map(Number);
const rutas = argumento(
  "rutas",
  "/resumen,/movimientos,/movimientos/nuevo,/cuentas,/patrimonio,/inversiones,/fijos,/prestamos,/metas,/analisis,/ajustes,/categorias",
).split(",");
const tema = argumento("tema", "dark");
const dir = argumento("dir", "docs/pruebas/capturas");
const etiqueta = argumento("etiqueta", "estres");
const capturar = argumento("capturas", "si") === "si";

await asegurarSesion({ base, sesion: argumento("sesion", "sesion-de-prueba.txt"), estado });
mkdirSync(dir, { recursive: true });

/**
 * OJO con `isMobile`: igual que un móvil de verdad, si el contenido es más ancho
 * que el dispositivo, Chrome ENSANCHA el viewport de diseño hasta abarcarlo (y
 * aleja el zoom). Entonces `innerWidth` ya no es 320 sino lo que mida lo más
 * ancho, y comparar contra él no detecta nada. Se compara contra el ancho del
 * dispositivo que se pidió.
 */
function inspeccionar(ancho) {
  const conScrollPropio = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return true;
      if (s.position === "fixed" && s.transform !== "none") return true;
    }
    return false;
  };
  const describir = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 90);
  };
  const fuera = [];
  const recortados = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    if (el.closest("[aria-hidden='true'], nextjs-portal, .sr-only")) continue;
    if (r.right > ancho + 1 && !conScrollPropio(el)) {
      fuera.push({ el: describir(el), derecha: Math.round(r.right), texto: (el.innerText || "").slice(0, 60) });
    }
    if (
      el.children.length === 0 &&
      el.scrollWidth > el.clientWidth + 1 &&
      s.overflow.includes("hidden") &&
      s.textOverflow !== "ellipsis"
    ) {
      recortados.push({ el: describir(el), texto: (el.innerText || "").slice(0, 60) });
    }
  }
  // Solo los más externos: si un padre ya se sale, sus hijos no aportan.
  return {
    scrollWidth: document.documentElement.scrollWidth,
    ancho,
    innerWidth: window.innerWidth,
    desborda: document.documentElement.scrollWidth > ancho || window.innerWidth > ancho,
    fuera: fuera.slice(0, 12),
    nFuera: fuera.length,
    recortados: recortados.slice(0, 12),
    nRecortados: recortados.length,
  };
}

const browser = await chromium.launch();
const informe = [];
try {
  for (const ancho of anchos) {
    const ctx = await browser.newContext({
      storageState: estado,
      baseURL: base,
      viewport: { width: ancho, height: ancho >= 1024 ? 900 : 800 },
      deviceScaleFactor: 1,
      isMobile: ancho < 1024,
      hasTouch: ancho < 1024,
    });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem("cartera:theme", t);
      } catch {}
    }, tema);
    const page = await ctx.newPage();
    const errores = [];
    page.on("pageerror", (e) => errores.push(String(e).slice(0, 200)));
    page.on("console", (m) => m.type() === "error" && errores.push(m.text().slice(0, 200)));
    for (const ruta of rutas) {
      errores.length = 0;
      await page.goto(ruta, { waitUntil: "load", timeout: 90_000 });
      await page.locator("h1").first().waitFor({ timeout: 30_000 }).catch(() => {});
      // Entradas animadas, cifras que cuentan y gráficos que miden su caja.
      await page.waitForTimeout(2_500);
      if (/\/entrar/.test(page.url())) throw new Error("La sesión ha caducado: vuelve a entrar (sesion-prod.mjs).");
      const r = await page.evaluate(inspeccionar, ancho);
      const nombre = `${etiqueta}-${tema}-${ancho}${ruta.replace(/\//g, "_")}.jpg`;
      if (capturar) {
        await page.screenshot({ path: path.join(dir, nombre), fullPage: true, type: "jpeg", quality: 60 });
      }
      informe.push({ ruta, ancho, tema, captura: nombre, errores: [...errores], ...r });
      console.log(
        `${String(ancho).padStart(4)} ${ruta.padEnd(20)} ${r.desborda ? `DESBORDA (${r.scrollWidth}px)` : "ok"} · fuera ${r.nFuera} · recortados ${r.nRecortados}${errores.length ? ` · ${errores.length} errores de consola` : ""}`,
      );
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(path.join(dir, `${etiqueta}-${tema}-resumen.json`), JSON.stringify(informe, null, 2));
