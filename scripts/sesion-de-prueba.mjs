/**
 * Prepara un usuario de prueba para poder entrar sin intervención humana.
 *
 *   node --env-file=.env.local scripts/sesion-de-prueba.mjs <email> [--forzar]
 *
 * Le pone una contraseña conocida y le da de alta un segundo factor cuyo
 * secreto queda guardado en `sesion-de-prueba.txt` (ignorado por git). A partir
 * de ahí se puede entrar por la interfaz de verdad, generando el código con
 * `node scripts/totp.mjs <secreto>`.
 *
 * Existe porque el segundo factor es obligatorio a propósito y no hay puerta de
 * atrás: sin esto, verificar cualquier pantalla a mano se queda parado en el
 * paso del código. Se salta el QR, no la comprobación.
 *
 * Solo acepta usuarios @cartera.local: cambia contraseñas y borra factores, y
 * eso no puede tocar la cuenta de nadie de verdad.
 *
 * Tampoco toca un usuario que esté usando una corrida del e2e en marcha (lo
 * reserva `e2e/usuario.ts`): borrarle el factor la tumbaría. `--forzar` se lo
 * salta, para cuando se sabe que el cerrojo es de una corrida muerta.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { totp } from "./totp.mjs";

const email = process.argv[2];
if (!email) {
  console.error("Uso: node --env-file=.env.local scripts/sesion-de-prueba.mjs <email>");
  process.exit(2);
}
if (!email.endsWith("@cartera.local")) {
  console.error(`Me niego a tocar «${email}»: solo usuarios de prueba @cartera.local.`);
  process.exit(2);
}

// 0 · ¿Hay una corrida del e2e usándolo ahora mismo? (B-7)
//
// Borrar el factor revoca todas las sesiones aal2 del usuario: hacerlo a mitad
// de un e2e ajeno lo tumba entero. El arnés reserva su usuario con un cerrojo
// consultivo (`e2e/usuario.ts`, clave «e2e:<correo>»); si está tomado, me
// niego, salvo que me lance el propio arnés (E2E_CERROJO_PROPIO=1) o se fuerce.
if (process.env.E2E_CERROJO_PROPIO !== "1" && !process.argv.includes("--forzar")) {
  if (!process.env.DATABASE_URL) {
    console.warn("Aviso: sin DATABASE_URL no puedo comprobar si un e2e está usando este usuario.");
  } else {
    const pg = (await import("pg")).default;
    const { sslDb } = await import("./db-ssl.mjs");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
    await db.connect();
    const { rows } = await db.query("select pg_try_advisory_lock(hashtext($1)) as libre", [`e2e:${email}`]);
    if (rows[0].libre) await db.query("select pg_advisory_unlock(hashtext($1))", [`e2e:${email}`]);
    await db.end();
    if (!rows[0].libre) {
      console.error(
        `${email} está reservado por una corrida del e2e en marcha: si le borro el factor, la tumbo. ` +
          "Usa otro usuario de prueba, espera a que termine o, si sabes que no hay ninguna, --forzar.",
      );
      process.exit(3);
    }
  }
}

const api = process.env.NEXT_PUBLIC_SUPABASE_URL;
const servicio = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = { apikey: servicio, Authorization: `Bearer ${servicio}`, "Content-Type": "application/json" };

/**
 * Una contraseña NUEVA y aleatoria en cada ejecución, que solo queda en
 * sesion-de-prueba.txt (fuera de git), de donde la leen el e2e y los demás
 * scripts. Antes era una constante escrita aquí: cualquiera que leyera el
 * repositorio la tenía. Con el segundo factor no bastaba para ver datos, pero
 * una contraseña de producción no va en el código.
 */
const CLAVE = `Prueba-${randomBytes(18).toString("base64url")}`;

async function json(respuesta, que) {
  const cuerpo = await respuesta.json().catch(() => null);
  if (!respuesta.ok) {
    throw new Error(`${que}: HTTP ${respuesta.status} ${JSON.stringify(cuerpo)}`);
  }
  return cuerpo;
}

