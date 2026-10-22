import { expect, test } from "@playwright/test";
import { CUENTA_BANCO, elegirOpcion, escaparRegExp, guardarMovimiento } from "./helpers";

/**
 * Un ingreso que reembolsa un gasto no cuenta como ingreso: abarata el gasto. La
 * pantalla del gasto lo cuenta con «Te costó de verdad».
 *
 * Se crean los dos movimientos que hacen falta —el gasto y el ingreso que lo
 * reembolsa— para que la prueba sea autónoma y no dependa de datos previos.
 */
test("un ingreso que reembolsa un gasto rebaja el coste real", async ({ page }) => {
  const marca = Date.now();
  const gasto = `Cena reembolsable ${marca}`;
  const ingreso = `Devolucion ${marca}`;

  // 1 · El gasto: 40,00 €.
  await page.goto("/movimientos/nuevo");
  await page.getByRole("radio", { name: "Gasto" }).click();
  await page.getByLabel("Importe").fill("40,00");
  await page.getByLabel("Descripción").fill(gasto);
  await elegirOpcion(page.getByLabel("Cuenta", { exact: true }), CUENTA_BANCO);
  await guardarMovimiento(page);

  // 2 · El ingreso de 15,00 € enlazado a ese gasto.
  await page.goto("/movimientos/nuevo");
  await page.getByRole("radio", { name: "Ingreso" }).click();
  await page.getByLabel("Importe").fill("15,00");
  await page.getByLabel("Descripción").fill(ingreso);
  await elegirOpcion(page.getByLabel("Cuenta", { exact: true }), CUENTA_BANCO);

  await page.getByRole("button", { name: "Reembolsa un gasto" }).click();
  const dialogo = page.getByRole("dialog", { name: "¿Qué gasto reembolsa?" });
  await dialogo.getByLabel("Buscar un gasto").fill(gasto);
  await dialogo
    .getByRole("button", { name: new RegExp(escaparRegExp(gasto)) })
    .click();

  await guardarMovimiento(page);

  // 3 · En la ficha del gasto tiene que aparecer el coste real.
  await page.getByRole("link", { name: new RegExp(escaparRegExp(gasto)) }).click();
  await page.waitForURL(/\/movimientos\/[0-9a-f-]+(\?.*)?$/);

  await expect(page.getByText("Te costó de verdad")).toBeVisible();
  // Pagados 40,00 € y devueltos 15,00 € → costó de verdad 25,00 €.
  await expect(
    page.getByText(/Pagaste\s.*40,00.*devolvieron\s.*15,00/),
  ).toBeVisible();
});
