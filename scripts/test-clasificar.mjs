/**
 * Comprueba la regla «clasificar es confirmar», con las tres variantes que
 * importan: el ascenso, y los dos casos en que NO debe ascender.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
await c.connect();
const API = process.env.NEXT_PUBLIC_SUPABASE_URL;
const S = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: S, Authorization: `Bearer ${S}`, "Content-Type": "application/json" };
const uid = (await (await fetch(`${API}/auth/v1/admin/users`, { method: "POST", headers: h, body: JSON.stringify({ email: `cls-${Date.now()}@cartera.local`, email_confirm: true }) })).json()).id;
let ok = 0, mal = 0;
const check = (n, c2, d = "") => { if (c2) { ok++; console.log("  OK    " + n); } else { mal++; console.log(`  FALLO ${n}${d ? "\n        " + d : ""}`); } };

try {
  const cuenta = (await c.query("insert into public.account (user_id,name,type) values ($1,'Visa','BANCO') returning id", [uid])).rows[0].id;
  const cat = (await c.query("insert into public.category (user_id,name,type) values ($1,'Desayuno','EXPENSE') returning id", [uid])).rows[0].id;

  const crear = async (estado) => (await c.query(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,source,status,external_id)
     values ($1,'EXPENSE',1750,'Boldu',current_date,$2,'SHORTCUT',$3,$4) returning id`,
    [uid, cuenta, estado, "x" + Math.random()])).rows[0].id;

  // Lo que hace el formulario de edición al guardar con categoría, en dos pasos
  // igual que la acción de servidor.
  const editarConCategoria = async (id) => {
    await c.query("update public.transaction set category_id=$2, category_type='EXPENSE' where id=$1", [id, cat]);
    await c.query("update public.transaction set status='CONFIRMED' where id=$1 and status='PENDING'", [id]);
  };

  const pendiente = await crear("PENDING");
  await editarConCategoria(pendiente);
  let e = (await c.query("select status from public.transaction where id=$1", [pendiente])).rows[0].status;
  check("Un PENDIENTE con categoria pasa a confirmado", e === "CONFIRMED", e);

  const descartado = await crear("DISCARDED");
  await editarConCategoria(descartado);
  e = (await c.query("select status from public.transaction where id=$1", [descartado])).rows[0].status;
  check("Un DESCARTADO sigue descartado", e === "DISCARDED", e);

  // Editar un pendiente SIN categoria no lo asciende.
  const sinCat = await crear("PENDING");
  await c.query("update public.transaction set amount_cents=2000 where id=$1", [sinCat]);
  e = (await c.query("select status from public.transaction where id=$1", [sinCat])).rows[0].status;
  check("Cambiar el importe sin clasificar lo deja pendiente", e === "PENDING", e);

  // Y quitar la categoria a uno confirmado no lo devuelve a la bandeja.
  await c.query("update public.transaction set category_id=null, category_type=null where id=$1", [pendiente]);
  e = (await c.query("select status from public.transaction where id=$1", [pendiente])).rows[0].status;
  check("Quitar la categoria no lo devuelve a pendientes", e === "CONFIRMED", e);
} finally {
  await fetch(`${API}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: h });
  await c.end();
}
console.log(`\n${ok} correctas · ${mal} fallidas`);
process.exit(mal === 0 ? 0 : 1);
