/**
 * Capturas de la guía de uso (docs/guia/capturas/*.webp).
 *
 *   node --env-file=.env.local scripts/seed-demo.mjs fase3@cartera.local
 *   node --env-file=.env.local scripts/seed-guia.mjs fase3@cartera.local
 *   npm run dev                                   # en otra terminal
 *   node --env-file=.env.local scripts/capturas-guia.mjs
 *
 * Entra con el usuario de pruebas igual que el arnés e2e (contraseña y código
 * TOTP leídos de sesion-de-prueba.txt, que está fuera de git) y recorre cada
 * pantalla a tamaño de iPhone, en tema oscuro y con movimiento reducido para
 * que cada pantalla salga en su estado final y no a mitad de una animación.
 * Unas pocas, además, a 1440 px. Solo datos de demostración: el script se
 * niega a entrar con un usuario que no sea @cartera.local.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "@playwright/test";
import pg from "pg";
import sharp from "sharp";
import { sslDb } from "./db-ssl.mjs";
import { totp } from "./totp.mjs";

const BASE = process.env.GUIA_BASE_URL ?? "http://localhost:3000";
const SALIDA = join(process.cwd(), "docs", "guia", "capturas");
mkdirSync(SALIDA, { recursive: true });

const credenciales = Object.fromEntries(
  readFileSync("sesion-de-prueba.txt", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!credenciales.EMAIL?.endsWith("@cartera.local")) {
  throw new Error("Las capturas solo se hacen con un usuario de prueba @cartera.local.");
}

// El movimiento pendiente que se enseña en el detalle.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
await db.connect();
const [pendiente] = (
  await db.query(
    `select t.id::text as id from public.transaction t join auth.users u on u.id = t.user_id
      where u.email = $1 and t.status = 'PENDING' order by t.occurred_on desc limit 1`,
    [credenciales.EMAIL],
  )
).rows;
const [conCategoria] = (
  await db.query(
    `select t.id::text as id from public.transaction t join auth.users u on u.id = t.user_id
      where u.email = $1 and t.merchant_raw = 'SALA BAR' limit 1`,
    [credenciales.EMAIL],
  )
).rows;
await db.end();

const navegador = await chromium.launch();
const movil = await navegador.newContext({
  ...devices["iPhone 13"],
  deviceScaleFactor: 2,
  colorScheme: "dark",
  reducedMotion: "reduce",
  locale: "es-ES",
  timezoneId: "Europe/Madrid",
});
const pagina = await movil.newPage();

async function guardar(nombre, buffer) {
  await sharp(buffer).webp({ quality: 82 }).toFile(join(SALIDA, `${nombre}.webp`));
  console.log(`  ${nombre}.webp`);
}

/**
 * Lleva arriba de la pantalla el encabezado de sección (los que se pintan en
 * mayúsculas) que contenga `texto`. Más fiable que desplazar una distancia
 * fija, que se descuadra en cuanto la página cambia de alto.
 */
const irA = (texto) => (p) =>
  p.evaluate((t) => {
    const encabezado = [...document.querySelectorAll("main *")].find(
      (e) =>
        e.children.length === 0 &&
        getComputedStyle(e).textTransform === "uppercase" &&
        e.textContent.toLowerCase().includes(t.toLowerCase()),
    );
    if (!encabezado) throw new Error(`No encuentro la sección «${t}»`);
    encabezado.scrollIntoView({ block: "start" });
    window.scrollBy(0, -72);
  }, texto);

async function capturar(p, nombre, ruta, { completa = false, antes } = {}) {
  await p.goto(ruta, { waitUntil: "networkidle" });
  if (antes) await antes(p);
  await p.waitForTimeout(700);
  await guardar(nombre, await p.screenshot({ fullPage: completa }));
}

// Acceso: la pantalla de entrada, antes de iniciar sesión.
await capturar(pagina, "00-entrar", `${BASE}/entrar`);
await pagina.getByLabel("Correo", { exact: true }).fill(credenciales.EMAIL);
await pagina.getByLabel("Contraseña", { exact: true }).fill(credenciales.PASSWORD);
await pagina.getByRole("button", { name: "Entrar", exact: true }).click();
await pagina.waitForURL(/\/2fa/, { timeout: 30_000 });
await pagina.getByLabel("Código de 6 dígitos", { exact: true }).waitFor();
await pagina.waitForTimeout(700);
await guardar("01-segundo-factor", await pagina.screenshot());
for (let intento = 0; ; intento++) {
  await pagina.getByLabel("Código de 6 dígitos", { exact: true }).fill(totp(credenciales.TOTP_SECRET));
  await pagina.getByRole("button", { name: "Entrar", exact: true }).click();
  const dentro = await pagina
    .waitForURL(/\/resumen/, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (dentro) break;
  if (intento >= 2) throw new Error("No se pudo superar el segundo factor.");
  await pagina.waitForTimeout(1500);
}

const pantallas = [
  ["02-resumen", "/resumen"],
  ["03-resumen-abajo", "/resumen", { antes: (p) => p.mouse.wheel(0, 900) }],
  ["04-movimientos", "/movimientos"],
  ["05-nuevo-movimiento", "/movimientos/nuevo"],
  ["06-pendiente", `/movimientos/${pendiente.id}`],
  ["07-movimiento-reembolsado", `/movimientos/${conCategoria.id}`],
  ["08-cuentas", "/cuentas"],
  ["09-patrimonio", "/patrimonio"],
  ["10-analisis", "/analisis"],
  ["11-analisis-abajo", "/analisis", { antes: (p) => p.mouse.wheel(0, 1100) }],
  ["12-fijos", "/fijos"],
  ["13-metas", "/metas"],
  ["14-inversiones", "/inversiones"],
  ["15-prestamos", "/prestamos"],
  ["16-categorias", "/categorias"],
  ["17-reglas", "/reglas"],
  ["18-importar", "/importar"],
  ["19-ajustes", "/ajustes"],
  ["20-ajustes-atajo", "/ajustes", { antes: irA("El Atajo del iPhone") }],
  ["20b-ajustes-datos", "/ajustes", { antes: irA("Tus datos") }],
  ["21-atajo-guia", "/atajo"],
  ["22-atajo-guia-cuerpo", "/atajo", { antes: (p) => p.mouse.wheel(0, 1000) }],
];
for (const [nombre, ruta, opciones] of pantallas) await capturar(pagina, nombre, `${BASE}${ruta}`, opciones);

// Escritorio: la misma sesión, a 1440 px.
const estado = await movil.storageState();
const escritorio = await navegador.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1.5,
  colorScheme: "dark",
  reducedMotion: "reduce",
  locale: "es-ES",
  timezoneId: "Europe/Madrid",
  storageState: estado,
});
const ancha = await escritorio.newPage();
for (const [nombre, ruta] of [
  ["30-escritorio-resumen", "/resumen"],
  ["31-escritorio-movimientos", "/movimientos"],
  ["32-escritorio-analisis", "/analisis"],
  ["33-escritorio-patrimonio", "/patrimonio"],
]) {
  await capturar(ancha, nombre, `${BASE}${ruta}`);
}

await navegador.close();
console.log(`Capturas en ${SALIDA}`);
