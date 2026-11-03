import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE } from "../playwright.config";
import { credencialesDePrueba, elegirOpcion, entrarConContrasena, superarCodigo } from "./helpers";

/**
 * Ajustes: la maqueta (una fila por sección, sin huecos) y que cada cosa siga
 * funcionando donde se ha movido. Lo que se crea lleva el prefijo «E2E-» y se
 * borra en la misma prueba.
 *
 * Activar los avisos no se prueba aquí: el navegador de las pruebas no tiene
 * servicio de push ni deja conceder el permiso de verdad.
 */

async function abrirAjustes(page: Page) {
  await page.goto("/ajustes");
  await expect(page.getByRole("region", { name: "Tu cuenta" })).toBeVisible();
}

/** Lo que mide cada sección: su título y su tarjeta. */
function medirSecciones(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("main section")]
      .filter((s) => s.querySelector(":scope > div > h2"))
      .map((s) => {
        const titulo = s.querySelector(":scope > div > h2")!.getBoundingClientRect();
        const tarjeta = s.querySelector(":scope > section")!;
        const t = tarjeta.getBoundingClientRect();
        const caja = s.getBoundingClientRect();
        return {
          nombre: s.querySelector(":scope > div > h2")!.textContent,
          tituloX: titulo.left,
          tituloDcha: titulo.right,
          x: t.left,
          dcha: t.right,
          arriba: t.top,
          abajo: t.bottom,
          cajaArriba: caja.top,
          cajaAbajo: caja.bottom,
          alineado: getComputedStyle(tarjeta).alignSelf,
        };
      }),
  );
}

for (const ancho of [1024, 1440]) {
  test(`a ${ancho} px cada sección tiene su fila, sin huecos`, async ({ page }) => {
    await page.setViewportSize({ width: ancho, height: 900 });
    await abrirAjustes(page);

    const secciones = await medirSecciones(page);
    expect(secciones.map((s) => s.nombre)).toEqual(
      expect.arrayContaining([
        "Apariencia",
        "El Atajo del iPhone",
        "Avisos en el móvil",
        "Tus datos",
        "Seguridad",
      ]),
    );

    const losa = await page.getByRole("region", { name: "Tu cuenta" }).boundingBox();
    secciones.forEach((s, i) => {
      // Una sola columna de títulos y una sola de tarjetas, hasta el canto de la losa.
      expect(s.tituloX, s.nombre!).toBeCloseTo(losa!.x, 0);
      expect(s.x, s.nombre!).toBeCloseTo(secciones[0].x, 0);
      expect(s.dcha, s.nombre!).toBeCloseTo(losa!.x + losa!.width, 0);
      expect(s.tituloDcha, s.nombre!).toBeLessThan(s.x);
      // La tarjeta mide lo suyo: no se estira hasta el alto del texto de al lado.
      expect(s.alineado, s.nombre!).toMatch(/start$/);
      // Lo que hay entre una fila y la siguiente es el margen, no un bloque vacío.
      if (i > 0) {
        expect(s.cajaArriba - secciones[i - 1].cajaAbajo, s.nombre!).toBeLessThanOrEqual(33);
      }
    });
  });
}

test("a 1024 px la cuenta de respaldo no se aplasta dentro de la tarjeta", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await abrirAjustes(page);
  const rotulo = await page.getByText("Si no reconoce la tarjeta, apuntar en").boundingBox();
  expect(rotulo!.width).toBeGreaterThan(200);
  expect(rotulo!.height).toBeLessThan(30);
});

test("en escritorio la losa lleva a Cuentas, Categorías y Reglas, con sus números", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await abrirAjustes(page);
  const losa = page.getByRole("region", { name: "Tu cuenta" });
  await expect(losa.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();

  for (const [nombre, destino] of [
    ["Cuentas", /\/cuentas$/],
    ["Categorías", /\/categorias$/],
    ["Reglas de comercio", /\/reglas$/],
  ] as const) {
    await abrirAjustes(page);
    const acceso = losa.getByRole("link", { name: new RegExp(`^${nombre}\\s*\\d+`) });
    await expect(acceso).toBeVisible();
    await acceso.click();
    await expect(page).toHaveURL(destino);
  }
});

test("en móvil: correo entero, botón en una línea y accesos de siempre", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await abrirAjustes(page);
  const losa = page.getByRole("region", { name: "Tu cuenta" });

  // El correo no se corta, y el botón de salir tiene su renglón.
  const { email } = credencialesDePrueba();
  const correo = losa.getByText(email, { exact: true });
  const cortado = await correo.evaluate((e) => e.scrollWidth > e.clientWidth);
  expect(cortado).toBe(false);

  // La tira es de escritorio: en móvil esos sitios ya están en los accesos.
  await expect(losa.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Reglas de comercio/ })).toBeVisible();

  // Se ve «Conectar», pero un lector de pantalla oye la acción entera.
  const conectar = page.getByRole("button", { name: "Conectar un dispositivo" });
  await expect(conectar).toBeVisible();
  expect((await conectar.boundingBox())!.height).toBeLessThanOrEqual(44);
});

