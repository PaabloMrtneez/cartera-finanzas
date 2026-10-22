/**
 * Prueba «Ingresos recurrentes»: generación y previsión.
 *
 *   node --env-file=.env.local scripts/test-ingresos.mjs
 *
 * Lo que se demuestra:
 *   · generate_recurring_income crea un movimiento INCOME por cada fecha vencida
 *     (recupera los atrasados uno a uno), con recurring_income_id y source RECURRING
 *   · es idempotente: volver a llamarla no duplica (índice único por fecha)
 *   · pending_recurring_income da lo que falta por entrar ESTE mes, y 0 en otro mes
 *   · un usuario no ve ni un ingreso recurrente de otro
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
  if (cond) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    mal++;
    console.log(`  FALLO ${nombre}${detalle ? `\n        ${detalle}` : ""}`);
  }
}

async function comoUsuario(uid, trabajo) {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    return await trabajo();
  } finally {
    await client.query("commit");
  }
}

const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

const usuarios = [];
async function nuevoUsuario(prefijo) {
  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      email: `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@cartera.local`,
      email_confirm: true,
    }),
  });
  return (await alta.json()).id;
}

async function main() {
  await client.connect();
  const uid = await nuevoUsuario("ing");
  usuarios.push(uid);

  try {
    const banco = (
      await q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id", [uid])
    )[0].id;
    const cat = (
      await q("insert into public.category (user_id,name,type) values ($1,'Salario','INCOME') returning id", [uid])
    )[0].id;

    console.log("— Generación con recuperación de atrasados —\n");

    // Nómina mensual que arranca hace 2 meses (día 1): al generar debe crear los
    // 3 meses vencidos (hace 2, hace 1, este).
    await q(
      `insert into public.recurring_income (user_id,description,amount_cents,periodicity,next_income_date,started_at,category_id,category_type,account_id)
       values ($1,'Nómina',180000,'MENSUAL',
               (date_trunc('month', current_date) - interval '2 months')::date,
               (date_trunc('month', current_date) - interval '2 months')::date,
               $2,'INCOME',$3)`,
      [uid, cat, banco],
    );

    const [gen1] = await comoUsuario(uid, () => q("select public.generate_recurring_income() as n"));
    check("Genera los 3 ingresos vencidos (hace 2, hace 1, este mes)", Number(gen1.n) === 3, `creó ${gen1.n}`);

    const movs = await comoUsuario(uid, () =>
      q("select type, amount_cents, source from public.transaction where recurring_income_id is not null order by occurred_on"),
    );
    check("Son 3 movimientos", movs.length === 3, `${movs.length}`);
    check(
      "Todos INCOME, 1800 €, source RECURRING",
      movs.every((m) => m.type === "INCOME" && Number(m.amount_cents) === 180000 && m.source === "RECURRING"),
      JSON.stringify(movs[0]),
    );

    console.log("\n— Idempotencia —\n");
    const [gen2] = await comoUsuario(uid, () => q("select public.generate_recurring_income() as n"));
    check("Volver a generar no crea nada", Number(gen2.n) === 0, `creó ${gen2.n}`);

    console.log("\n— Lo que falta por entrar este mes —\n");

    // Un alquiler que cobras el último día del mes: aún no ha entrado.
    await q(
      `insert into public.recurring_income (user_id,description,amount_cents,periodicity,next_income_date,started_at,category_id,category_type,account_id)
       values ($1,'Alquiler',50000,'MENSUAL',
               (date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date,
               current_date,$2,'INCOME',$3)`,
      [uid, cat, banco],
    );

    const [pend] = await comoUsuario(uid, () =>
      q("select public.pending_recurring_income(date_trunc('month', current_date)::date) as v"),
    );
    // La nómina ya se generó (su próximo cargo es el mes que viene), así que lo
    // pendiente de este mes es solo el alquiler.
    check("Lo pendiente de este mes es el alquiler (50000)", Number(pend.v) === 50000, `${pend.v}`);

    const [pendPasado] = await comoUsuario(uid, () =>
      q("select public.pending_recurring_income((date_trunc('month', current_date) - interval '3 months')::date) as v"),
    );
    check("Un mes pasado no tiene pendiente (0)", Number(pendPasado.v) === 0, `${pendPasado.v}`);

    console.log("\n— Aislamiento —\n");
    const otro = await nuevoUsuario("ing-otro");
    usuarios.push(otro);
    const ajeno = await comoUsuario(otro, () =>
      q("select public.pending_recurring_income(date_trunc('month', current_date)::date) as v, (select count(*) from public.v_recurring_income_summary) as c"),
    );
    check(
      "Otro usuario no ve ingresos de este",
      Number(ajeno[0].v) === 0 && Number(ajeno[0].c) === 0,
      `pend ${ajeno[0].v} · filas ${ajeno[0].c}`,
    );
  } finally {
    for (const u of usuarios) {
      await fetch(`${API}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: h }).catch(() => {});
    }
    await client.end();
  }

  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  for (const u of usuarios) {
    await fetch(`${API}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: h }).catch(() => {});
  }
  await client.end().catch(() => {});
  process.exit(2);
});
