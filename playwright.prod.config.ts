import { defineConfig, devices } from "@playwright/test";

/**
 * Pruebas de robustez del front CONTRA UN DESPLIEGUE (por defecto, producción).
 *
 *   SESION_PRUEBA=../ruta/sesion-de-prueba.txt npx playwright test -c playwright.prod.config.ts
 *
 * A diferencia de `playwright.config.ts`, aquí no se arranca servidor ni se
 * resiembra nada: el `globalSetup` solo entra con el USUARIO DE PRUEBAS
 * (`scripts/sesion-prod.mjs`, que se niega a usar un correo que no sea
 * @cartera.local) y guarda la sesión en `e2e/.auth/prod-state.json`. Las pruebas
 * que escriben datos los marcan con un prefijo «E2E-» y los borran al terminar.
 *
 * Solo corre las specs de robustez (red, accesibilidad completa, desbordes),
 * que son de solo lectura salvo lo que limpian ellas mismas. En serie y con un
 * único trabajador: nada de carga sobre producción.
 *
 * El DESAFÍO DE VERCEL: a un navegador automático, Vercel puede responder 403
 * con `x-vercel-mitigated: challenge`. Con `VERCEL_AUTOMATION_BYPASS_SECRET`
 * (el secreto de «Protection Bypass for Automation» del proyecto en Vercel), el
 * acceso de `prod-setup` manda la cabecera `x-vercel-protection-bypass` —solo
 * al despliegue, nunca a Supabase— y Vercel deja una cookie de bypass que viaja
 * en el `storageState`; los contextos nuevos la añaden con
 * `aplicarBypassVercel` (`e2e/helpers.ts`). Sin la variable, todo igual que
 * antes. Detalles en `e2e/README.md`.
 */
const BYPASS = Boolean(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
if (!BYPASS) {
  console.warn(
    "[e2e prod] Sin VERCEL_AUTOMATION_BYPASS_SECRET: si Vercel desafía al navegador (403), " +
      "las pruebas caerán en el acceso. Ver e2e/README.md.",
  );
}
export const BASE_PROD = process.env.E2E_BASE_URL ?? "https://tu-dominio.vercel.app";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(red|a11y-completa|desborde)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/prod-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_PROD,
    storageState: "e2e/.auth/prod-state.json",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    serviceWorkers: "allow",
  },
  projects: [
    {
      name: "movil",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
});
