import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { credencialesDePrueba, entrarConContrasena, superarCodigo } from "./helpers";

/**
 * Face ID como segundo factor, con el autenticador VIRTUAL de Chromium (CDP
 * `WebAuthn.addVirtualAuthenticator`): hace de Face ID y aprueba solo.
 *
 * El recorrido es el de los cuatro usuarios que ya tenían el código: entran
 * con contraseña y código, añaden Face ID desde Ajustes, y la siguiente vez
 * entran con Face ID —con el código todavía a mano como alternativa—.
 *
 * OPCIONAL: si el proyecto de Supabase no tiene WebAuthn activado (hoy no: es
 * un complemento aparte), Ajustes no ofrece Face ID y la prueba se SALTA en
 * lugar de fallar. Deja una llave dada de alta en el usuario de prueba; la borra el
 * global-setup de la siguiente ejecución (`sesion-de-prueba.mjs` quita todos los
 * factores).
 *
 * Entra en contextos LIMPIOS, nunca con la sesión guardada del global-setup ni
 * cerrando sesión: `signOut()` es global y tumbaría la sesión que usan las demás
 * pruebas.
 */

test.use({ storageState: { cookies: [], origins: [] } });

async function conAutenticador(contexto: BrowserContext, page: Page) {
  const cdp: CDPSession = await contexto.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

test("añadir Face ID desde Ajustes y entrar con él", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "El autenticador virtual solo existe en Chromium");
  test.setTimeout(120_000);

  const { email, password, secret } = credencialesDePrueba();

  // ── 1. Entrar como siempre (contraseña + código) y añadir Face ID ─────────
  const contexto1 = await browser.newContext();
  const page1 = await contexto1.newPage();
  const auth1 = await conAutenticador(contexto1, page1);

  await entrarConContrasena(page1, email, password);
  await superarCodigo(page1, secret);

  await page1.goto("/ajustes");
  await expect(page1.getByRole("heading", { name: "Seguridad" })).toBeVisible();
  // El botón solo aparece si Supabase tiene WebAuthn activado (la app lo sondea).
  const anadir = page1.getByRole("button", { name: /^Añadir / });
  const hayBoton = await anadir
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!hayBoton) {
    await contexto1.close();
    test.skip(true, "WebAuthn MFA no está activado en el proyecto de Supabase");
    return;
  }
  await anadir.click();

  const listo = page1.getByText(/Listo: la próxima vez podrás entrar con/);
  const noActivado = page1.getByText(/todavía no está activado en Cartera/);
  await expect(listo.or(noActivado)).toBeVisible({ timeout: 30_000 });
  if (await noActivado.isVisible()) {
    await contexto1.close();
    test.skip(true, "WebAuthn MFA no está activado en el proyecto de Supabase");
    return;
  }

  const { credentials } = await auth1.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: auth1.authenticatorId,
  });
  expect(credentials).toHaveLength(1);
  await contexto1.close();

  // ── 2. Otro día, otro navegador con la MISMA llave: entrar con Face ID ────
  const contexto2 = await browser.newContext();
  const page2 = await contexto2.newPage();
  const auth2 = await conAutenticador(contexto2, page2);
  await auth2.cdp.send("WebAuthn.addCredential", {
    authenticatorId: auth2.authenticatorId,
    credential: credentials[0],
  });

  await entrarConContrasena(page2, email, password);
  await expect(page2).toHaveURL(/\/2fa(\?.*)?$/);

  // La llave delante y el código como alternativa.
  const conFaceId = page2.getByRole("button", { name: /^Entrar con / });
  await expect(conFaceId).toBeVisible();
  await expect(page2.getByRole("button", { name: "Usar el código de 6 dígitos" })).toBeVisible();

  await conFaceId.click();
  await page2.waitForURL(/\/(resumen|bienvenida)(\?.*)?$/, { timeout: 30_000 });

  // Y con aal2 las políticas devuelven datos: la pantalla tiene contenido.
  await expect(page2.getByRole("heading", { name: "Resumen" })).toBeVisible();

  await contexto2.close();
});
