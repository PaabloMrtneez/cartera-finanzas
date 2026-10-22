import { expect, test } from "@playwright/test";

/**
 * Robustez de maqueta: ninguna pantalla se desplaza en horizontal en los anchos
 * que importan, y ningún texto visible baja de 13 px (convención de AGENTS.md:
 * «se lee a un brazo de distancia»).
 *
 * Con los datos de estrés (`scripts/estres-datos.mjs crear`: nombres de 60
 * caracteres, ±9.999.999,99 €, 500+ movimientos) es donde de verdad se pone a
 * prueba; con los datos sembrados normales también debe pasar.
 */

const RUTAS = [
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
  "/categorias",
];

for (const ancho of [320, 375, 768, 1024, 1440]) {
  test(`sin desborde horizontal a ${ancho} px`, async ({ page }) => {
    await page.setViewportSize({ width: ancho, height: ancho >= 1024 ? 900 : 800 });
    const rotas: string[] = [];
    for (const ruta of RUTAS) {
      await page.goto(ruta);
      await page.locator("h1").first().waitFor();
      await page.waitForTimeout(700);
      // Con `isMobile` (iPhone 13), si algo se sale Chrome ENSANCHA el viewport
      // de diseño para abarcarlo, así que `innerWidth` deja de ser el ancho
      // pedido: se compara contra el ancho del dispositivo, no contra él.
      const { sw, iw } = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
      }));
      const w = Math.max(sw, iw);
      if (w > ancho) rotas.push(`${ruta}: ${w} px de ancho en un dispositivo de ${ancho}`);
    }
    expect(rotas, rotas.join("\n")).toEqual([]);
  });
}

test("ningún texto visible por debajo de 13 px", async ({ page }) => {
  // HALLAZGO M-4 (docs/pruebas/informe-front.md), ARREGLADO: los rótulos de la
  // barra de pestañas iban a 11 px; ahora a 13, con las pestañas repartiéndose
  // el ancho según lo que miden.
  const pequenos: string[] = [];
  for (const ancho of [390, 1440]) {
    await page.setViewportSize({ width: ancho, height: ancho >= 1024 ? 900 : 844 });
    for (const ruta of RUTAS) {
      await page.goto(ruta);
      await page.locator("h1").first().waitFor();
      await page.waitForTimeout(700);
      const hallados = await page.evaluate(() => {
        const out = new Map<string, number>();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const texto = n.textContent?.trim();
          const el = n.parentElement;
          if (!texto || !el) continue;
          if (el.closest("[aria-hidden='true'], .sr-only, script, style, nextjs-portal")) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const s = getComputedStyle(el);
          if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") continue;
          const px = parseFloat(s.fontSize);
          if (px < 13) {
            const clave = `${Math.round(px * 10) / 10}px «${texto.slice(0, 24)}» <${el.tagName.toLowerCase()} class="${String(el.getAttribute("class") ?? "").slice(0, 50)}">`;
            out.set(clave, (out.get(clave) ?? 0) + 1);
          }
        }
        return [...out.entries()].slice(0, 8).map(([k, v]) => `${k} ×${v}`);
      });
      for (const h of hallados) pequenos.push(`${ancho} ${ruta}: ${h}`);
    }
  }
  console.log(`[texto<13px]\n${pequenos.join("\n")}`);
  expect(pequenos, pequenos.join("\n")).toEqual([]);
});