test("el tema se cambia, se aplica y se recuerda", async ({ page }) => {
  await abrirAjustes(page);
  const html = page.locator("html");

  await page.getByRole("radio", { name: "Claro" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("radio", { name: "Claro" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("radio", { name: "Oscuro" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
});

test("conectar un dispositivo da su token, y revocarlo pide un segundo toque", async ({ page }) => {
  await abrirAjustes(page);
  const nombre = `E2E-iPhone-${Date.now()}`;

  await page.getByRole("button", { name: "Conectar un dispositivo" }).click();
  const hoja = page.getByRole("dialog");
  await hoja.getByLabel("Nombre del dispositivo").fill(nombre);
  await hoja.getByRole("button", { name: "Crear el token" }).click();

  await expect(hoja.getByRole("heading", { name: "Guarda este token ahora" })).toBeVisible();
  await expect(hoja.locator("code").first()).not.toBeEmpty();
  await expect(hoja.getByRole("button", { name: /Copiar «Bearer \+ token»/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hoja).toBeHidden();

  const fila = page
    .getByText(nombre, { exact: true })
    .locator("xpath=ancestor::div[.//button][1]");
  await expect(fila).toContainText("Todavía no ha mandado nada");

  await fila.getByRole("button", { name: "Revocar" }).click();
  await expect(page.getByText(nombre, { exact: true })).toBeVisible();
  await fila.getByRole("button", { name: "Sí, revocar" }).click();
  await expect(page.getByText(nombre, { exact: true })).toHaveCount(0);
});

test("la cuenta de respaldo se guarda y se recuerda", async ({ page }) => {
  await abrirAjustes(page);
  const campo = page.getByLabel("Si no reconoce la tarjeta, apuntar en");
  // El desplegable pinta su valor al hidratarse: hay que esperar a que lo tenga.
  await expect(campo).not.toBeEmpty();
  const antes = (await campo.innerText()).trim();
  const otra = antes === "Visa" ? "Nomina" : "Visa";

  try {
    await elegirOpcion(campo, otra);
    // Se guarda al elegir: el desplegable se bloquea mientras tanto.
    await expect(campo).toBeEnabled();
    await page.reload();
    await expect(campo).toContainText(otra);
  } finally {
    await elegirOpcion(campo, antes);
    await expect(campo).toBeEnabled();
  }
});

test("una tarjeta de Cartera se asigna a su cuenta y se quita", async ({ page }) => {
  await abrirAjustes(page);
  const nombre = `E2E-Tarjeta-${Date.now()}`;

  await page.getByLabel("Nombre en el aviso").fill(nombre);
  await elegirOpcion(page.getByLabel("Va a la cuenta"), "Visa");
  await page.getByRole("button", { name: "Asignar" }).click();

  const fila = page.getByRole("listitem").filter({ hasText: nombre });
  await expect(fila).toContainText("Visa");
  // El formulario vuelve a estar vacío para la siguiente.
  await expect(page.getByLabel("Nombre en el aviso")).toHaveValue("");

  await fila.getByRole("button", { name: "Quitar" }).click();
  await fila.getByRole("button", { name: "Sí, quitar" }).click();
  await expect(fila).toHaveCount(0);
});

test("las descargas funcionan e Importar lleva a su pantalla", async ({ page }) => {
  await abrirAjustes(page);

  for (const [titulo, tipo] of [
    ["Informe de este mes", /markdown/],
    ["Movimientos en CSV", /csv/],
    ["Copia completa en JSON", /json/],
  ] as const) {
    const enlace = page.getByRole("link", { name: new RegExp(titulo) });
    await expect(enlace).toHaveAttribute("download");
    const respuesta = await page.request.get((await enlace.getAttribute("href"))!);
    expect(respuesta.status(), titulo).toBe(200);
    expect(respuesta.headers()["content-type"], titulo).toMatch(tipo);
  }

  await page.getByRole("link", { name: /Importar del banco/ }).click();
  await expect(page).toHaveURL(/\/importar$/);
});

test("Seguridad y Avisos enseñan su estado; Invitar, solo a quien administra", async ({ page }) => {
  await abrirAjustes(page);

  await expect(page.getByRole("heading", { name: "Seguridad" })).toBeVisible();
  await expect(page.getByText("Código de 6 dígitos", { exact: true })).toBeVisible();
  await expect(page.getByText("Con verificación en dos pasos")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Avisos en el móvil" })).toBeVisible();
  await expect(page.getByText("Comprobando…")).toHaveCount(0);

  // El usuario de pruebas no administra Cartera.
  await expect(page.getByRole("heading", { name: "Invitar a alguien" })).toHaveCount(0);
});

/*
  La última: cerrar sesión revoca TODAS las sesiones del usuario, también la
  guardada que reutilizan las demás pruebas. Por eso vuelve a entrar y guarda el
  estado nuevo, y las siguientes siguen como si nada.
*/
test("cerrar sesión saca de verdad, y se vuelve a entrar", async ({ page }) => {
  await abrirAjustes(page);
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await page.waitForURL(/\/entrar(\?.*)?$/);

  await page.goto("/ajustes");
  await expect(page).toHaveURL(/\/entrar(\?.*)?$/);

  const { email, password, secret } = credencialesDePrueba();
  await entrarConContrasena(page, email, password);
  await superarCodigo(page, secret);
  await page.context().storageState({ path: STORAGE_STATE });
});
