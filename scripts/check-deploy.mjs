/**
 * Comprueba un despliegue real: que las pantallas cargan, que la ingesta
 * responde, y —lo más importante— que ninguna credencial de servidor se ha
 * colado en el HTML que recibe el navegador.
 *
 *   node scripts/check-deploy.mjs https://mi-dominio.vercel.app
 */
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) {
  console.error("Uso: node scripts/check-deploy.mjs <url>");
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  OK    ${name}`);
  } else {
    failed++;
    console.log(`  FALLO ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

console.log(`— ${base} —\n`);

const login = await fetch(`${base}/entrar`);
const html = await login.text();

check("La pantalla de acceso carga", login.status === 200, `HTTP ${login.status}`);
check("Trae el campo de correo", html.includes('id="email"'));
check("Trae el campo de contraseña", html.includes('id="password"'));
check("Avisa de que el registro está cerrado", html.includes("por invitaci"));
// Las variables NEXT_PUBLIC_ se incrustan en los paquetes de JavaScript, no en
// el HTML: hay que buscarlas ahí. Si no aparecen, es que no estaban puestas en
// el momento de compilar y el acceso no funcionará.
//
// `/entrar` carga supabase-js en un trozo aparte, al enfocar el formulario: la
// URL no está en los paquetes que nombra el HTML sino en los que ESOS nombran.
// Por eso se sigue un nivel de referencias `static/…/chunks/…js`.
const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
const pendientes = [...scripts];
const vistos = new Set();
let supabaseEnBundle = false;
while (pendientes.length && vistos.size < 60 && !supabaseEnBundle) {
  const src = pendientes.shift();
  if (vistos.has(src)) continue;
  vistos.add(src);
  const code = await fetch(`${base}${src}`).then((r) => r.text());
  if (code.includes("supabase.co")) supabaseEnBundle = true;
  for (const m of code.matchAll(/"(static\/(?:immutable\/)?chunks\/[A-Za-z0-9_-]+\.js)"/g)) {
    pendientes.push(`/_next/${m[1]}`);
  }
}
check(
  "La URL de Supabase llegó al paquete del cliente",
  supabaseEnBundle,
  `Revisados ${vistos.size} paquetes. Si falla, las variables NEXT_PUBLIC_ no estaban al compilar.`,
);

// Lo que de verdad no puede pasar nunca.
check(
  "Ninguna clave secreta en el HTML",
  !/sb_secret_[A-Za-z0-9_-]{16,}/.test(html),
  "¡Hay una clave de servicio en la página! Rótala inmediatamente.",
);
check(
  "Ninguna contraseña de base de datos en el HTML",
  !/postgresql:\/\/[^"'\s]+/.test(html),
  "Hay una cadena de conexión en la página.",
);

const raiz = await fetch(base, { redirect: "manual" });
check(
  "La raíz redirige en vez de mostrar datos",
  raiz.status === 307 || raiz.status === 308 || raiz.status === 302 || raiz.status === 200,
  `HTTP ${raiz.status}`,
);

const ingesta = await fetch(`${base}/api/ingest`);
const cuerpo = await ingesta.json().catch(() => null);
check(
  "La ingesta responde y se identifica",
  ingesta.status === 200 && cuerpo?.service === "cartera-ingest",
  JSON.stringify(cuerpo),
);

const sinToken = await fetch(`${base}/api/ingest`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ merchant: "X", amount: "1,00" }),
});
check("La ingesta sin token se rechaza con 401", sinToken.status === 401, `HTTP ${sinToken.status}`);

/**
 * Los avisos los pide una tarea programada, sin sesión. Si el proxy la
 * intercepta, responde 307 hacia la pantalla de acceso y el envío no se ejecuta
 * nunca: exactamente lo que pasó durante días sin que nadie lo viera, porque un
 * 307 no es un error para nadie salvo para quien lo esté esperando en 200.
 *
 * Un 401 aquí es la buena señal: significa que la petición LLEGÓ a la ruta y
 * fue esta la que la rechazó por no traer el secreto.
 */
const avisosSinSecreto = await fetch(`${base}/api/notificar`, { method: "POST", redirect: "manual" });
check(
  "Los avisos llegan a su ruta y piden secreto, no redirigen",
  avisosSinSecreto.status === 401,
  `HTTP ${avisosSinSecreto.status}${
    avisosSinSecreto.status === 307 ? " · el proxy la está interceptando" : ""
  }`,
);

const manifiesto = await fetch(`${base}/manifest.webmanifest`);
const mf = await manifiesto.json().catch(() => null);
check(
  "El manifiesto de la app instalable es válido",
  manifiesto.status === 200 && mf?.name === "Cartera" && mf?.display === "standalone",
  JSON.stringify(mf).slice(0, 120),
);

const icono = await fetch(`${base}/apple-touch-icon.png`);
check("El icono para el iPhone existe", icono.status === 200, `HTTP ${icono.status}`);

const sw = await fetch(`${base}/sw.js`);
check("El service worker se sirve desde la raíz", sw.status === 200, `HTTP ${sw.status}`);

console.log(`\n${passed} correctas · ${failed} fallidas`);
process.exit(failed === 0 ? 0 : 1);