// 1 · Encontrar al usuario.
const lista = await json(
  await fetch(`${api}/auth/v1/admin/users?per_page=200`, { headers: admin }),
  "listar usuarios",
);
const usuario = (lista.users ?? []).find((u) => u.email === email);
if (!usuario) {
  console.error(`No existe ningún usuario ${email}.`);
  process.exit(1);
}

// 2 · Contraseña conocida.
await json(
  await fetch(`${api}/auth/v1/admin/users/${usuario.id}`, {
    method: "PUT",
    headers: admin,
    body: JSON.stringify({ password: CLAVE, email_confirm: true }),
  }),
  "poner contraseña",
);

// 3 · Fuera los factores anteriores, que no sabemos su secreto.
//
// Hay que pedir el usuario de uno en uno: el listado NO trae los factores, y
// dar por hecho que sí dejaba el factor viejo en su sitio. Entonces Supabase
// rechaza dar de alta uno nuevo con «AAL2 required», porque ya hay uno activo.
const completo = await json(
  await fetch(`${api}/auth/v1/admin/users/${usuario.id}`, { headers: admin }),
  "leer el usuario",
);
for (const factor of completo.factors ?? []) {
  await json(
    await fetch(`${api}/auth/v1/admin/users/${usuario.id}/factors/${factor.id}`, {
      method: "DELETE",
      headers: admin,
    }),
    "borrar el factor anterior",
  );
}

// 4 · Entrar con la contraseña. Esta sesión es aal1: no ve ni una fila.
const sesion = await json(
  await fetch(`${api}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: CLAVE }),
  }),
  "entrar con contraseña",
);

// 4b · Cerrar todas las DEMÁS sesiones del usuario. Una cookie o un token de
// refresco que se hubiera quedado en algún sitio (una traza del e2e, un
// navegador olvidado) deja de valer: solo sigue viva la que se acaba de abrir.
const cierre = await fetch(`${api}/auth/v1/logout?scope=others`, {
  method: "POST",
  headers: { apikey: anon, Authorization: `Bearer ${sesion.access_token}` },
});
if (!cierre.ok) throw new Error(`cerrar las demás sesiones: HTTP ${cierre.status}`);

const conSesion = {
  apikey: anon,
  Authorization: `Bearer ${sesion.access_token}`,
  "Content-Type": "application/json",
};

// 5 · Dar de alta un factor y quedarnos con el secreto.
const factor = await json(
  await fetch(`${api}/auth/v1/factors`, {
    method: "POST",
    headers: conSesion,
    body: JSON.stringify({ factor_type: "totp", friendly_name: `prueba-${Date.now()}` }),
  }),
  "dar de alta el factor",
);

const secreto = factor.totp?.secret;
if (!secreto) throw new Error("Supabase no ha devuelto el secreto del factor");

// 6 · Verificarlo, que es lo que lo deja activo.
const reto = await json(
  await fetch(`${api}/auth/v1/factors/${factor.id}/challenge`, {
    method: "POST",
    headers: conSesion,
  }),
  "crear el reto",
);

const verificada = await json(
  await fetch(`${api}/auth/v1/factors/${factor.id}/verify`, {
    method: "POST",
    headers: conSesion,
    body: JSON.stringify({ challenge_id: reto.id, code: totp(secreto) }),
  }),
  "verificar el código",
);

// El secreto es una credencial: va a un fichero ignorado, no a la pantalla.
writeFileSync(
  "sesion-de-prueba.txt",
  [
    `# Usuario de prueba. Fichero ignorado por git.`,
    `EMAIL=${email}`,
    `PASSWORD=${CLAVE}`,
    `TOTP_SECRET=${secreto}`,
    ``,
    `# Código de ahora mismo (caduca en 30 s):`,
    `#   node scripts/totp.mjs ${secreto}`,
    ``,
  ].join("\n"),
  "utf8",
);

console.log(`Listo. ${email} tiene contraseña y segundo factor.`);
console.log(`Credenciales en sesion-de-prueba.txt · nivel alcanzado: ${verificada.access_token ? "aal2" : "?"}`);
