import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import { STORAGE_STATE } from "../playwright.config";
import { superarCodigo } from "./helpers";
import { ficheroDeEntorno, reservarUsuario, usuarioDePrueba } from "./usuario";

/**
 * Prepara la sesión que reutilizan todas las pruebas.
 *
 * Corre antes que ninguna prueba y después de que el servidor de desarrollo esté
 * en pie (Playwright arranca el `webServer` durante el «plugin setup», que va
 * justo antes del `globalSetup`). Hace tres cosas:
 *
 *   1. Refresca las credenciales del usuario de prueba con
 *      `sesion-de-prueba.mjs`, porque el secreto TOTP guardado puede haber
 *      caducado entre una ejecución y otra.
 *   2. Siembra datos deterministas con `seed-demo.mjs` (cuentas, posiciones y
 *      aportaciones), para que las pruebas de inversión y reembolso tengan de
 *      dónde partir. Ambos scripts se niegan a tocar nada que no acabe en
 *      @cartera.local, así que el correo es fijo y de prueba.
 *   3. Conduce el login real por la interfaz —correo, contraseña y el código de
 *      6 dígitos generado a partir del secreto— hasta llegar a /resumen, y
 *      guarda el `storageState` autenticado.
 */

/**
 * El usuario de prueba: `ci@cartera.local` en la CI y `fase3@cartera.local` en
 * local, o el que diga `E2E_EMAIL`. Las reglas (y por qué no se comparten) en
 * `e2e/usuario.ts` y `e2e/README.md`. Solo @cartera.local: los scripts
 * (`sesion-de-prueba.mjs`, `seed-demo.mjs`) se niegan a tocar otra cosa.
 */
const EMAIL = usuarioDePrueba();

const ROOT = process.cwd();
const SESSION_FILE = path.join(ROOT, "sesion-de-prueba.txt");

function node(script: string) {
  execFileSync("node", [`--env-file=${ficheroDeEntorno()}`, `scripts/${script}`, EMAIL], {
    cwd: ROOT,
    stdio: "inherit",
    // Esta corrida YA tiene reservado el usuario: que sesion-de-prueba.mjs no
    // se crea que el cerrojo es de otra.
    env: { ...process.env, E2E_CERROJO_PROPIO: "1" },
  });
}

/** Lee EMAIL/PASSWORD/TOTP_SECRET del fichero de credenciales (ignorado por git). */
function leerCredenciales() {
  const texto = readFileSync(SESSION_FILE, "utf8");
  const valor = (clave: string) =>
    texto
      .split(/\r?\n/)
      .find((linea) => linea.startsWith(`${clave}=`))
      ?.slice(clave.length + 1)
      .trim();

  const email = valor("EMAIL");
  const password = valor("PASSWORD");
  const secret = valor("TOTP_SECRET");
  if (!email || !password || !secret) {
    throw new Error(
      `Faltan credenciales en ${SESSION_FILE}. ¿Corrió sesion-de-prueba.mjs?`,
    );
  }
  return { email, password, secret };
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3000";

  // 0 · Reservar el usuario para esta corrida (espera si otra lo tiene). Lo
  // que devuelve el globalSetup es el teardown de Playwright: lo libera al final.
  const liberar = await reservarUsuario(EMAIL);
  try {
    await preparar(baseURL);
  } catch (error) {
    await liberar();
    throw error;
  }
  return liberar;
}

async function preparar(baseURL: string) {
  // 1 y 2 · Credenciales frescas y datos deterministas.
  node("sesion-de-prueba.mjs");
  node("seed-demo.mjs");

  const { email, password, secret } = leerCredenciales();

  // 3 · Login real por la interfaz.
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });

  try {
    await page.goto("/entrar");
    await page.getByLabel("Correo", { exact: true }).fill(email);
    // Exacto: el botón de mostrar/ocultar es «Mostrar la contraseña» y también
    // contendría «Contraseña» en una búsqueda por subcadena.
    await page.getByLabel("Contraseña", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();

    // El proxy encamina según el segundo factor: con un factor ya dado de
    // alta manda a /2fa; si mandara a /2fa/alta, es que no hay factor válido.
    await page.waitForURL(/\/2fa(\/alta)?(\?.*)?$/, { timeout: 30_000 });
    if (page.url().includes("/2fa/alta")) {
      throw new Error(
        "El acceso llegó a /2fa/alta en vez de /2fa: no hay segundo factor válido. " +
          "Reejecuta: node --env-file=.env.local scripts/sesion-de-prueba.mjs " +
          EMAIL,
      );
    }

    // El código caduca a los 30 s: se genera justo antes de escribirlo y, si cae
    // en el filo de la ventana, se reintenta con uno nuevo (ver `superarCodigo`).
    await superarCodigo(page, secret);

    if (page.url().includes("/bienvenida")) {
      throw new Error(
        "Login correcto pero sin cuentas (fue a /bienvenida). ¿Corrió seed-demo.mjs?",
      );
    }
    await page.waitForURL(/\/resumen(\?.*)?$/, { timeout: 15_000 });
    await page.getByRole("heading", { name: "Resumen" }).waitFor();

    await page.context().storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
}
