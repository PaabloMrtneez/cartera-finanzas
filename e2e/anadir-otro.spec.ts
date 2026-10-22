import { expect, test, type Page } from "@playwright/test";
import { CUENTA_VISA, elegirOpcion, escaparRegExp } from "./helpers";

/**
 * «Guardar y añadir otro» deja el formulario listo para el siguiente
 * movimiento de una tanda: limpia importe y descripción y CONSERVA la cuenta
 * (es lo que promete el comentario de `transaction-form.tsx`: «se conserva lo
 * que en una tanda se repite: cuenta, categoría y fecha»).
 *
 * El botón solo existe en escritorio (`lg:`): la prueba corre a 1440 px.
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** Borra por la interfaz los movimientos con esa descripción. */
async function borrarTodos(page: Page, descripcion: string) {
  for (let i = 0; i < 4; i++) {
    await page.goto(`/movimientos?mes=todo&q=${encodeURIComponent(descripcion)}`);
    await page.getByRole("heading", { name: "Movimientos" }).first().waitFor();
    const enlace = page.getByRole("link", { name: new RegExp(escaparRegExp(descripcion)) });
    if ((await enlace.count()) === 0) return;
    await enlace.first().click();
    await page.waitForURL(/\/movimientos\/[0-9a-f-]{36}/);
    await page.getByRole("button", { name: "Eliminar movimiento" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Eliminar", exact: true }).click();
    await page.waitForURL(/\/movimientos(\?.*)?$/);
  }
}

test("«Guardar y añadir otro» guarda y conserva la cuenta elegida", async ({ page }) => {
  // Antes, tras `form.reset()`, el Select de Radix volvía a su valor inicial y
  // la cuenta se perdía. Arreglado haciendo controlados la cuenta y el destino
  // en `transaction-form.tsx`; esta prueba lo vigila.
  const descripcion = `E2E-OTRO ${Date.now()}`;
  try {
    await page.goto("/movimientos/nuevo");
    await page.getByRole("heading", { name: "Nuevo movimiento" }).first().waitFor();
    await page.getByRole("radio", { name: "Gasto" }).click();
    await page.getByLabel("Importe").fill("1,11");
    await page.getByLabel("Descripción").fill(descripcion);
    const cuenta = page.getByLabel("Cuenta", { exact: true });
    await elegirOpcion(cuenta, CUENTA_VISA);

    await page.getByRole("button", { name: "Guardar y añadir otro" }).click();
    // Guardado: el formulario se vacía para el siguiente.
    await expect(page.getByLabel("Importe")).toHaveValue("", { timeout: 15_000 });
    await expect(page).toHaveURL(/\/movimientos\/nuevo/);
    await expect(cuenta).toContainText(CUENTA_VISA);
  } finally {
    await borrarTodos(page, descripcion);
  }
});
