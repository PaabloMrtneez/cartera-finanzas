import { expect, test } from "@playwright/test";
import { desbordaEnHorizontal } from "./helpers";

/**
 * Las pantallas de acceso para quien NO tiene cuenta todavía. Dos personas
 * invitadas se quedaron delante del formulario de entrar sin saber qué hacer;
 * esto fija que el camino se ve, y que la invitación no gasta el enlace al
 * cargar (lo abre la vista previa de WhatsApp antes que la persona).
 *
 * Sin sesión: no reutiliza la del global-setup. No escribe nada: el token de
 * prueba es inventado y Supabase lo rechaza.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("/entrar explica qué hacer si es tu primera vez", async ({ page }) => {
  await page.goto("/entrar");
  await expect(page.getByText("¿Es tu primera vez?")).toBeVisible();
  await expect(page.getByText(/abre el enlace que te mandaron/)).toBeVisible();
  // Ni rastro de un registro.
  await expect(page.getByRole("button", { name: /registr/i })).toHaveCount(0);
  expect(await desbordaEnHorizontal(page)).toBe(false);
});

test("/invitacion sin enlace pide uno nuevo", async ({ page }) => {
  await page.goto("/invitacion");
  await expect(page.getByRole("heading", { name: "Te falta el enlace" })).toBeVisible();
  await expect(page.getByText("Pide a quien te invitó un enlace nuevo.")).toBeVisible();
});

test("la invitación da la bienvenida SIN canjear el token, y lo canjea al pulsar «Empezar»", async ({
  page,
}) => {
  const verificaciones: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/auth/v1/verify")) verificaciones.push(r.url());
  });

  await page.goto("/invitacion?token_hash=esto-no-es-un-token&type=invite");
  await expect(page.getByRole("heading", { name: "Te han invitado a Cartera" })).toBeVisible();
  await expect(page.getByText("Elige una contraseña")).toBeVisible();
  await expect(page.getByText("Protege tu cuenta (recomendado)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Empezar" })).toBeVisible();
  expect(await desbordaEnHorizontal(page)).toBe(false);

  // Cargar la página (lo que hace una vista previa) no toca el token.
  await page.waitForTimeout(1_000);
  expect(verificaciones).toHaveLength(0);

  await page.getByRole("button", { name: "Empezar" }).click();
  await expect(page.getByRole("heading", { name: "Este enlace ya no vale" })).toBeVisible();
  await expect(page.getByText("Pide a quien te invitó un enlace nuevo.")).toBeVisible();
  expect(verificaciones.length).toBeGreaterThan(0);
});

test("un enlace que Supabase ya dio por caducado se explica en humano", async ({ page }) => {
  await page.goto(
    "/invitacion#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
  );
  await expect(page.getByRole("heading", { name: "Este enlace ya no vale" })).toBeVisible();
  await expect(page.getByText("Pide a quien te invitó un enlace nuevo.")).toBeVisible();
});
