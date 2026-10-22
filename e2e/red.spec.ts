import { expect, test, type Page } from "@playwright/test";
import { CUENTA_BANCO, elegirOpcion, escaparRegExp } from "./helpers";

/**
 * Robustez ante la red: qué ve el usuario sin conexión o con una conexión que
 * va y viene, y si un movimiento se pierde o se duplica por el camino.
 *
 * Todas las pruebas que guardan algo usan una descripción única con el prefijo
 * «E2E-RED» y la borran al final (también si la prueba falla), para no dejar
 * rastro en la base del usuario de pruebas.
 *
 * Corren en `playwright.config.ts` (local) y en `playwright.prod.config.ts`
 * (contra el despliegue). Las capturas de lo que ve el usuario se adjuntan al
 * informe de la prueba.
 */

const marca = () => `E2E-RED ${Date.now()}`;

/** Rellena un gasto mínimo en «Nuevo movimiento» (sin guardar). */
async function rellenarGasto(page: Page, descripcion: string) {
  await page.goto("/movimientos/nuevo");
  await page.getByRole("heading", { name: "Nuevo movimiento" }).first().waitFor();
  await page.getByRole("radio", { name: "Gasto" }).click();
  await page.getByLabel("Importe").fill("1,23");
  await page.getByLabel("Descripción").fill(descripcion);
  // La cuenta es un Select de Radix (un combobox), no un <select> nativo.
  await elegirOpcion(page.getByLabel("Cuenta", { exact: true }), CUENTA_BANCO);
}

/** Cuántos movimientos hay con esa descripción (en todos los meses). */
async function contar(page: Page, descripcion: string) {
  await page.goto(`/movimientos?mes=todo&q=${encodeURIComponent(descripcion)}`);
  await page.getByRole("heading", { name: "Movimientos" }).first().waitFor();
  return page.getByRole("link", { name: new RegExp(escaparRegExp(descripcion)) }).count();
}

