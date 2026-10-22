/**
 * Cuántas peticiones al servidor de Next cuesta GUARDAR un movimiento (y
 * borrarlo), antes y después. Cada una es un render con su paso por el proxy
 * (getUser) y sus consultas. Crea un gasto «E2E-GUARDADO …» de 1,23 € con el
 * usuario de pruebas y lo borra por la interfaz al acabar.
 *
 *   node scripts/medir-guardado.mjs --base http://localhost:3108 \
 *        --estado e2e/.auth/local-state.json [--cuenta Nomina]
 */
import { chromium } from "playwright";
import { argumento } from "./sesion-prod.mjs";

const base = argumento("base", "http://localhost:3108");
const estado = argumento("estado", "e2e/.auth/local-state.json");
const cuenta = argumento("cuenta", "Nomina");
const descripcion = `E2E-GUARDADO ${Date.now()}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: estado, baseURL: base, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
const page = await ctx.newPage();
let registro = null;
page.on("request", (req) => {
  if (!registro || !req.url().startsWith(base)) return;
  const h = req.headers();
  const tipo = h["next-action"] ? "acción" : h["next-router-prefetch"] ? "precarga" : h.rsc ? "rsc" : req.resourceType() === "document" ? "documento" : null;
  if (tipo) registro.push(tipo);
});
const contar = async (accion, hasta) => {
  registro = [];
  await accion();
  await hasta();
  await page.waitForTimeout(2000);
  const r = registro;
  registro = null;
  const por = r.reduce((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
  return { total: r.filter((t) => t !== "precarga").length, por };
};

try {
  await page.goto("/movimientos/nuevo");
  await page.getByRole("heading", { name: "Nuevo movimiento" }).first().waitFor();
  await page.getByRole("radio", { name: "Gasto" }).click();
  await page.getByLabel("Importe").fill("1,23");
  await page.getByLabel("Descripción").fill(descripcion);
  await page.getByLabel("Cuenta", { exact: true }).click();
  await page.getByRole("option", { name: cuenta, exact: true }).click();
  await page.waitForTimeout(1500);

  const guardar = await contar(
    () => page.getByRole("button", { name: "Guardar", exact: true }).click(),
    () => page.waitForURL(/\/movimientos(\?.*)?$/, { timeout: 30_000 }),
  );
  console.log(`guardar: ${guardar.total} peticiones al servidor (sin precargas) · ${JSON.stringify(guardar.por)}`);

  await page.goto(`/movimientos?mes=todo&q=${encodeURIComponent(descripcion)}`);
  await page.getByRole("link", { name: new RegExp(descripcion) }).first().click();
  await page.waitForURL(/\/movimientos\/[0-9a-f-]{36}/);
  await page.getByRole("button", { name: "Eliminar movimiento" }).click();
  const borrar = await contar(
    () => page.getByRole("dialog").getByRole("button", { name: "Eliminar", exact: true }).click(),
    () => page.waitForURL(/\/movimientos(\?.*)?$/, { timeout: 30_000 }),
  );
  console.log(`borrar: ${borrar.total} peticiones al servidor (sin precargas) · ${JSON.stringify(borrar.por)}`);
} finally {
  // Por si algo falló a medias: que no quede el movimiento de prueba.
  await page.goto(`/movimientos?mes=todo&q=${encodeURIComponent(descripcion)}`);
  const quedan = await page.getByRole("link", { name: new RegExp(descripcion) }).count();
  console.log(`quedan con «${descripcion}»: ${quedan}`);
  await browser.close();
}
