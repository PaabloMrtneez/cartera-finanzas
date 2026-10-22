import { expect, test } from "@playwright/test";
import {
  aportadoEnCents,
  CUENTA_BANCO,
  CUENTA_INVERSION,
  elegirOpcion,
  guardarMovimiento,
  POSICION,
} from "./helpers";

/**
 * Un traspaso a una cuenta de inversión, eligiendo posición, tiene que subir el
 * «Aportado» de Inversiones.
 *
 * El campo «¿A qué posición?» es justo lo que escribe `position_id`: sin él, el
 * dinero movido no cuenta como aportación y el rendimiento no tendría coste
 * contra el que medirse.
 */
test("un traspaso con posición sube el «Aportado» de Inversiones", async ({ page }) => {
  await page.goto("/inversiones");
  const antes = await aportadoEnCents(page);

  await page.goto("/movimientos/nuevo");
  await page.getByRole("radio", { name: "Traspaso" }).click();
  await page.getByLabel("Importe").fill("100,00");
  await page.getByLabel("Descripción").fill(`Aportacion E2E ${Date.now()}`);
  await elegirOpcion(page.getByLabel("Origen", { exact: true }), CUENTA_BANCO);
  await elegirOpcion(page.getByLabel("Destino", { exact: true }), CUENTA_INVERSION);

  // El desplegable de posición solo aparece cuando el destino tiene posiciones.
  await elegirOpcion(page.getByLabel("¿A qué posición?", { exact: true }), POSICION);

  await guardarMovimiento(page);

  await page.goto("/inversiones");
  const despues = await aportadoEnCents(page);

  // Los 100,00 € aportados son 10.000 céntimos exactos.
  expect(despues).toBe(antes + 10_000);
});
