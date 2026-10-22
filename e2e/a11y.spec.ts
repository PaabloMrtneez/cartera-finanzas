import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Result } from "axe-core";

/**
 * Auditoría de accesibilidad automatizada con axe-core sobre las nueve pantallas
 * clave, ya autenticadas (el `storageState` del `global-setup` lleva la sesión
 * con segundo factor; sin aal2 la base no devuelve ni una fila).
 *
 * QUÉ COMPRUEBA. Se afirman EN VERDE las reglas WCAG 2.0/2.1 nivel A y AA, sin
 * excepciones: incluido `color-contrast`. Antes se aplazaba —los únicos fallos
 * salían de los colores de marca (el latón `--accent` y el gris `--muted`) sobre
 * crema, y calibrarlos era una decisión de identidad—, pero la paleta B · Lino
 * ya reparte el latón en dos tintas (`--accent` para rellenos, `--accent-text`
 * para el latón como texto) y templa los semánticos hasta cumplir AA en todos
 * los pares, en claro y en oscuro. Así que el contraste vuelve a ser bloqueante.
 *
 * Cada pantalla sigue registrando por consola todas sus violaciones, para tener
 * el recuento por impacto y regla a mano.
 */

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const PANTALLAS = [
  { nombre: "Resumen", url: "/resumen", heading: "Resumen" },
  { nombre: "Movimientos", url: "/movimientos", heading: "Movimientos" },
  { nombre: "Nuevo movimiento", url: "/movimientos/nuevo", heading: "Nuevo movimiento" },
  { nombre: "Análisis", url: "/analisis", heading: "Análisis" },
  { nombre: "Inversiones", url: "/inversiones", heading: "Inversiones" },
  { nombre: "Patrimonio", url: "/patrimonio", heading: "Patrimonio" },
  { nombre: "Cuentas", url: "/cuentas", heading: "Cuentas" },
  { nombre: "Metas", url: "/metas", heading: "Metas" },
  { nombre: "Fijos · gastos", url: "/fijos?ver=gastos", heading: "Fijos" },
  { nombre: "Fijos · ingresos", url: "/fijos?ver=ingresos", heading: "Fijos" },
  { nombre: "Préstamos", url: "/prestamos", heading: "Préstamos" },
  { nombre: "Ajustes", url: "/ajustes", heading: "Ajustes" },
] as const;

/**
 * El indicador de desarrollo de Next se inyecta en `nextjs-portal`, se ancla
 * abajo y no existe en producción: se excluye del análisis para no auditar algo
 * que el usuario nunca ve. El escáner de producción no lo tendría.
 */
function axe(page: Page) {
  return new AxeBuilder({ page }).withTags(WCAG).exclude("nextjs-portal");
}

/** Vuelca por consola todas las violaciones de una pantalla, para el informe. */
function registrar(etiqueta: string, violaciones: Result[]) {
  if (violaciones.length === 0) {
    console.log(`[a11y] ${etiqueta}: sin violaciones`);
    return;
  }
  const lineas = violaciones.map((v) => {
    const dianas = v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ");
    return `  · [${v.impact}] ${v.id} ×${v.nodes.length} — ${dianas}`;
  });
  console.log(`[a11y] ${etiqueta}: ${violaciones.length} regla(s)\n${lineas.join("\n")}`);
}

/** Mensaje legible cuando una regla bloqueante falla la aserción. */
function detalle(violaciones: Result[]) {
  return violaciones
    .map((v) => `[${v.impact}] ${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
    .join("\n");
}

async function analizar(page: Page, etiqueta: string) {
  const { violations } = await axe(page).analyze();
  registrar(etiqueta, violations);
  return violations;
}

for (const pantalla of PANTALLAS) {
  test(`a11y móvil · ${pantalla.nombre}`, async ({ page }) => {
    await page.goto(pantalla.url);
    await page
      .getByRole("heading", { name: pantalla.heading, exact: true })
      .first()
      .waitFor();

    const bloqueantes = await analizar(page, `móvil/${pantalla.nombre}`);
    expect(bloqueantes, detalle(bloqueantes)).toEqual([]);
  });
}

test("a11y móvil · diálogo «Nueva posición» abierto", async ({ page }) => {
  await page.goto("/inversiones");
  await page.getByRole("heading", { name: "Inversiones", exact: true }).waitFor();

  // El disparador es de solo icono en móvil: su nombre accesible viene del
  // aria-label. Si esto no lo encuentra, es que el botón se quedó sin nombre.
  await page.getByRole("button", { name: "Nueva posición" }).first().click();
  const dialogo = page.getByRole("dialog");
  await dialogo.waitFor();
  await page.getByLabel("Nombre").waitFor();

  const bloqueantes = await analizar(page, "móvil/diálogo Nueva posición");
  expect(bloqueantes, detalle(bloqueantes)).toEqual([]);
});

test("a11y móvil · alta de un préstamo, con su vista previa", async ({ page }) => {
  await page.goto("/prestamos");
  await page.getByRole("heading", { name: "Préstamos", exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Nuevo préstamo" }).first().click();
  const dialogo = page.getByRole("dialog");
  await dialogo.waitFor();
  await dialogo.getByLabel("Importe prestado").fill("6.000,00");
  await dialogo.getByLabel("Plazo", { exact: true }).fill("24");
  await dialogo.getByLabel("TIN", { exact: true }).fill("7,25");
  await dialogo.getByTestId("cuota-prevista").waitFor();

  const bloqueantes = await analizar(page, "móvil/alta de préstamo");
  expect(bloqueantes, detalle(bloqueantes)).toEqual([]);
});

test("a11y · el diálogo atrapa el foco y lo devuelve al cerrarse", async ({ page }) => {
  await page.goto("/inversiones");
  await page.getByRole("heading", { name: "Inversiones", exact: true }).waitFor();

  const disparador = page.getByRole("button", { name: "Nueva posición" }).first();
  await disparador.click();

  const dialogo = page.getByRole("dialog");
  await dialogo.waitFor();

  // El foco entra en el diálogo (Radix lo mueve al primer campo real).
  await expect(async () => {
    const dentro = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return !!dlg && dlg.contains(document.activeElement);
    });
    expect(dentro).toBe(true);
  }).toPass();

  // Escape cierra y el foco vuelve al disparador que lo abrió.
  await page.keyboard.press("Escape");
  await expect(dialogo).toBeHidden();
  await expect(disparador).toBeFocused();
});

test("a11y modo oscuro · Resumen y Patrimonio (banda de tinta)", async ({ page }) => {
  // El tema se aplica por `data-theme` (ThemeScript lo pone antes de pintar).
  await page.addInitScript(() => {
    try {
      localStorage.setItem("cartera:theme", "dark");
    } catch {
      /* sin storage, el initScript de abajo igualmente fija el atributo */
    }
  });

  for (const url of ["/resumen", "/patrimonio"] as const) {
    await page.goto(url);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.locator("h1").first().waitFor();
    const modo = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(modo).toBe("dark");

    const bloqueantes = await analizar(page, `oscuro${url}`);
    expect(bloqueantes, detalle(bloqueantes)).toEqual([]);
  }
});

test("a11y escritorio · Resumen con barra lateral (1440 px)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/resumen");
  await page.getByRole("heading", { name: "Resumen", exact: true }).waitFor();

  const bloqueantes = await analizar(page, "escritorio/Resumen");
  expect(bloqueantes, detalle(bloqueantes)).toEqual([]);
});
