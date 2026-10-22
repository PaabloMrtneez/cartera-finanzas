/**
 * Borra el segundo factor de alguien, para que pueda darlo de alta otra vez.
 *
 * Supabase no genera códigos de respaldo: si alguien pierde el móvil y no
 * guardó el secreto, esta es la ÚNICA forma de recuperar su cuenta. Requiere la
 * clave de servicio, así que solo puede hacerlo quien administre el proyecto.
 *
 *   node --env-file=.env.local scripts/reset-2fa.mjs alguien@correo.com
 *
 * Después, esa persona tendrá que volver a escanear un QR nuevo la próxima vez
 * que entre. Su contraseña no se toca.
 */
const email = process.argv[2];
if (!email || !email.includes("@")) {
  console.error("Uso: node --env-file=.env.local scripts/reset-2fa.mjs <correo>");
  process.exit(2);
}

const api = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: secret, Authorization: `Bearer ${secret}` };

const lista = await (await fetch(`${api}/auth/v1/admin/users?per_page=200`, { headers })).json();
const encontrado = lista.users?.find((u) => u.email === email);

if (!encontrado) {
  console.error(`No existe ninguna cuenta con ${email}`);
  process.exit(1);
}

// La lista no incluye los factores; hay que pedir el usuario concreto.
const usuario = await (
  await fetch(`${api}/auth/v1/admin/users/${encontrado.id}`, { headers })
).json();

const factores = usuario.factors ?? [];
if (factores.length === 0) {
  console.log(`${email} no tiene ningún segundo factor. Nada que borrar.`);
  process.exit(0);
}

for (const factor of factores) {
  const r = await fetch(`${api}/auth/v1/admin/users/${usuario.id}/factors/${factor.id}`, {
    method: "DELETE",
    headers,
  });
  console.log(`  ${factor.factor_type} (${factor.status}) → ${r.ok ? "borrado" : `error ${r.status}`}`);
}

console.log(`\nListo. La próxima vez que ${email} entre, tendrá que escanear un QR nuevo.`);
console.log("Su contraseña sigue siendo la misma.");
