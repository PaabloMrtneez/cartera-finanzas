import { expect, test, type Page } from "@playwright/test";
import {
  CUENTA_BANCO,
  CUENTA_VISA,
  elegirOpcion,
  escaparRegExp,
  guardarMovimiento,
  saldoDeCuenta,
} from "./helpers";

/**
 * Editar y borrar un movimiento mueve el saldo de verdad (huecos P1 2 y 3 del
 * informe de robustez: `updateTransaction` y `deleteTransaction`).
 *
 * Los saldos no se guardan: se derivan de los movimientos. Así que cambiar el
 * importe o la cuenta de un gasto tiene que devolverle el dinero a la cuenta de
 * antes y cobrárselo a la nueva, y borrarlo tiene que dejarlo todo como estaba.
 *
 * El movimiento lleva el prefijo «E2E-EDITAR» y se borra al final también si la
 * prueba falla, para no dejar rastro en el usuario de pruebas.
 */

const marca = () => `E2E-EDITAR ${Date.now()}`;

/** El enlace del movimiento en la lista (buscando en todos los meses). */
async function abrirLista(page: Page, descripcion: string) {
  await page.goto(`/movimientos?mes=todo&q=${encodeURIComponent(descripcion)}`);
  await page.getByRole("heading", { name: "Movimientos" }).first().waitFor();
  return page.getByRole("link", { name: new RegExp(escaparRegExp(descripcion)) });
}

async function abrirDetalle(page: Page, descripcion: string) {
  const enlace = await abrirLista(page, descripcion);
  await enlace.first().click();
  await page.waitForURL(/\/movimientos\/[0-9a-f-]{36}/);
}

async function borrar(page: Page) {
  await page.getByRole("button", { name: "Eliminar movimiento" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Eliminar", exact: true }).click();
  await page.waitForURL(/\/movimientos(\?.*)?$/);
}

test("editar el importe y la cuenta mueve los saldos; borrarlo los devuelve", async ({ page }) => {
  const descripcion = marca();
  const nominaAntes = await saldoDeCuenta(page, CUENTA_BANCO);
  const visaAntes = await saldoDeCuenta(page, CUENTA_VISA);

  try {
    // 1 · Un gasto de 12,34 € en Nomina.
    await page.goto("/movimientos/nuevo");
    await page.getByRole("radio", { name: "Gasto" }).click();
    await page.getByLabel("Importe").fill("12,34");
    await page.getByLabel("Descripción").fill(descripcion);
    await elegirOpcion(page.getByLabel("Cuenta", { exact: true }), CUENTA_BANCO);
    await guardarMovimiento(page);
    expect(await saldoDeCuenta(page, CUENTA_BANCO)).toBe(nominaAntes - 1_234);

    // 2 · Editarlo: 20,00 € y a Visa. Nomina recupera lo suyo y Visa lo paga.
    await abrirDetalle(page, descripcion);
    await expect(page.getByLabel("Importe")).toHaveValue(/12,34/);
    await page.getByLabel("Importe").fill("20,00");
    await elegirOpcion(page.getByLabel("Cuenta", { exact: true }), CUENTA_VISA);
    await guardarMovimiento(page);

    const fila = (await abrirLista(page, descripcion)).first();
    await expect(fila).toContainText("20,00");
    await expect(await abrirLista(page, descripcion)).toHaveCount(1);
    expect(await saldoDeCuenta(page, CUENTA_BANCO)).toBe(nominaAntes);
    expect(await saldoDeCuenta(page, CUENTA_VISA)).toBe(visaAntes - 2_000);

    // 3 · Borrarlo: desaparece y los dos saldos vuelven a ser los de antes.
    await abrirDetalle(page, descripcion);
    await borrar(page);
    await expect(await abrirLista(page, descripcion)).toHaveCount(0);
    expect(await saldoDeCuenta(page, CUENTA_BANCO)).toBe(nominaAntes);
    expect(await saldoDeCuenta(page, CUENTA_VISA)).toBe(visaAntes);
  } finally {
    // Limpieza, también si algo de arriba falló.
    for (let i = 0; i < 3; i++) {
      if ((await (await abrirLista(page, descripcion)).count()) === 0) break;
      await abrirDetalle(page, descripcion);
      await borrar(page);
    }
  }
});
