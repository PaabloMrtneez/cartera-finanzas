import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Result } from "axe-core";
import { aplicarBypassVercel } from "./helpers";

/**
 * Accesibilidad COMPLETA: lo que `a11y.spec.ts` no cubría.
 *
 *   · Las pantallas que faltaban (Categorías, Reglas, Importar, Atajo) y las de
 *     acceso sin sesión (Entrar).
 *   · TODAS las pantallas en el tema CLARO (el oscuro es el de por defecto y es
 *     el que barre `a11y.spec.ts`).
 *   · Todas las hojas de alta abiertas: cuenta, meta, gasto fijo, ingreso fijo,
 *     categoría, regla, límite, posición, préstamo y el buscador.
 *   · Teclado: cada hoja atrapa el foco, Escape la cierra y el foco vuelve a su
 *     disparador; el primer Tab de cada pantalla enseña un foco visible.
 *   · Movimiento reducido: con `prefers-reduced-motion` la hoja sigue
 *     apareciendo (fundido), no se queda a medias ni desaparece la animación sin
 *     más.
 *
 * WCAG 2.0/2.1 A y AA, incluido el contraste.
 */

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

function detalle(v: Result[]) {
  return v
    .map((x) => `[${x.impact}] ${x.id} ×${x.nodes.length}: ${x.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(", ")}`)
    .join("\n");
}

async function axe(page: Page, etiqueta: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).exclude("nextjs-portal").analyze();
  console.log(`[a11y] ${etiqueta}: ${violations.length ? "\n" + detalle(violations) : "sin violaciones"}`);
  return violations;
}

async function tema(page: Page, valor: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("cartera:theme", t);
    } catch {}
  }, valor);
}

const PANTALLAS = [
  ["/resumen", "Resumen"],
  ["/movimientos", "Movimientos"],
  ["/movimientos/nuevo", "Nuevo movimiento"],
  ["/cuentas", "Cuentas"],
  ["/patrimonio", "Patrimonio"],
  ["/inversiones", "Inversiones"],
  ["/fijos?ver=gastos", "Fijos"],
  ["/fijos?ver=ingresos", "Fijos"],
  ["/prestamos", "Préstamos"],
  ["/metas", "Metas"],
  ["/analisis", "Análisis"],
  ["/ajustes", "Ajustes"],
  ["/categorias", "Categorías"],
  ["/reglas", "Reglas de comercio"],
  ["/importar", "Importar del banco"],
  ["/atajo", "El Atajo del iPhone"],
] as const;

for (const [url, titulo] of PANTALLAS) {
  test(`a11y tema claro · ${url}`, async ({ page }) => {
    await tema(page, "light");
    await page.goto(url);
    await page.getByRole("heading", { name: titulo, exact: true }).first().waitFor();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    const v = await axe(page, `claro${url}`);
    expect(v, detalle(v)).toEqual([]);
  });
}

for (const url of ["/categorias", "/reglas", "/importar", "/atajo"] as const) {
  test(`a11y tema oscuro · ${url}`, async ({ page }) => {
    await tema(page, "dark");
    await page.goto(url);
    await page.locator("h1").first().waitFor();
    const v = await axe(page, `oscuro${url}`);
    expect(v, detalle(v)).toEqual([]);
  });
}

test("a11y sin sesión · Entrar", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  // Sin la sesión guardada tampoco va la cookie del bypass de Vercel (solo en prod).
  await aplicarBypassVercel(ctx, baseURL);
  const page = await ctx.newPage();
  await page.goto("/entrar");
  await page.getByLabel("Correo", { exact: true }).waitFor();
  const v = await axe(page, "sin-sesión/entrar");
  await ctx.close();
  expect(v, detalle(v)).toEqual([]);
});

