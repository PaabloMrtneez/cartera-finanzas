import { expect, test, type Page } from "@playwright/test";
import {
  conSigno,
  CUENTA_BANCO,
  elegirOpcion,
  haceMeses,
  hoyEnMadrid,
  saldoDeCuenta,
} from "./helpers";

/**
 * Liquidar un préstamo antes de tiempo (hueco P1 5 del informe de robustez:
 * `settleLoan`).
 *
 * Liquidar paga de golpe lo pendiente con un traspaso desde la cuenta de pago a
 * la del préstamo, y la comisión de cancelación como gasto. Se comprueba que:
 *
 *   · la deuda (el saldo de la cuenta-pasivo) queda a cero;
 *   · la cuenta de pago baja exactamente lo pendiente más la comisión;
 *   · la ficha dice «Liquidado» y ya no ofrece «Liquidar» otra vez;
 *   · y que, al eliminarlo, el saldo vuelve a ser el de antes del alta.
 *
 * El préstamo lleva el prefijo «E2E-LIQUIDAR» y se elimina al final también si
 * la prueba falla.
 */

/** El saldo de la cuenta-pasivo del préstamo en Cuentas (negativo: se debe). */
async function saldoPrestamo(page: Page, nombre: string): Promise<number> {
  await page.goto("/cuentas");
  const fila = page
    .locator("li")
    .filter({ has: page.getByRole("link", { name: `Ver el préstamo de Préstamo · ${nombre}` }) });
  await expect(fila).toBeVisible();
  const importes = (await fila.innerText()).match(/[−-]?[\d.]+,\d{2}\s€/g) ?? [];
  expect(importes.length, "la fila del préstamo debería llevar su saldo").toBeGreaterThan(0);
  return conSigno(importes[importes.length - 1]);
}

/** Abre la hoja de gestión del préstamo. */
async function abrirGestion(page: Page, nombre: string) {
  await page.goto("/prestamos");
  await page.getByRole("heading", { name: "Préstamos", exact: true }).first().waitFor();
  await page.getByRole("button", { name: `Editar ${nombre}`, exact: true }).click();
  const hoja = page.getByRole("dialog");
  await expect(hoja).toBeVisible();
  return hoja;
}

/** Lo elimina escribiendo su nombre, como pide la interfaz. */
async function eliminar(page: Page, nombre: string) {
  const hoja = await abrirGestion(page, nombre);
  await hoja.getByRole("button", { name: "Eliminar préstamo" }).click();
  const confirmar = page.getByLabel(/para confirmar/);
  await expect(confirmar).toBeVisible({ timeout: 20_000 });
  await confirmar.fill(nombre);
  await hoja.getByRole("button", { name: "Eliminar préstamo" }).click();
  await expect(hoja).toBeHidden({ timeout: 20_000 });
}

test("liquidar un préstamo paga lo pendiente y la comisión y deja la deuda a cero", async ({ page }) => {
  const hoy = hoyEnMadrid();
  const nombre = `E2E-LIQUIDAR ${Date.now()}`;
  const saldoAntes = await saldoDeCuenta(page, CUENTA_BANCO);
  let creado = false;

  try {
    // 1 · El alta: 6000 € a 24 meses, firmado hace cuatro (con cuotas ya cobradas).
    await page.goto("/prestamos");
    await page.getByRole("heading", { name: "Préstamos", exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Nuevo préstamo" }).first().click();
    const alta = page.getByRole("dialog");
    await alta.getByLabel("Nombre", { exact: true }).fill(nombre);
    await elegirOpcion(alta.getByLabel("Cuenta de pago", { exact: true }), CUENTA_BANCO);
    await alta.getByLabel("Importe prestado").fill("6.000,00");
    await alta.getByLabel("Plazo", { exact: true }).fill("24");
    await alta.getByLabel("TIN", { exact: true }).fill("7,25");
    await alta.getByRole("radio", { name: /El dinero entra ahora/ }).check();
    await alta.getByLabel("Fecha de la firma").fill(haceMeses(hoy, 4));
    await alta.getByRole("button", { name: "Guardar préstamo" }).click();
    await expect(alta).toBeHidden({ timeout: 20_000 });
    creado = true;
    await expect(page.getByRole("region", { name: nombre })).toBeVisible();

    const deuda = -(await saldoPrestamo(page, nombre));
    expect(deuda, "con cuotas cobradas, se debe algo pero menos de lo prestado").toBeGreaterThan(0);
    expect(deuda).toBeLessThan(600_000);
    const saldoTrasAlta = await saldoDeCuenta(page, CUENTA_BANCO);

    // 2 · Liquidar hoy, con 10 € de comisión de cancelación.
    const hoja = await abrirGestion(page, nombre);
    await hoja.getByRole("button", { name: "Liquidar", exact: true }).click();
    await expect(hoja.getByRole("heading", { name: `Liquidar ${nombre}` })).toBeVisible();
    await expect(hoja.getByLabel("Fecha", { exact: true })).toHaveValue(hoy);
    await hoja.getByLabel("Comisión (opcional)").fill("10,00");
    await hoja.getByRole("button", { name: "Liquidar", exact: true }).click();
    await expect(hoja).toBeHidden({ timeout: 20_000 });

    // 3 · La ficha lo da por liquidado y no deja liquidarlo otra vez.
    const ficha = page.getByRole("region", { name: nombre });
    await expect(ficha).toContainText(/Liquidado/);
    const gestion = await abrirGestion(page, nombre);
    await expect(gestion.getByRole("button", { name: "Liquidar", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // 4 · Deuda a cero; la cuenta de pago paga lo pendiente y la comisión.
    expect(await saldoPrestamo(page, nombre)).toBe(0);
    expect(await saldoDeCuenta(page, CUENTA_BANCO)).toBe(saldoTrasAlta - deuda - 1_000);

    // 5 · Eliminarlo lo deshace todo: como si nunca se hubiera apuntado.
    await eliminar(page, nombre);
    creado = false;
    await expect(page.getByRole("region", { name: nombre })).toHaveCount(0);
    expect(await saldoDeCuenta(page, CUENTA_BANCO)).toBe(saldoAntes);
  } finally {
    if (creado) await eliminar(page, nombre).catch(() => {});
  }
});
