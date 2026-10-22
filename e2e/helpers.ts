import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";

/**
 * Utilidades compartidas por las pruebas de extremo a extremo.
 *
 * Nombres de cuentas y posiciones vienen de `scripts/seed-demo.mjs`, que siembra
 * siempre lo mismo: cuentas «Nomina», «Indexa Capital» (inversión) y «Visa», con
 * las posiciones «MSCI World» y «Bonos globales» colgando de la de inversión.
 */

export const CUENTA_BANCO = "Nomina";
export const CUENTA_INVERSION = "Indexa Capital";
export const CUENTA_VISA = "Visa";
export const POSICION = "MSCI World";

/** Escapa un texto para usarlo dentro de una expresión regular. */
export function escaparRegExp(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convierte un importe en formato es-ES a céntimos enteros, sin coma flotante.
 *
 * Acepta «6100,00 €» y «6.100,00 €»: descarta el símbolo, los espacios y los
 * puntos de millar, y separa la parte entera de los dos decimales.
 */
export function importeACents(texto: string): number {
  const limpio = texto.replace(/[^\d,]/g, "");
  const [entero = "0", decimales = ""] = limpio.split(",");
  const dec = (decimales + "00").slice(0, 2);
  return Number.parseInt(entero || "0", 10) * 100 + Number.parseInt(dec, 10);
}

/** Hoy en Madrid, `YYYY-MM-DD`: el «hoy» con el que la base genera las cuotas. */
export function hoyEnMadrid(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** El día 10 de hace `meses` meses: la primera cuota (día 1) cae el mes siguiente. */
export function haceMeses(hoy: string, meses: number): string {
  const [a, m] = hoy.split("-").map(Number);
  const total = a * 12 + (m - 1) - meses;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-10`;
}

/** Un importe con su signo, en céntimos («−6.123,45 €» → −612345). */
export function conSigno(texto: string): number {
  const cents = importeACents(texto);
  return /^\s*[−-]/.test(texto) ? -cents : cents;
}

/**
 * El saldo de una cuenta tal y como lo enseña Cuentas, con su signo y en
 * céntimos. Navega a /cuentas. La fila se encuentra por su botón «Editar …».
 */
export async function saldoDeCuenta(page: Page, nombre: string): Promise<number> {
  await page.goto("/cuentas");
  const fila = page
    .locator("li")
    .filter({ has: page.getByRole("button", { name: `Editar ${nombre}`, exact: true }) });
  await expect(fila).toBeVisible();
  const importes = (await fila.innerText()).match(/[−-]?[\d.]+,\d{2}\s€/g) ?? [];
  expect(importes.length, `la fila de «${nombre}» debería llevar su saldo`).toBeGreaterThan(0);
  return conSigno(importes[importes.length - 1]);
}

/**
 * Lee el «Aportado» de la pantalla de Inversiones en céntimos.
 *
 * En la maqueta la etiqueta y la cifra son dos `span` hermanos; se localiza la
 * etiqueta exacta y se toma el `span` que la sigue.
 */
export async function aportadoEnCents(page: Page): Promise<number> {
  const cifra = page
    .getByText("Aportado", { exact: true })
    .locator("xpath=following-sibling::span[1]");
  await expect(cifra).toBeVisible();
  return importeACents(await cifra.innerText());
}

/**
 * Lee la «Ganancia» de la cabecera de Inversiones en céntimos, con su signo
 * (la pantalla escribe «+1.234,00 €» o «−1.234,00 €», con el menos tipográfico).
 * Devuelve null si enseña un guion (no hay aportado contra el que medir).
 */
export async function gananciaEnCents(page: Page): Promise<number | null> {
  const cifra = page
    .getByText("Ganancia", { exact: true })
    .locator("xpath=following-sibling::span[1]");
  await expect(cifra).toBeVisible();
  const texto = (await cifra.innerText()).trim();
  if (!/\d/.test(texto)) return null;
  const cents = importeACents(texto);
  return /^[−-]/.test(texto) ? -cents : cents;
}

/**
 * Elige una opción en un desplegable de la app (`src/components/ui/select.tsx`).
 *
 * Todos los desplegables son Select de Radix: el campo es un `combobox` (un
 * botón), no un `<select>` nativo, y `locator.selectOption()` falla con
 * «Element is not a <select>». Se hace lo que haría una persona: abrir el
 * disparador, pulsar la opción en el panel (que se pinta en un portal, fuera
 * del formulario o del diálogo, por eso se busca en la página) y esperar a que
 * el panel se cierre y el campo enseñe lo elegido.
 *
 *   await elegirOpcion(page.getByLabel("Cuenta", { exact: true }), "Nomina");
 *
 * El nombre de la opción es exacto si es un texto; para casar por parte, una
 * expresión regular.
 */
export async function elegirOpcion(campo: Locator, opcion: string | RegExp): Promise<void> {
  const page = campo.page();
  await campo.click();
  const panel = page.getByRole("listbox");
  await expect(panel).toBeVisible();
  await panel
    .getByRole("option", { name: opcion, ...(typeof opcion === "string" ? { exact: true } : {}) })
    .click();
  await expect(panel).toBeHidden();
  await expect(campo).toContainText(opcion);
}

/**
 * Rellena la parte común del formulario de «Nuevo movimiento» y guarda.
 *
 * El botón «Guardar» a secas (no «Guardar y añadir otro») cierra el formulario y
 * lleva a la lista de Movimientos.
 */
export async function guardarMovimiento(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await page.waitForURL(/\/movimientos(\?.*)?$/);
}

/**
 * Las credenciales del usuario de prueba que deja `sesion-de-prueba.mjs` (el
 * global-setup lo ejecuta antes de nada). Para las pruebas que tienen que
 * ENTRAR por su cuenta, en un contexto limpio, en lugar de reutilizar la
 * sesión guardada.
 */
export function credencialesDePrueba(): { email: string; password: string; secret: string } {
  const texto = readFileSync(path.join(process.cwd(), "sesion-de-prueba.txt"), "utf8");
  const valor = (clave: string) =>
    texto
      .split(/\r?\n/)
      .find((linea) => linea.startsWith(`${clave}=`))
      ?.slice(clave.length + 1)
      .trim() ?? "";
  return { email: valor("EMAIL"), password: valor("PASSWORD"), secret: valor("TOTP_SECRET") };
}

/** El código TOTP de ahora mismo, con la misma implementación que el arnés. */
export function codigoTotp(secret: string): string {
  return execFileSync("node", ["scripts/totp.mjs", secret], { cwd: process.cwd() })
    .toString()
    .trim();
}

/**
 * Entra con correo y contraseña y se queda en /2fa (o donde mande el proxy).
 * No supera el segundo factor: eso lo decide cada prueba.
 */
export async function entrarConContrasena(page: Page, email: string, password: string) {
  await page.goto("/entrar");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/2fa(\/alta)?(\?.*)?$/, { timeout: 30_000 });
}

/**
 * Supera el código de 6 dígitos y espera a llegar a /resumen (o /bienvenida).
 *
 * Tras un código bueno el botón se queda en «Comprobando…» (deshabilitado)
 * hasta que llega la navegación, y /resumen en frío —o con la base ocupada—
 * puede tardar más de 8 s. Antes se daba por fallido a los 8 s y se volvía a
 * pulsar «Entrar», que ya no existía: la prueba moría a los 30 s esperando un
 * botón. Ahora se espera a lo que pase antes, la navegación o un error en el
 * formulario, y solo un error (el código cayó en el filo de los 30 s) merece
 * otro intento.
 */
export async function superarCodigo(page: Page, secret: string) {
  const codigo = page.getByLabel("Código de 6 dígitos", { exact: true });
  const error = page.locator("form").getByRole("alert");
  for (let intento = 0; intento < 3; intento++) {
    await codigo.fill(codigoTotp(secret));
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    const resultado = await Promise.race([
      page
        .waitForURL(/\/(resumen|bienvenida)(\?.*)?$/, { timeout: 45_000 })
        .then(() => "dentro" as const)
        .catch(() => "nada" as const),
      error
        .first()
        .waitFor({ state: "visible", timeout: 45_000 })
        .then(() => "error" as const)
        .catch(() => "nada" as const),
    ]);
    if (resultado === "dentro") return;
    if (resultado === "nada") {
      throw new Error("El segundo factor no respondió en 45 s: ni entró ni dio error.");
    }
    await page.waitForTimeout(1_500);
  }
  throw new Error("No se pudo superar el código de 6 dígitos tras 3 intentos.");
}

/** ¿Se sale algo por la derecha? (`scrollWidth` mayor que la ventana). */
export async function desbordaEnHorizontal(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

/**
 * El bypass de Vercel para un contexto NUEVO (sin el `storageState` que ya lleva
 * su cookie): solo con `VERCEL_AUTOMATION_BYPASS_SECRET` definido, y solo hacia
 * el propio despliegue, nunca a Supabase. En local (sin la variable) no hace nada.
 * Ver `e2e/README.md`.
 */
export async function aplicarBypassVercel(contexto: BrowserContext, base: string | undefined) {
  const secreto = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secreto || !base) return;
  const origen = new URL(base).origin;
  await contexto.route(
    (url) => url.origin === origen,
    (ruta) =>
      ruta.continue({
        headers: { ...ruta.request().headers(), "x-vercel-protection-bypass": secreto },
      }),
  );
}
