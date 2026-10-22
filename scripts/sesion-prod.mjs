/**
 * Entra en un despliegue de Cartera con el USUARIO DE PRUEBAS y guarda la sesión
 * (cookies, aal2) en un `storageState` de Playwright, para que los scripts de
 * medición (`bench-front.mjs`, `estres-visual.mjs`) puedan recorrer las pantallas
 * autenticadas sin repetir el acceso.
 *
 *   node scripts/sesion-prod.mjs [--base https://…] [--sesion ruta/sesion-de-prueba.txt]
 *                                [--estado e2e/.auth/prod-state.json]
 *
 * Las credenciales salen de `sesion-de-prueba.txt` (lo escribe
 * `sesion-de-prueba.mjs`, ignorado por git). Solo acepta correos @cartera.local:
 * contra producción NUNCA se entra con una cuenta real. El estado resultante son
 * credenciales: va a `e2e/.auth/`, que también está ignorado. No imprime nada
 * secreto.
 */
import { readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { totp } from "./totp.mjs";

export const BASE_PROD = "https://tu-dominio.vercel.app";
export const ESTADO_POR_DEFECTO = "e2e/.auth/prod-state.json";

/**
 * Cabeceras del bypass de Vercel («Protection Bypass for Automation»), si hay
 * secreto en `VERCEL_AUTOMATION_BYPASS_SECRET`. Sin él, Vercel puede responder
 * `403` con `x-vercel-mitigated: challenge` a un navegador automático. Con
 * `x-vercel-set-bypass-cookie`, Vercel deja además una cookie que viaja en el
 * `storageState` guardado, así que las pruebas que lo reutilizan también pasan.
 */
export function cabecerasBypass() {
  const secreto = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secreto
    ? { "x-vercel-protection-bypass": secreto, "x-vercel-set-bypass-cookie": "true" }
    : null;
}

/**
 * Añade las cabeceras del bypass SOLO a las peticiones al propio despliegue: el
 * secreto no tiene por qué viajar a Supabase ni a ningún otro origen.
 */
export async function aplicarBypass(contexto, base) {
  const extra = cabecerasBypass();
  if (!extra) return;
  await contexto.route(`${new URL(base).origin}/**`, (ruta) =>
    ruta.continue({ headers: { ...ruta.request().headers(), ...extra } }),
  );
}

export function argumento(nombre, porDefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

function leerCredenciales(fichero) {
  const texto = readFileSync(fichero, "utf8");
  const valor = (clave) =>
    texto
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${clave}=`))
      ?.slice(clave.length + 1)
      .trim();
  const email = valor("EMAIL");
  const password = valor("PASSWORD");
  const secret = valor("TOTP_SECRET");
  if (!email || !password || !secret) throw new Error(`Faltan credenciales en ${fichero}`);
  if (!email.endsWith("@cartera.local")) {
    throw new Error(`Me niego a entrar con «${email}»: solo usuarios de prueba @cartera.local.`);
  }
  return { email, password, secret };
}

/** Hace el acceso real por la interfaz (correo, contraseña, TOTP) y guarda el estado. */
export async function entrar({ base, sesion, estado }) {
  const { email, password, secret } = leerCredenciales(sesion);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: base });
    await aplicarBypass(page.context(), base);
    await page.goto("/entrar");
    await page.getByLabel("Correo", { exact: true }).fill(email);
    await page.getByLabel("Contraseña", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/2fa(\/alta)?(\?.*)?$/, { timeout: 30_000 });
    if (page.url().includes("/2fa/alta")) {
      throw new Error("El usuario de prueba no tiene factor válido: reejecuta sesion-de-prueba.mjs");
    }
    const codigo = page.getByLabel("Código de 6 dígitos", { exact: true });
    const boton = page.getByRole("button", { name: "Entrar", exact: true });
    for (let intento = 0; intento < 3; intento++) {
      await codigo.fill(totp(secret));
      await boton.click();
      try {
        await page.waitForURL(/\/(resumen|bienvenida)(\?.*)?$/, { timeout: 10_000 });
        mkdirSync(path.dirname(estado), { recursive: true });
        await page.context().storageState({ path: estado });
        return estado;
      } catch {
        await page.waitForTimeout(1_500);
      }
    }
    throw new Error("No se pudo verificar el segundo factor tras 3 intentos");
  } finally {
    await browser.close();
  }
}

/** Reutiliza el estado si tiene menos de 40 minutos; si no, vuelve a entrar. */
export async function asegurarSesion({ base, sesion, estado, maxMinutos = 40 }) {
  if (existsSync(estado) && Date.now() - statSync(estado).mtimeMs < maxMinutos * 60_000) {
    return estado;
  }
  return entrar({ base, sesion, estado });
}

const esEntrada = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (esEntrada) {
  const base = argumento("base", BASE_PROD);
  const sesion = argumento("sesion", "sesion-de-prueba.txt");
  const estado = argumento("estado", ESTADO_POR_DEFECTO);
  await entrar({ base, sesion, estado });
  console.log(`Sesión guardada en ${estado} (${base}).`);
}