/** Borra por la interfaz todos los movimientos con esa descripción. */
async function borrarTodos(page: Page, descripcion: string) {
  for (let i = 0; i < 6; i++) {
    if ((await contar(page, descripcion)) === 0) return;
    await page.getByRole("link", { name: new RegExp(escaparRegExp(descripcion)) }).first().click();
    await page.waitForURL(/\/movimientos\/[0-9a-f-]{36}/);
    await page.getByRole("button", { name: "Eliminar movimiento" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Eliminar", exact: true }).click();
    await page.waitForURL(/\/movimientos(\?.*)?$/);
  }
}

test.describe("red", () => {
  test("guardar sin conexión no pierde lo escrito y avisa", async ({ page, context }, info) => {
    // HALLAZGO C-1 (docs/pruebas/informe-front.md), ARREGLADO: la acción
    // rechazaba con «Failed to fetch», React lo subía a `(app)/error.tsx` y lo
    // escrito se perdía. Ahora `llamarAccion` (src/lib/llamar-accion.ts) lo
    // convierte en un error del formulario, que se queda intacto.
    const descripcion = marca();
    try {
      await rellenarGasto(page, descripcion);
      await context.setOffline(true);
      await page.getByRole("button", { name: "Guardar", exact: true }).click();
      await page.waitForTimeout(2_500);
      await info.attach("sin-conexion-guardar", { body: await page.screenshot(), contentType: "image/png" });

      // Lo que se espera de una app de dinero: seguir en el formulario, con lo
      // escrito intacto, y un mensaje que diga que no se ha guardado.
      await expect(page).toHaveURL(/\/movimientos\/nuevo/);
      await expect(page.getByLabel("Descripción")).toHaveValue(descripcion);
      await expect(page.getByText(/conexi[oó]n|sin red|no se ha guardado/i).first()).toBeVisible();
      // Y el botón, listo para reintentar.
      await expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled();
    } finally {
      await context.setOffline(false);
      await borrarTodos(page, descripcion);
    }
  });

  test("una doble pulsación en «Guardar» no duplica el movimiento", async ({ page }) => {
    const descripcion = marca();
    try {
      await rellenarGasto(page, descripcion);
      await page.getByRole("button", { name: "Guardar", exact: true }).dblclick();
      await page.waitForURL(/\/movimientos(\?.*)?$/, { timeout: 30_000 });
      expect(await contar(page, descripcion)).toBe(1);
    } finally {
      await borrarTodos(page, descripcion);
    }
  });

  test("Intro repetido en el importe no duplica el movimiento", async ({ page }) => {
    const descripcion = marca();
    try {
      await rellenarGasto(page, descripcion);
      const importe = page.getByLabel("Importe");
      await importe.focus();
      // Dos envíos implícitos seguidos, como un dedo que rebota en el teclado.
      await importe.press("Enter");
      await importe.press("Enter");
      await page.waitForURL(/\/movimientos(\?.*)?$/, { timeout: 30_000 });
      expect(await contar(page, descripcion)).toBe(1);
    } finally {
      await borrarTodos(page, descripcion);
    }
  });

  test("una respuesta lenta del servidor deja el botón bloqueado y no duplica", async ({ page }) => {
    const descripcion = marca();
    try {
      await rellenarGasto(page, descripcion);
      // Retiene 4 s la server action (POST a la misma ruta): red intermitente.
      await page.route("**/movimientos/nuevo", async (route) => {
        if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 4_000));
        await route.continue();
      });
      const guardar = page.getByRole("button", { name: /Guardar$|Guardando/ }).last();
      await page.getByRole("button", { name: "Guardar", exact: true }).click();
      await expect(page.getByRole("button", { name: "Guardando…" })).toBeDisabled();
      await guardar.click({ force: true, trial: false }).catch(() => {});
      await page.waitForURL(/\/movimientos(\?.*)?$/, { timeout: 30_000 });
      await page.unroute("**/movimientos/nuevo");
      expect(await contar(page, descripcion)).toBe(1);
    } finally {
      await borrarTodos(page, descripcion);
    }
  });

  test("recargar a mitad de la hoja conserva el borrador", async ({ page }) => {
    // HALLAZGO M-6, ARREGLADO: el formulario guarda un borrador en
    // sessionStorage (src/lib/borrador.ts) y lo recupera al volver.
    const descripcion = marca();
    await rellenarGasto(page, descripcion);
    await page.reload();
    await page.getByRole("heading", { name: "Nuevo movimiento" }).first().waitFor();
    await expect(page.getByLabel("Descripción")).toHaveValue(descripcion);
    await expect(page.getByLabel("Importe")).toHaveValue("1,23");
    await expect(page.getByText("Hemos recuperado lo que estabas escribiendo.")).toBeVisible();
    // «Cancelar» con cambios pide un segundo toque, y descartar borra el borrador.
    await page.getByRole("button", { name: "Cancelar", exact: true }).click();
    await page.getByRole("button", { name: "Descartar", exact: true }).click();
    // «Cancelar» vuelve atrás en el historial (aquí no hay pantalla anterior).
    await page.waitForTimeout(500);
    await page.goto("/movimientos/nuevo");
    await page.getByRole("heading", { name: "Nuevo movimiento" }).first().waitFor();
    await expect(page.getByLabel("Descripción")).toHaveValue("");
  });

  test("cerrar una hoja con cambios pregunta antes de descartarlos", async ({ page }) => {
    await page.goto("/metas");
    await page.getByRole("heading", { name: "Metas" }).first().waitFor();
    await page.getByRole("button", { name: /nueva meta/i }).first().click();
    const hoja = page.getByRole("dialog");
    await hoja.getByLabel("Nombre").fill("E2E-RED meta a medias");
    await page.keyboard.press("Escape");
    // No se cierra: pregunta.
    await expect(hoja.getByText("¿Descartar los cambios?")).toBeVisible();
    await hoja.getByRole("button", { name: "Seguir editando" }).click();
    await expect(hoja.getByLabel("Nombre")).toHaveValue("E2E-RED meta a medias");
    // La X también pregunta, y «Descartar» cierra de verdad.
    await hoja.getByRole("button", { name: "Cerrar" }).click();
    await hoja.getByRole("button", { name: "Descartar", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("navegar sin conexión enseña la página de cortesía", async ({ page, context }, info) => {
    // HALLAZGO A-3 (arreglado): antes se guardaba el HTML de /sin-conexion pero
    // no el chunk de JS de esa página, y sin conexión la hidratación reventaba
    // con ChunkLoadError («La app no ha podido arrancar»). Ahora el service
    // worker guarda la página CON sus recursos al instalarse.
    await page.goto("/resumen");
    await page.getByRole("heading", { name: "Resumen" }).first().waitFor();
    // Que el service worker esté instalado y controle la página.
    await page.evaluate(() => navigator.serviceWorker?.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(true);

    await context.setOffline(true);
    try {
      // Navegación de documento (p. ej. abrir la app instalada sin red).
      await page.goto("/movimientos").catch(() => {});
      await expect(page.getByRole("heading", { name: /no hay conexi[oó]n/i })).toBeVisible();
      // El HTML guardado se pinta enseguida; lo que fallaba era la hidratación,
      // que pedía un chunk que no estaba en caché. Se espera a que termine.
      await page.waitForTimeout(3_000);
      await expect(page.getByRole("heading", { name: /no hay conexi[oó]n/i })).toBeVisible();
      await expect(page.getByText(/algo ha fallado|no ha podido arrancar/i)).toHaveCount(0);
      await info.attach("sin-conexion-documento", { body: await page.screenshot(), contentType: "image/png" });
    } finally {
      await context.setOffline(false);
    }
  });

  test("navegar en cliente sin conexión no deja la app colgada", async ({ page, context }, info) => {
    await page.goto("/resumen");
    await page.getByRole("heading", { name: "Resumen" }).first().waitFor();
    await page.evaluate(() => navigator.serviceWorker?.ready);
    await context.setOffline(true);
    try {
      // Pulsar un enlace de la barra: el router pide el RSC y la red falla. Se
      // toca en sus coordenadas, como un dedo (el `click()` de Playwright espera
      // a que nada lo tape y, con la barra de cristal fija, a veces se lía).
      const caja = await page.locator('a[href="/cuentas"]:visible').first().boundingBox();
      await page.mouse.click(caja!.x + caja!.width / 2, caja!.y + caja!.height / 2);
      await page.waitForTimeout(4_000);
      await info.attach("sin-conexion-cliente", { body: await page.screenshot(), contentType: "image/png" });
      // O llega a la página de cortesía, o enseña un aviso: nunca un toque mudo.
      const aviso = page.getByRole("heading", { name: /no hay conexi[oó]n|no hemos podido|algo ha fallado/i }).first();
      await expect(aviso).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