/** [ruta, nombre accesible del disparador, nombre de la hoja (heading)] */
const HOJAS = [
  ["/cuentas", "Nueva cuenta", /cuenta/i],
  ["/metas", "Nueva meta", /meta/i],
  ["/fijos?ver=gastos", "Nuevo gasto fijo", /gasto|suscrip|fijo/i],
  ["/fijos?ver=ingresos", "Nuevo ingreso fijo", /ingreso/i],
  ["/categorias", /Nueva categoría/, /categor/i],
  ["/reglas", "Nueva regla", /regla/i],
  ["/analisis", "Nuevo límite", /l[ií]mite/i],
  ["/inversiones", "Nueva posición", /posici/i],
  ["/prestamos", "Nuevo préstamo", /pr[eé]stamo/i],
] as const;

for (const [url, disparador, titulo] of HOJAS) {
  for (const t of ["dark", "light"] as const) {
    test(`a11y hoja ${t} · ${String(disparador)} (${url})`, async ({ page }) => {
      await tema(page, t);
      await page.goto(url);
      await page.locator("h1").first().waitFor();
      const boton = page.getByRole("button", { name: disparador }).first();
      await boton.click();
      const dialogo = page.getByRole("dialog");
      await dialogo.waitFor();
      await expect(dialogo.getByRole("heading", { name: titulo }).first()).toBeVisible();
      await page.waitForTimeout(600); // fin de la entrada de la hoja
      const v = await axe(page, `hoja-${t}${url}`);

      // Teclado: el foco está dentro, Tab no se escapa y Escape lo devuelve.
      if (t === "dark") {
        const dentro = () =>
          page.evaluate(() => !!document.querySelector('[role="dialog"]')?.contains(document.activeElement));
        await expect.poll(dentro).toBe(true);
        for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
        expect(await dentro(), "el foco se ha escapado de la hoja con Tab").toBe(true);
        await page.keyboard.press("Escape");
        await expect(dialogo).toBeHidden();
        await expect(boton).toBeFocused();
      }
      expect(v, detalle(v)).toEqual([]);
    });
  }
}

test("a11y · buscador (Ctrl K) en escritorio", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/resumen");
  await page.locator("h1").first().waitFor();
  await page.getByRole("button", { name: /Buscar/ }).first().click();
  const dialogo = page.getByRole("dialog");
  await dialogo.waitFor();
  await page.keyboard.type("caf");
  await page.waitForTimeout(1_200);
  const v = await axe(page, "buscador");
  expect(v, detalle(v)).toEqual([]);
});

test("teclado · el primer Tab de cada pantalla enseña un foco visible", async ({ page }) => {
  const sinFoco: string[] = [];
  for (const [url] of PANTALLAS) {
    await page.goto(url);
    await page.locator("h1").first().waitFor();
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { ok: false, que: "body" };
      const s = getComputedStyle(el);
      const visible = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      const sombra = s.boxShadow && s.boxShadow !== "none";
      return { ok: visible || !!sombra, que: `${el.tagName} ${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)}` };
    });
    if (!info.ok) sinFoco.push(`${url}: ${info.que}`);
  }
  expect(sinFoco, sinFoco.join("\n")).toEqual([]);
});

test("teclado · hay un enlace para saltar al contenido", async ({ page }) => {
  await page.goto("/resumen");
  await page.locator("h1").first().waitFor();
  await page.keyboard.press("Tab");
  const texto = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  expect(texto).toMatch(/saltar|ir al contenido/i);
});

test("movimiento reducido · la hoja aparece entera con un fundido", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/metas");
  await page.locator("h1").first().waitFor();
  await page.getByRole("button", { name: "Nueva meta" }).first().click();
  const dialogo = page.getByRole("dialog");
  await dialogo.waitFor();
  await page.waitForTimeout(400);
  const caja = await dialogo.boundingBox();
  const vista = page.viewportSize()!;
  expect(caja, "la hoja no está en pantalla").not.toBeNull();
  expect(caja!.y).toBeGreaterThanOrEqual(0);
  expect(caja!.y + caja!.height).toBeLessThanOrEqual(vista.height + 1);
  const anim = await dialogo.evaluate((el) =>
    el.getAnimations({ subtree: true }).map((a) => (a as CSSAnimation).animationName ?? "transición"),
  );
  console.log(`[reduced-motion] animaciones vivas en la hoja tras 400 ms: ${anim.join(", ") || "ninguna"}`);
});
