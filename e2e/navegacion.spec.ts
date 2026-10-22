import { expect, test } from "@playwright/test";

/**
 * La barra inferior de móvil NO desaparece al cambiar de pestaña.
 *
 * Fue un bug real: al navegar entre secciones la barra se esfumaba. Vive en el
 * armazón de la app, que persiste entre rutas, así que debe seguir visible
 * después de cada salto. Esta prueba lo blinda.
 *
 * Solo tiene sentido en móvil: la barra es `lg:hidden` y en escritorio se
 * sustituye por la barra lateral. Por eso el proyecto de escritorio no la corre.
 */
const PESTAÑAS = [
  { nombre: "Movimientos", url: /\/movimientos(\?.*)?$/, titulo: "Movimientos" },
  { nombre: "Cuentas", url: /\/cuentas(\?.*)?$/, titulo: "Cuentas" },
  { nombre: "Ajustes", url: /\/ajustes(\?.*)?$/, titulo: "Ajustes" },
  { nombre: "Resumen", url: /\/resumen(\?.*)?$/, titulo: "Resumen" },
] as const;

test("la barra inferior sigue visible al cambiar de pestaña", async ({ page }) => {
  await page.goto("/resumen");

  // El indicador de desarrollo de Next se ancla también abajo y, al ancho de
  // móvil, se solapa con la barra inferior e intercepta los toques. Es un
  // artefacto solo de `next dev` —en producción, que es donde vivía el bug que
  // esto blinda, no existe—, así que se neutraliza para poder tocar las pestañas.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

  const barra = page.getByRole("navigation", { name: "Secciones" });
  await expect(barra).toBeVisible();

  for (const pestaña of PESTAÑAS) {
    await barra.getByRole("link", { name: pestaña.nombre }).click();
    await page.waitForURL(pestaña.url);

    // Llegamos a la sección… (exacto: el título es la cabecera de la pantalla,
    // no una tarjeta interior que también contenga la palabra).
    await expect(
      page.getByRole("heading", { name: pestaña.titulo, exact: true }),
    ).toBeVisible();
    // …y la barra sigue ahí.
    await expect(barra).toBeVisible();
  }
});
