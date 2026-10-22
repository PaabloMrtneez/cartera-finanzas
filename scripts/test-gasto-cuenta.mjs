/**
 * Prueba «Gasto por cuenta»: account_spend_history.
 *
 *   node --env-file=.env.local scripts/test-gasto-cuenta.mjs
 *
 * Lo que se demuestra:
 *   · el gasto de una cuenta son sus EXPENSE, mes a mes
 *   · NO cuentan los traspasos (mueven, no gastan), ni los ingresos, ni los descartados
 *   · una cuenta sin gasto no aparece
 *   · un usuario no ve el gasto de otro
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const API = process.env.NEXT_PUBLIC_SUPABASE_URL;
const S = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: S, Authorization: `Bearer ${S}`, "Content-Type": "application/json" };

let ok = 0;
let mal = 0;
function check(nombre, cond, detalle = "") {
  if (cond) { ok++; console.log(`  OK    ${nombre}`); }
  else { mal++; console.log(`  FALLO ${nombre}${detalle ? `\n        ${detalle}` : ""}`); }
}
async function comoUsuario(uid, trabajo) {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    return await trabajo();
  } finally { await client.query("commit"); }
}
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
const usuarios = [];
async function nuevoUsuario(prefijo) {
  const r = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST", headers: h,
    body: JSON.stringify({ email: `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2,7)}@cartera.local`, email_confirm: true }),
  });
  const uid = (await r.json()).id; usuarios.push(uid); return uid;
}

async function main() {
  await client.connect();
  const uid = await nuevoUsuario("gc");
  try {
    const [banco, ahorro] = await Promise.all([
      q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id",[uid]).then(r=>r[0].id),
      q("insert into public.account (user_id,name,type) values ($1,'Ahorro','AHORRO') returning id",[uid]).then(r=>r[0].id),
    ]);
    const cat = (await q("insert into public.category (user_id,name,type) values ($1,'Compras','EXPENSE') returning id",[uid]))[0].id;

    const gasto = (cents, fechaSql, status="CONFIRMED") =>
      q(`insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
         values ($1,'EXPENSE',$2,'x',${fechaSql},$3,$4,'EXPENSE','MANUAL',$5)`,[uid,cents,banco,cat,status]);

    // Banco: 50 € este mes + 30 € el mes pasado.
    await gasto(5000, "date_trunc('month', current_date)::date");
    await gasto(3000, "(date_trunc('month', current_date) - interval '1 month')::date");
    // Ruido que NO debe contar como gasto de Banco:
    await gasto(4000, "date_trunc('month', current_date)::date", "DISCARDED"); // descartado
    await q(`insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,source,status)
             values ($1,'TRANSFER',2000,'a ahorro',date_trunc('month', current_date)::date,$2,$3,'MANUAL','CONFIRMED')`,[uid,banco,ahorro]); // traspaso
    await q(`insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,source,status)
             values ($1,'INCOME',10000,'nomina',date_trunc('month', current_date)::date,$2,'MANUAL','CONFIRMED')`,[uid,banco]); // ingreso

    console.log("— Gasto por cuenta —\n");
    const filas = await comoUsuario(uid, () => q("select * from public.account_spend_history(6)"));
    const deBanco = filas
      .filter((f) => f.account_id === banco)
      .sort((a, b) => new Date(a.period_month).getTime() - new Date(b.period_month).getTime());
    const esteMes = deBanco[deBanco.length - 1];
    const mesPasado = deBanco[deBanco.length - 2];

    check("Banco aparece con serie mensual", deBanco.length >= 2, `filas: ${deBanco.length}`);
    check("Gasto de este mes = 5000 (solo el EXPENSE; ni traspaso, ni ingreso, ni descartado)", Number(esteMes.gasto_cents) === 5000, `${esteMes?.gasto_cents}`);
    check("Gasto del mes pasado = 3000", Number(mesPasado.gasto_cents) === 3000, `${mesPasado?.gasto_cents}`);
    check("La cuenta de Ahorro (sin gasto) no aparece", !filas.some((f) => f.account_id === ahorro), "aparece Ahorro");

    console.log("\n— Aislamiento —\n");
    const otro = await nuevoUsuario("gc-otro");
    const ajeno = await comoUsuario(otro, () => q("select * from public.account_spend_history(6)"));
    check("Otro usuario no ve el gasto de este", ajeno.length === 0, `ve ${ajeno.length}`);
  } finally {
    for (const u of usuarios) await fetch(`${API}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: h }).catch(()=>{});
    await client.end();
  }
  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}
main().catch(async (e) => {
  console.error(e);
  for (const u of usuarios) await fetch(`${API}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: h }).catch(()=>{});
  await client.end().catch(()=>{});
  process.exit(2);
});
