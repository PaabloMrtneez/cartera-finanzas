/**
 * Crea un usuario de PRUEBAS más (p. ej., uno por agente o por worktree), para
 * que dos corridas del e2e no tengan que esperar la una a la otra.
 *
 *   node --env-file=.env.local scripts/crear-usuario-prueba.mjs <nombre@cartera.local>
 *
 * Solo acepta correos @cartera.local (un dominio que no recibe correo: nadie
 * puede pedir un enlace de acceso a esa dirección). Lo da de alta ya confirmado
 * y con una contraseña aleatoria que no se guarda: la que vale la pone después
 * `sesion-de-prueba.mjs`, que es también quien le da el segundo factor. Sus
 * datos los siembra `seed-demo.mjs`; el `profile` lo crea el disparador de
 * `auth.users`, como a cualquier usuario.
 *
 * Si el usuario ya existe, no hace nada. Es la única forma de crear uno sin
 * invitación, por eso se niega a cualquier otro dominio.
 *
 * Después, para usarlo en el e2e:  E2E_EMAIL=<nombre@cartera.local> npm run e2e
 */
import { randomBytes } from "node:crypto";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[a-z0-9._-]+@cartera\.local$/.test(email)) {
  console.error("Uso: node --env-file=.env.local scripts/crear-usuario-prueba.mjs <nombre@cartera.local>");
  console.error("Solo usuarios de prueba @cartera.local.");
  process.exit(2);
}

const api = process.env.NEXT_PUBLIC_SUPABASE_URL;
const servicio = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!api || !servicio) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (¿--env-file?).");
  process.exit(2);
}
const admin = { apikey: servicio, Authorization: `Bearer ${servicio}`, "Content-Type": "application/json" };

const lista = await fetch(`${api}/auth/v1/admin/users?per_page=200`, { headers: admin });
if (!lista.ok) throw new Error(`listar usuarios: HTTP ${lista.status}`);
const { users = [] } = await lista.json();
if (users.some((u) => u.email === email)) {
  console.log(`${email} ya existe: no hago nada.`);
  process.exit(0);
}

const alta = await fetch(`${api}/auth/v1/admin/users`, {
  method: "POST",
  headers: admin,
  body: JSON.stringify({
    email,
    email_confirm: true,
    password: randomBytes(24).toString("base64url"),
  }),
});
if (!alta.ok) {
  throw new Error(`crear ${email}: HTTP ${alta.status} ${await alta.text().catch(() => "")}`);
}
console.log(`Creado ${email}. Siguiente: E2E_EMAIL=${email} npm run e2e`);
