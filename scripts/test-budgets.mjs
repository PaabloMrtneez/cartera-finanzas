/**
 * Prueba los límites de gasto y la comparativa contra la media.
 *
 * El invariante que más importa: un gasto SIN CLASIFICAR no consume tope. Si
 * eso se rompiera, los avisos saltarían por dinero que ni siquiera sabes en qué
 * se fue.
 *
 *   node --env-file=.env.local scripts/test-budgets.mjs
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: sslDb,
});

const API = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

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

async function comoUsuario(userId, trabajo) {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    return await trabajo();
  } finally {
    await client.query("commit");
  }
}

async function main() {
  await client.connect();

  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email: `budget-${Date.now()}@cartera.local`, email_confirm: true }),
  });
  const uid = (await alta.json()).id;
  // La fecha SIEMPRE se pide a la base, nunca a `new Date()`.
  // `new Date().toISOString()` da la fecha en UTC, y en Madrid en verano son dos
  // horas menos: entre las 00:00 y las 02:00 devolvería el dia (y el mes) anterior
  // y la prueba fallaria sola segun la hora a la que se lance. La base es la que
  // evalua `current_date` en el SQL que estamos probando.
  const mes =
    (await client.query("select current_date::text as d")).rows[0].d.slice(0, 7) + "-01";

  try {
    const cuenta = (
      await client.query(
        "insert into public.account (user_id, name, type) values ($1,'Visa','BANCO') returning id",
        [uid],
      )
    ).rows[0].id;

    const cat = (
      await client.query(
        "insert into public.category (user_id, name, type) values ($1,'Restaurantes','EXPENSE') returning id",
        [uid],
      )
    ).rows[0].id;

    // Tope de 200 €.
    await client.query(
      `insert into public.budget (user_id, category_id, category_type, monthly_cap_cents)
       values ($1,$2,'EXPENSE',20000)`,
      [uid, cat],
    );

    const gasto = async (cents, categoria) =>
      client.query(
        `insert into public.transaction
           (user_id, type, amount_cents, occurred_on, account_id, category_id, category_type)
         values ($1,'EXPENSE',$2,current_date,$3,$4,$5) returning id`,
        [uid, cents, cuenta, categoria, categoria ? "EXPENSE" : null],
      );

    console.log("— Consumo de límite —\n");

    await gasto(5000, cat);
    let estado = await comoUsuario(uid, async () =>
      (await client.query("select * from public.budget_status($1)", [mes])).rows[0],
    );
    check(
      "Un gasto clasificado consume tope",
      Number(estado.spent_cents) === 5000 && Number(estado.pct) === 25,
      `gastado ${estado.spent_cents}, ${estado.pct}%`,
    );

    // EL INVARIANTE: sin categoría no consume nada.
    await gasto(9000, null);
    estado = await comoUsuario(uid, async () =>
      (await client.query("select * from public.budget_status($1)", [mes])).rows[0],
    );
    check(
      "Un gasto SIN CLASIFICAR no consume tope",
      Number(estado.spent_cents) === 5000,
      `Tras un gasto sin categoría de 90 €, el consumo pasó a ${estado.spent_cents}. Debía seguir en 5000.`,
    );

    console.log("\n— Reembolsos —\n");

    const cena = await gasto(12000, cat);
    await client.query(
      `insert into public.transaction
         (user_id, type, amount_cents, occurred_on, account_id, reimburses_id, reimburses_target_type)
       values ($1,'INCOME',4000,current_date,$2,$3,'EXPENSE')`,
      [uid, cuenta, cena.rows[0].id],
    );

    estado = await comoUsuario(uid, async () =>
      (await client.query("select * from public.budget_status($1)", [mes])).rows[0],
    );
    check(
      "Un reembolso descuenta del tope",
      Number(estado.spent_cents) === 5000 + 12000 - 4000,
      `gastado ${estado.spent_cents}, se esperaba ${5000 + 12000 - 4000}`,
    );

    // Con el descuento apagado, el reembolso no debe restar.
    await client.query("update public.budget set discount_reimbursements = false where user_id = $1", [uid]);
    estado = await comoUsuario(uid, async () =>
      (await client.query("select * from public.budget_status($1)", [mes])).rows[0],
    );
    check(
      "Si se apaga el descuento, el reembolso no resta",
      Number(estado.spent_cents) === 5000 + 12000,
      `gastado ${estado.spent_cents}, se esperaba ${17000}`,
    );

    console.log("\n— Exceso —\n");

    await gasto(10000, cat);
    estado = await comoUsuario(uid, async () =>
      (await client.query("select * from public.budget_status($1)", [mes])).rows[0],
    );
    check(
      "Detecta el exceso sobre el tope",
      Number(estado.spent_cents) > Number(estado.effective_cap_cents),
      `gastado ${estado.spent_cents} de ${estado.effective_cap_cents}`,
    );
    check("El porcentaje pasa de 100", Number(estado.pct) > 100, `${estado.pct}%`);

    console.log("\n— Media de 6 meses —\n");

    const medias = await comoUsuario(uid, async () =>
      (await client.query("select * from public.category_avg_6m($1)", [mes])).rows,
    );
    const restaurantes = medias.find((m) => m.name === "Restaurantes");
    check(
      "Cuenta el mes en curso aparte de la media",
      restaurantes && Number(restaurantes.current_cents) > 0,
      JSON.stringify(restaurantes),
    );
    check(
      "Sin histórico, la media es cero y lo dice",
      restaurantes && Number(restaurantes.avg_cents) === 0 && restaurantes.months_with_data === 0,
      `media ${restaurantes?.avg_cents}, meses ${restaurantes?.months_with_data}`,
    );

    console.log("\n— Hallazgos —\n");

    const hallazgos = await comoUsuario(uid, async () =>
      (await client.query("select * from public.month_findings($1)", [mes])).rows,
    );
    check(
      "Avisa del gasto sin clasificar",
      hallazgos.some((x) => x.kind === "sin-clasificar" && Number(x.cents) === 9000),
      JSON.stringify(hallazgos.map((x) => [x.kind, x.cents])),
    );
    check(
      "Avisa del límite rebasado",
      hallazgos.some((x) => x.kind === "limite-pasado"),
      JSON.stringify(hallazgos.map((x) => x.kind)),
    );
  } finally {
    await fetch(`${API}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: h });
    await client.end();
  }

  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await client.end().catch(() => {});
  process.exit(2);
});
