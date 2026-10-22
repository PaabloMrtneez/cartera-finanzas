import { expect, test } from "@playwright/test";
import { CUENTA_BANCO, elegirOpcion, escaparRegExp, guardarMovimiento } from "./helpers";

/**
 * Apuntar un gasto a mano y comprobar que aparece en la lista de Movimientos.
 *
 * La categoría es opcional a propósito (se puede guardar sin clasificar), así que
 * no se toca: la prueba no depende de que el usuario tenga categorías sembradas.
 */
test("un gasto manual aparece en la lista de Movimientos", async ({ page }) => {
  const descripcion = `Gasto E2E ${Date.now()}`;

  await page.goto("/movimientos/nuevo");

  // «Gasto» es el tipo por defecto; se marca de forma explícita por claridad.
  await page.getByRole("radio", { name: "Gasto" }).click();
  await page.getByLabel("Importe").fill("12,34");
  await page.getByLabel("Descripción").fill(descripcion);
  await elegirOpcion(page.getByLabel("Cuenta", { exact: true }), CUENTA_BANCO);

  await guardarMovimiento(page);

  // El enlace del movimiento (getByRole descarta la vista oculta de la otra
  // anchura, que no está en el árbol de accesibilidad).
  const fila = page.getByRole("link", { name: new RegExp(escaparRegExp(descripcion)) });
  await expect(fila).toBeVisible();
});
