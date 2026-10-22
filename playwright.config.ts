import { defineConfig, devices } from "@playwright/test";

/**
 * Pruebas de extremo a extremo de Cartera.
 *
 * La app es privada y exige segundo factor (aal2): sin él la base de datos no
 * devuelve ni una fila. El `globalSetup` conduce el login real por la interfaz
 * —correo, contraseña y el código TOTP— y guarda la sesión en un `storageState`
 * que reutilizan todas las pruebas, para no repetir el acceso cada vez.
 *
 * Ese estado son cookies de sesión, es decir credenciales: vive en
 * `e2e/.auth/`, que está en `.gitignore` y no se sube nunca.
 */

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** Dónde se guarda la sesión ya autenticada. Ignorado por git. */
export const STORAGE_STATE = "e2e/.auth/state.json";

export default defineConfig({
  testDir: "./e2e",
  // Todas las pruebas usan el MISMO usuario de prueba (ver e2e/usuario.ts):
  // varias escribiendo a la vez se pisarían. En serie, cada una lee su
  // estado antes y después sin interferencias.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  globalSetup: "./e2e/global-setup.ts",

  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "on-first-retry",
  },

  projects: [
    /*
      El proyecto principal es móvil: Cartera se diseña primero para el móvil, y
      pantallas como la barra inferior solo existen por debajo de 1024 px. Se
      emula el tamaño y el táctil de un iPhone, pero sobre Chromium, que es el
      único motor que instalamos.
    */
    {
      name: "movil",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
      },
    },
    /*
      Un segundo proyecto de escritorio, solo para el humo: comprueba que el
      acceso con 2FA y el Resumen también se pintan a 1440 px, donde la maqueta
      cambia a barra lateral y tabla. Las pruebas que escriben datos no se
      repiten aquí para no duplicar movimientos en la base compartida.
    */
    {
      name: "escritorio",
      testMatch: /humo\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],

  /*
    El servidor contra el que corre. Por defecto `next dev`; la CI (y quien
    quiera medir lo que se despliega) pasa `E2E_WEB_COMMAND="npm run start"`
    tras un `next build`. Si ya hay uno escuchando en E2E_BASE_URL (fuera de la
    CI), se reutiliza: así se corre contra un `next start` lanzado a mano.
  */
  webServer: {
    command: process.env.E2E_WEB_COMMAND ?? "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
