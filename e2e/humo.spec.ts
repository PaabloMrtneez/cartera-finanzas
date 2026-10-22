import { expect, test } from "@playwright/test";

/**
 * Humo: valida todo el arnés.
 *
 * Si el `globalSetup` no hubiera conseguido pasar el segundo factor, no habría
 * `storageState` autenticado y esta prueba caería al redirigir a /entrar. Que
 * llegue a /resumen y vea su cabecera confirma que el acceso con 2FA funciona y
 * que la base devuelve datos (solo lo hace en aal2).
 */
test("el arnés: la sesión con 2FA llega a /resumen autenticado", async ({ page }) => {
  await page.goto("/resumen");

  // No nos ha echado a la pantalla de acceso ni al segundo factor.
  await expect(page).toHaveURL(/\/resumen(\?.*)?$/);
  await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
});
