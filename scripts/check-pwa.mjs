/**
 * Comprueba que la app se puede instalar de verdad en un iPhone.
 *
 *   node scripts/check-pwa.mjs https://mi-dominio.vercel.app
 */
const base = (process.argv[2] ?? "https://tu-dominio.vercel.app").replace(/\/$/, "");

let ok = 0;
let mal = 0;

function check(nombre, condicion, detalle = "") {
  if (condicion) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    mal++;
    console.log(`  FALLO ${nombre}${detalle ? `\n        ${detalle}` : ""}`);
  }
}

console.log(`— Instalación en iPhone: ${base} —\n`);

const manifiesto = await fetch(`${base}/manifest.webmanifest`);
const m = await manifiesto.json();

check("El manifiesto se sirve", manifiesto.status === 200);
check("Tiene nombre", m.name === "Cartera", JSON.stringify(m.name));
check(
  "Se abre a pantalla completa, sin barra de navegador",
  m.display === "standalone",
  `display = ${m.display}`,
);
check("Arranca en el resumen", m.start_url === "/resumen", m.start_url);
check(
  "Trae los tres iconos (192, 512 y enmascarable)",
  (m.icons ?? []).length >= 3,
  (m.icons ?? []).map((i) => `${i.sizes} ${i.purpose}`).join(" | "),
);
check(
  "Tiene atajo para añadir movimiento",
  (m.shortcuts ?? []).some((s) => s.url === "/movimientos/nuevo"),
);

console.log("");

for (const ruta of ["/apple-touch-icon.png", "/icono-192.png", "/icono-512.png", "/icono-mascara-512.png"]) {
  const r = await fetch(`${base}${ruta}`);
  check(
    `${ruta} existe y es PNG`,
    r.status === 200 && (r.headers.get("content-type") ?? "").includes("png"),
    `HTTP ${r.status}, tipo ${r.headers.get("content-type")}`,
  );
}

console.log("");

const html = await (await fetch(`${base}/entrar`)).text();

check("Declara el icono para iOS", html.includes("apple-touch-icon"));
check(
  "Pide abrirse en modo app en iOS",
  html.includes("apple-mobile-web-app-capable") || html.includes("mobile-web-app-capable"),
  "Sin esto, al abrirla desde la pantalla de inicio saldría con la barra de Safari.",
);

const titulo = html.match(/apple-mobile-web-app-title"\s+content="([^"]+)"/);
check(
  "Lleva el nombre que se verá bajo el icono",
  titulo?.[1] === "Cartera",
  titulo ? titulo[1] : "no declarado",
);

check("Declara el color de la barra de estado", html.includes("theme-color"));
check(
  "Ocupa la pantalla hasta los bordes (área segura)",
  html.includes("viewport-fit=cover"),
  "Sin esto, la barra de pestañas se solapa con el indicador de inicio del iPhone.",
);

const sw = await fetch(`${base}/sw.js`);
const codigo = await sw.text();
check("El service worker se sirve desde la raíz", sw.status === 200);
check("El service worker sabe recibir notificaciones", codigo.includes('addEventListener("push"'));
check(
  "Y sabe qué abrir al pulsarlas",
  codigo.includes('addEventListener("notificationclick"'),
);

const offline = await fetch(`${base}/sin-conexion`);
check("Hay página para cuando no haya conexión", offline.status === 200);

console.log(`\n${ok} correctas · ${mal} fallidas`);
process.exit(mal === 0 ? 0 : 1);
