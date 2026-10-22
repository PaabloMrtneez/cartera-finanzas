import { expect, test } from "@playwright/test";
import { formatCents } from "../src/lib/money";
import { applyPercent, parsePercent } from "../src/lib/valoracion";
import { importeACents, POSICION } from "./helpers";

/**
 * Valorar por porcentaje: lo que se guarda es exactamente la vista previa, y la
 * vista previa es la base (valoración del cierre anterior + lo aportado desde
 * entonces) por el porcentaje, en enteros.
 *
 * El seed deja valoraciones mensuales hasta el mes en curso, así que la base es
 * la del mes pasado y la de este mes es la que se sustituye. Repetir la prueba
 * da la misma cifra: la base no es la valoración que se acaba de guardar.
 */
test("una valoración en % guarda la cifra de la vista previa, calculada en enteros", async ({
  page,
}) => {
  await page.goto("/inversiones");
  await page.getByRole("button", { name: `Valorar ${POSICION}` }).click();

  const dialogo = page.getByRole("dialog");
  await dialogo.getByRole("radio", { name: "Meto el %" }).click();
  await dialogo.getByLabel("Cuánto ha variado").fill("12,5");

  const fila = (etiqueta: string | RegExp) =>
    dialogo.getByText(etiqueta, { exact: true }).locator("xpath=following-sibling::span[1]");

  const previo = importeACents(await fila(/^Valoración del /).innerText());
  const aportadoVisible = await dialogo.getByText("Aportado desde entonces", { exact: true }).count();
  const aportado = aportadoVisible ? importeACents(await fila("Aportado desde entonces").innerText()) : 0;
  const guardado = importeACents(await fila("Valor que se guarda").innerText());

  const pct = parsePercent("12,5");
  expect(pct).not.toBeNull();
  expect(guardado).toBe(applyPercent(previo + aportado, pct!));

  await dialogo.getByRole("button", { name: "Guardar valoración" }).click();
  await expect(dialogo).toBeHidden();

  // La posición enseña ahora esa misma cifra, al céntimo. Su ficha se busca por
  // su título: el nombre de un fondo seguido («Fidelity MSCI World…») también
  // contiene «MSCI World».
  const posicion = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: POSICION, exact: true }) });
  await expect(posicion).toContainText(formatCents(guardado));
});
