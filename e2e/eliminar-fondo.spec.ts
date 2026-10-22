import { expect, test, type Page } from "@playwright/test";
import {
  CUENTA_BANCO,
  CUENTA_INVERSION,
  elegirOpcion,
  escaparRegExp,
  guardarMovimiento,
  POSICION,
} from "./helpers";

/**
 * Eliminar un fondo con sus aportaciones, escribiendo su nombre.
 *
 * Crea un fondo desechable, le aporta 1,23 € con un traspaso desde la cuenta
 * de banco, abre «Eliminar fondo», lee el resumen («Se borrarán 1 aportación
 * (1,23 €).» y que el saldo de la cuenta de origen subirá eso), comprueba que
 * el botón final no se activa hasta escribir el nombre EXACTO y lo elimina. Al
 * final ni el fondo ni su aportación deben seguir ahí.
 *
 * Necesita la migración 20261008100000_eliminar_fondos.sql aplicada en la base
 * contra la que corre el e2e. Si aún no lo está, la prueba lo detecta ANTES de
 * crear nada —abriendo la confirmación de un fondo existente, que solo lee— y
 * se salta con un mensaje claro, sin dejar basura en la base.
 */

/** Abre la hoja de edición de un fondo y pasa a la confirmación del borrado. */
async function abrirEliminar(page: Page, nombre: string) {
  await page.goto("/inversiones");
  await page.getByRole("button", { name: `Editar ${nombre}`, exact: true }).click();
  await page.getByRole("button", { name: "Eliminar fondo", exact: true }).click();
}

/** Espera al preview: o el campo de confirmar, o un error. Devuelve el error. */
async function esperarPreview(page: Page): Promise<string | null> {
  const campo = page.getByLabel(/para confirmar/);
  const error = page.getByRole("dialog").getByRole("alert");
  await expect(campo.or(error).first()).toBeVisible({ timeout: 20_000 });
  if (await campo.isVisible()) return null;
  return (await error.first().innerText()).trim();
}

test("eliminar un fondo escribiendo su nombre lo borra con sus aportaciones", async ({ page }) => {
  // 1. ¿Está la función en la base? Se mira en un fondo que ya existe: el
  //    preview solo lee, y «Volver» deja todo como estaba.
  await abrirEliminar(page, POSICION);
  const sinFuncion = await esperarPreview(page);
  test.skip(
    sinFuncion !== null && /aún no está disponible|could not find the function|schema cache/i.test(sinFuncion),
    "La migración 20261008100000_eliminar_fondos.sql aún no está aplicada en la base: aplica la migración y vuelve a correr este e2e.",
  );
  expect(sinFuncion, "el preview de un fondo existente debería cargar").toBeNull();
  await page.getByRole("button", { name: "Volver", exact: true }).click();
  await page.getByRole("button", { name: "Cerrar" }).click();

  // 2. Fondo desechable con una aportación.
  const nombre = `E2E fondo ${Date.now()}`;
  const descripcion = `Aportación ${nombre}`;

  await page.goto("/inversiones");
  await page.getByRole("button", { name: "Nueva posición", exact: true }).click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByLabel("Nombre").fill(nombre);
  await elegirOpcion(dialogo.getByLabel("Cuenta de inversión", { exact: true }), CUENTA_INVERSION);
  await dialogo.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialogo).toBeHidden();
  await expect(page.getByRole("button", { name: `Editar ${nombre}`, exact: true })).toBeVisible();

  await page.goto("/movimientos/nuevo");
  await page.getByRole("radio", { name: "Traspaso" }).click();
  await page.getByLabel("Importe").fill("1,23");
  await page.getByLabel("Descripción").fill(descripcion);
  await elegirOpcion(page.getByLabel("Origen", { exact: true }), CUENTA_BANCO);
  await elegirOpcion(page.getByLabel("Destino", { exact: true }), CUENTA_INVERSION);
  await elegirOpcion(page.getByLabel("¿A qué posición?", { exact: true }), nombre);
  await guardarMovimiento(page);
  await expect(page.getByRole("link", { name: new RegExp(escaparRegExp(descripcion)) })).toBeVisible();

  // 3. La confirmación: el resumen, y el botón cerrado hasta escribir el nombre.
  await abrirEliminar(page, nombre);
  expect(await esperarPreview(page)).toBeNull();
  const hoja = page.getByRole("dialog");
  await expect(hoja.getByText(/^Se borrarán 1 aportación \(1,23\s€\)\.$/)).toBeVisible();
  await expect(
    hoja.getByText(new RegExp(`^El saldo de ${escaparRegExp(CUENTA_BANCO)} subirá 1,23\\s€\\.$`)),
  ).toBeVisible();
  await expect(
    hoja.getByText(new RegExp(`^El saldo de ${escaparRegExp(CUENTA_INVERSION)} bajará 1,23\\s€\\.$`)),
  ).toBeVisible();
  await expect(hoja.getByRole("button", { name: "Archivar en su lugar" })).toBeVisible();

  const confirmar = hoja.getByRole("button", { name: "Eliminar fondo", exact: true });
  await expect(confirmar).toBeDisabled();
  await page.getByLabel(/para confirmar/).fill(nombre.toUpperCase());
  await expect(confirmar).toBeDisabled();
  await page.getByLabel(/para confirmar/).fill(nombre);
  await expect(confirmar).toBeEnabled();
  await confirmar.click();

  // 4. Ni el fondo ni su aportación siguen ahí.
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: `Editar ${nombre}`, exact: true })).toHaveCount(0);
  await page.goto("/movimientos");
  await expect(page.getByRole("link", { name: new RegExp(escaparRegExp(descripcion)) })).toHaveCount(0);
});
