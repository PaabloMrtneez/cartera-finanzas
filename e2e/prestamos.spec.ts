import { expect, test } from "@playwright/test";
import {
  conSigno,
  CUENTA_BANCO,
  elegirOpcion,
  escaparRegExp,
  haceMeses,
  hoyEnMadrid,
  importeACents,
  saldoDeCuenta,
} from "./helpers";

/**
 * Un préstamo de principio a fin, con el usuario de pruebas.
 *
 * Se da de alta con «el dinero entra ahora» y una fecha de firma de hace unos
 * meses, para que al guardar se cobren las cuotas ya vencidas. Se comprueba:
 *
 *   · que la cuota de la VISTA PREVIA (calculada en el navegador) es la que
 *     guarda la base: la de la cabecera y la del cuadro de amortización;
 *   · que el saldo de la cuenta de pago sube lo prestado menos la comisión,
 *     menos las cuotas cobradas (cada una sale entera de esa cuenta);
 *   · que la deuda aparece en Patrimonio y en Cuentas, por lo que se debe;
 *   · que cada cuota vencida existe como intereses (gasto) + capital
 *     (traspaso a la cuenta del préstamo), y que su detalle lo dice;
 *   · y que se elimina escribiendo su nombre, dejando el saldo como estaba.
 *
 * Necesita las migraciones de préstamos aplicadas (20261013090000…090200).
 */

