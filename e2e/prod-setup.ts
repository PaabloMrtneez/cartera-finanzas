import { execFileSync } from "node:child_process";
import type { FullConfig } from "@playwright/test";

/**
 * Sesión para `playwright.prod.config.ts`: entra con el usuario de pruebas en el
 * despliegue y guarda el estado. Se lanza como proceso (y no se importa) por lo
 * mismo que `totp.mjs` en `global-setup.ts`: el cargador de Playwright trataría
 * el `.mjs` como CommonJS.
 */
export default async function prodSetup(config: FullConfig) {
  const base = String(config.projects[0]?.use?.baseURL);
  execFileSync(
    "node",
    [
      "scripts/sesion-prod.mjs",
      "--base",
      base,
      "--sesion",
      process.env.SESION_PRUEBA ?? "sesion-de-prueba.txt",
      "--estado",
      "e2e/.auth/prod-state.json",
    ],
    { cwd: process.cwd(), stdio: "inherit" },
  );
}
