import { expect, test } from "@playwright/test";

/**
 * Fijos reúne lo que eran Suscripciones e Ingresos recurrentes.
 *
 * Lo que se blinda aquí:
 *   · las direcciones viejas no se rompen: marcadores, enlaces y la app
 *     instalada llegan al grupo que les toca con una redirección PERMANENTE;
 *   · el segmentado cambia de grupo, lo deja en la dirección (`?ver=`) y se
 *     maneja con las flechas, como un grupo de radios;
 *   · el alta es la del grupo que se ve.
 */

test("las direcciones viejas redirigen, para siempre, al grupo de Fijos que les toca", async ({
  page,
  request,
}) => {
  for (const [vieja, grupo] of [
    ["/suscripciones", "gastos"],
    ["/ingresos", "ingresos"],
  ] as const) {
    // La respuesta en sí: un 308, no un 307 ni una página que redirige al pintar.
    const r = await request.get(vieja, { maxRedirects: 0 });
    expect(r.status(), vieja).toBe(308);
    expect(r.headers().location, vieja).toBe(`/fijos?ver=${grupo}`);

    // Y en el navegador, hasta la pantalla.
    await page.goto(vieja);
    await expect(page).toHaveURL(`/fijos?ver=${grupo}`);
    await expect(page.getByRole("heading", { name: "Fijos", exact: true })).toBeVisible();
    await expect(
      page.getByRole("radio", { name: grupo === "gastos" ? "Gastos fijos" : "Ingresos fijos" }),
    ).toHaveAttribute("aria-checked", "true");
  }
});

test("el segmentado cambia de grupo, lo deja en la dirección y responde a las flechas", async ({
  page,
}) => {
  await page.goto("/fijos");
  const grupo = page.getByRole("radiogroup", { name: "Grupo de fijos" });
  const gastos = grupo.getByRole("radio", { name: "Gastos fijos" });
  const ingresos = grupo.getByRole("radio", { name: "Ingresos fijos" });

  // Sin `ver`, los gastos; y el alta es la de un gasto fijo.
  await expect(gastos).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("region", { name: "Gastos fijos" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuevo gasto fijo" }).first()).toBeVisible();

  await ingresos.click();
  await expect(page).toHaveURL(/\/fijos\?ver=ingresos$/);
  await expect(page.getByRole("region", { name: "Ingresos fijos" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuevo ingreso fijo" }).first()).toBeVisible();

  // Con el teclado: una sola parada de tabulador y las flechas mueven la elección.
  await ingresos.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/\/fijos\?ver=gastos$/);
  await expect(gastos).toBeFocused();
  await expect(page.getByRole("region", { name: "Gastos fijos" })).toBeVisible();
});

test("Fijos se alcanza desde Ajustes en el móvil", async ({ page }) => {
  await page.goto("/ajustes");
  await page.getByRole("link", { name: /^Fijos/ }).click();
  await expect(page).toHaveURL(/\/fijos(\?.*)?$/);
  await expect(page.getByRole("heading", { name: "Fijos", exact: true })).toBeVisible();
});