test("un préstamo: vista previa = cuota guardada, saldo, deuda, cuotas y borrado", async ({ page }) => {
  const hoy = hoyEnMadrid();
  const nombre = `E2E préstamo ${Date.now()}`;
  const saldoAntes = await saldoDeCuenta(page, CUENTA_BANCO);

  // 1. El alta, con la vista previa en vivo.
  await page.goto("/prestamos");
  await page.getByRole("heading", { name: "Préstamos", exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Nuevo préstamo" }).first().click();
  const hoja = page.getByRole("dialog");
  await hoja.getByLabel("Nombre", { exact: true }).fill(nombre);
  await elegirOpcion(hoja.getByLabel("Cuenta de pago", { exact: true }), CUENTA_BANCO);
  await hoja.getByLabel("Importe prestado").fill("6.000,00");
  await hoja.getByLabel("Plazo", { exact: true }).fill("24");
  await hoja.getByLabel("TIN", { exact: true }).fill("7,25");
  await hoja.getByRole("radio", { name: /El dinero entra ahora/ }).check();
  await hoja.getByRole("radio", { name: "%", exact: true }).click();
  await hoja.getByLabel("Comisión de apertura (opcional)").fill("1,5");
  await hoja.getByLabel("Fecha de la firma").fill(haceMeses(hoy, 4));

  const prevista = hoja.getByTestId("cuota-prevista");
  await expect(prevista).toBeVisible();
  const cuotaPrevista = importeACents(await prevista.innerText());
  expect(cuotaPrevista).toBeGreaterThan(0);
  // 1,5 % de 6000 € = 90 €: la comisión en % se redondea al céntimo.
  await expect(hoja.getByText(/^Comisión$/)).toBeVisible();
  await expect(hoja.getByText(/^90,00\s€$/)).toBeVisible();

  await hoja.getByRole("button", { name: "Guardar préstamo" }).click();
  await expect(hoja).toBeHidden({ timeout: 20_000 });

  // 2. La ficha: la cuota guardada es la de la vista previa, en la cabecera y en el cuadro.
  const ficha = page.getByRole("region", { name: nombre });
  await expect(ficha).toBeVisible();
  const cuotaCabecera = page
    .getByText("Cuota al mes", { exact: true })
    .first()
    .locator("xpath=following-sibling::span[1]");
  expect(importeACents(await cuotaCabecera.innerText())).toBe(cuotaPrevista);

  await ficha.getByText("Cuadro de amortización", { exact: true }).click();
  const cuadro = ficha.getByRole("table", { name: /Cuadro de amortización/ });
  const filas = cuadro.getByRole("row").filter({ has: page.getByRole("cell") });
  await expect(filas).toHaveCount(24);
  expect(importeACents(await filas.first().getByRole("cell").nth(3).innerText())).toBe(cuotaPrevista);

  // Las vencidas: firmadas hace cuatro meses el día 10, con cobro el día 1.
  const cobradas = await cuadro.getByRole("cell", { name: /Cobrada/ }).count();
  expect(cobradas).toBeGreaterThanOrEqual(3);
  expect(cobradas).toBeLessThanOrEqual(4);

  // 3. El saldo: +6000 € prestados, −90 € de comisión y −cada cuota cobrada
  //    (intereses y capital salen los dos de la cuenta de pago).
  const deuda = importeACents(await page.getByTestId("deuda-pendiente").innerText());
  expect(deuda).toBeGreaterThan(0);
  expect(deuda).toBeLessThan(600_000);
  const saldoDespues = await saldoDeCuenta(page, CUENTA_BANCO);
  expect(saldoDespues - saldoAntes).toBe(600_000 - 9_000 - cobradas * cuotaPrevista);

  // 4. La deuda, en Cuentas (su cuenta, en negativo) y en Patrimonio.
  const filaPrestamo = page
    .locator("li")
    .filter({ has: page.getByRole("link", { name: `Ver el préstamo de Préstamo · ${nombre}` }) });
  await expect(filaPrestamo).toBeVisible();
  await expect(filaPrestamo).toContainText(/Préstamo · \d+ de 24 cuotas/);
  const saldoPrestamo = (await filaPrestamo.innerText()).match(/[−-]?[\d.]+,\d{2}\s€/g) ?? [];
  expect(conSigno(saldoPrestamo[saldoPrestamo.length - 1])).toBe(-deuda);

  await page.goto("/patrimonio");
  const parteDeuda = page.getByText("Deuda", { exact: true }).first().locator("xpath=following-sibling::span[1]");
  expect(conSigno(await parteDeuda.innerText())).toBe(-deuda);

  // 5. Cada cuota vencida: intereses como gasto y capital como traspaso.
  await page.goto(`/movimientos?mes=todo&q=${encodeURIComponent(nombre)}`);
  const intereses = page.getByRole("link", {
    name: new RegExp(`Intereses · ${escaparRegExp(nombre)} \\(cuota 1/24\\)`),
  });
  const capital = page.getByRole("link", {
    name: new RegExp(`Capital · ${escaparRegExp(nombre)} \\(cuota 1/24\\)`),
  });
  await expect(intereses.first()).toBeVisible();
  await expect(capital.first()).toBeVisible();
  await expect(capital.first()).toContainText("→");
  // Tantas como cuotas cobradas: ni una de menos ni repetidas.
  await expect(
    page.getByRole("link", { name: new RegExp(`Intereses · ${escaparRegExp(nombre)} \\(cuota \\d+/24\\)`) }),
  ).toHaveCount(cobradas);
  await expect(
    page.getByRole("link", { name: new RegExp(`Capital · ${escaparRegExp(nombre)} \\(cuota \\d+/24\\)`) }),
  ).toHaveCount(cobradas);

  await intereses.first().click();
  await expect(page.getByText(`Cuota 1 de 24 del préstamo ${nombre} · intereses`)).toBeVisible();
  await expect(page.getByText(/Gasto del préstamo/)).toBeVisible();

  // 6. Eliminar, escribiendo el nombre.
  await page.goto("/prestamos");
  await page.getByRole("button", { name: `Editar ${nombre}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Eliminar préstamo" }).click();
  const confirmar = page.getByLabel(/para confirmar/);
  await expect(confirmar).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog").getByText(/^Se borrarán \d+ movimientos/)).toBeVisible();
  const eliminar = page.getByRole("dialog").getByRole("button", { name: "Eliminar préstamo" });
  await expect(eliminar).toBeDisabled();
  await confirmar.fill(nombre);
  await expect(eliminar).toBeEnabled();
  await eliminar.click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: nombre })).toHaveCount(0);

  // Como si nunca se hubiera apuntado: el saldo vuelve a ser el de antes.
  expect(await saldoDeCuenta(page, CUENTA_BANCO)).toBe(saldoAntes);
});
