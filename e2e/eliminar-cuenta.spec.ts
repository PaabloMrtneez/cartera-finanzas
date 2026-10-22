import { expect, test, type Page } from "@playwright/test";
import { CUENTA_BANCO, elegirOpcion, escaparRegExp, guardarMovimiento } from "./helpers";

/**
 * Eliminar una cuenta con todo lo suyo, escribiendo su nombre.
 *
 * Crea una cuenta desechable, le apunta un gasto, abre «Eliminar cuenta», lee
 * el recuento («Se borrarán 1 movimiento»), comprueba que el botón final no se
 * activa hasta escribir el nombre EXACTO y la elimina. Al final ni la cuenta ni
 * su gasto deben seguir ahí.
 *
 * Necesita la migración 20261007090000_eliminar_cuentas.sql aplicada en la base
 * contra la que corre el e2e. Si aún no lo está, la prueba lo detecta ANTES de
 * crear nada —abriendo la confirmación de una cuenta existente, que solo lee— y
 * se salta con un mensaje claro, sin dejar basura en la base.
 */

/** Abre la hoja de edición de una cuenta y pasa a la confirmación del borrado. */
async function abrirEliminar(page: Page, nombre: string) {
  await page.goto("/cuentas");
  await page.getByRole("button", { name: `Editar ${nombre}`, exact: true }).click();
  await page.getByRole("button", { name: "Eliminar cuenta", exact: true }).click();
}

/** Espera al preview: o el campo de confirmar, o un error. Devuelve el error. */
async function esperarPreview(page: Page): Promise<string | null> {
  const campo = page.getByLabel(/para confirmar/);
  const error = page.getByRole("alert");
  await expect(campo.or(error).first()).toBeVisible({ timeout: 20_000 });
  if (await campo.isVisible()) return null;
  return (await error.first().innerText()).trim();
}

test("eliminar una cuenta escribiendo su nombre la borra con sus movimientos", async ({ page }) => {
  // 1. ¿Está la función en la base? Se mira en una cuenta que ya existe: el
  //    preview solo lee, y «Volver» deja todo como estaba.
  await abrirEliminar(page, CUENTA_BANCO);
  const sinFuncion = await esperarPreview(page);
  test.skip(
    sinFuncion !== null && /aún no está disponible|could not find the function|schema cache/i.test(sinFuncion),
    "La migración 20261007090000_eliminar_cuentas.sql aún no está aplicada en la base: aplica la migración y vuelve a correr este e2e.",
  );
  expect(sinFuncion, "el preview de una cuenta existente debería cargar").toBeNull();
  await page.getByRole("button", { name: "Volver", exact: true }).click();
  await page.getByRole("button", { name: "Cerrar" }).click();

  // 2. Cuenta desechable con un gasto.
  const nombre = `E2E borrar ${Date.now()}`;
  const descripcion = `Gasto ${nombre}`;

  await page.goto("/cuentas");
  await page.getByRole("button", { name: "Nueva cuenta" }).click();
  await page.getByLabel("Nombre").fill(nombre);
  await page.getByLabel("Saldo inicial").fill("10,00");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByRole("button", { name: `Editar ${nombre}`, exact: true })).toBeVisible();

  await page.goto("/movimientos/nuevo");
  await page.getByRole("radio", { name: "Gasto" }).click();
  await page.getByLabel("Importe").fill("1,23");
  await page.getByLabel("Descripción").fill(descripcion);
  await elegirOpcion(page.getByLabel("Cuenta", { exact: true }), nombre);
  await guardarMovimiento(page);
  await expect(page.getByRole("link", { name: new RegExp(escaparRegExp(descripcion)) })).toBeVisible();

  // 3. La confirmación: el recuento, y el botón cerrado hasta escribir el nombre.
  await abrirEliminar(page, nombre);
  expect(await esperarPreview(page)).toBeNull();
  await expect(page.getByText("Se borrarán 1 movimiento.", { exact: true })).toBeVisible();

  const confirmar = page.getByRole("button", { name: "Eliminar cuenta", exact: true });
  await expect(confirmar).toBeDisabled();
  await page.getByLabel(/para confirmar/).fill(nombre.toUpperCase());
  await expect(confirmar).toBeDisabled();
  await page.getByLabel(/para confirmar/).fill(nombre);
  await expect(confirmar).toBeEnabled();
  await confirmar.click();

  // 4. Ni la cuenta ni su gasto siguen ahí.
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: `Editar ${nombre}`, exact: true })).toHaveCount(0);
  await page.goto("/movimientos");
  await expect(page.getByRole("link", { name: new RegExp(escaparRegExp(descripcion)) })).toHaveCount(0);
});
