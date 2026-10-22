/**
 * Prueba «Análisis profundo»: year_over_year y category_trend.
 *
 *   node --env-file=.env.local scripts/test-analisis.mjs
 *
 * Lo que se demuestra:
 *   · el año a año alinea el mes en curso con el MISMO mes del año pasado
 *   · un mes sin movimientos llega como null (hueco), no como 0
 *   · hereda los invariantes de v_transaction_econ: un traspaso no cuenta, un
 *     reembolso resta del gasto de su categoría
 *   · category_trend agrupa por categoría con la serie mensual
 *   · un usuario no ve ni un dato de otro
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
  const uid = (await alta.json()).id;
  usuarios.push(uid);
  return uid;
}

const yoy = (uid) =>
  comoUsuario(uid, () => q("select * from public.year_over_year(current_date, 12)"));
const filaMes = (filas) => filas[filas.length - 1]; // último = mes en curso

async function main() {
  await client.connect();
  try {
    console.log("— Año a año: alineación con el mismo mes del año pasado —\n");

    const uid = await nuevoUsuario("ana");
    const [banco, ahorro] = await Promise.all([
      q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id", [uid]).then((r) => r[0].id),
      q("insert into public.account (user_id,name,type) values ($1,'Ahorro','AHORRO') returning id", [uid]).then((r) => r[0].id),
    ]);
    const cat = (
      await q("insert into public.category (user_id,name,type) values ($1,'Compras','EXPENSE') returning id", [uid])
    )[0].id;

    const gasto = (cents, fechaSql) =>
      q(
        `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
         values ($1,'EXPENSE',$2,'x',${fechaSql},$3,$4,'EXPENSE','MANUAL','CONFIRMED') returning id`,
        [uid, cents, banco, cat],
      ).then((r) => r[0].id);

    // 50 € este mes, 30 € el mismo mes del año pasado.
    const gastoActual = await gasto(5000, "date_trunc('month', current_date)::date");
    await gasto(3000, "(date_trunc('month', current_date) - interval '1 year')::date");

    let filas = await yoy(uid);
    check("Devuelve 12 meses", filas.length === 12, `${filas.length}`);
    const mes = filaMes(filas);
    check(
      "El mes en curso: gasto de este año = 5000",
      Number(mes.net_expense_cents) === 5000,
      `${mes.net_expense_cents}`,
    );
    check(
      "El mes en curso: gasto del año pasado = 3000 (mismo mes, un año antes)",
      Number(mes.prev_net_expense_cents) === 3000,
      `${mes.prev_net_expense_cents}`,
    );
    check(
      "Un mes sin movimientos llega como null, no como 0",
      filas[0].net_expense_cents === null && filas[0].prev_net_expense_cents === null,
      `net ${filas[0].net_expense_cents} · prev ${filas[0].prev_net_expense_cents}`,
    );

    console.log("\n— Invariantes heredados del econ —\n");

    // Un traspaso no es gasto.
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,source,status)
       values ($1,'TRANSFER',40000,'A ahorro',date_trunc('month', current_date)::date,$2,$3,'MANUAL','CONFIRMED')`,
      [uid, banco, ahorro],
    );
    filas = await yoy(uid);
    check("Un traspaso no toca el gasto del mes", Number(filaMes(filas).net_expense_cents) === 5000, `${filaMes(filas).net_expense_cents}`);

    // Un reembolso de 20 € rebaja el gasto de Compras a 30 €.
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,reimburses_id,reimburses_target_type,source,status)
       values ($1,'INCOME',2000,'Devolucion',date_trunc('month', current_date)::date,$2,$3,'EXPENSE',$4,'EXPENSE','MANUAL','CONFIRMED')`,
      [uid, banco, cat, gastoActual],
    );
    filas = await yoy(uid);
    check("Un reembolso resta del gasto (5000 − 2000 = 3000)", Number(filaMes(filas).net_expense_cents) === 3000, `${filaMes(filas).net_expense_cents}`);

    console.log("\n— Tendencia por categoría —\n");

    const trend = await comoUsuario(uid, () =>
      q("select * from public.category_trend(current_date, 12)"),
    );
    const compras = trend.filter((t) => t.name === "Compras");
    check("Aparece la categoría Compras", compras.length === 12, `filas Compras: ${compras.length}`);
    const comprasMes = compras[compras.length - 1];
    check(
      "El gasto del mes en curso en Compras = 3000 (con el reembolso restado)",
      Number(comprasMes.net_cents) === 3000,
      `${comprasMes.net_cents}`,
    );

    console.log("\n— Aislamiento —\n");

    const otro = await nuevoUsuario("ana-otro");
    const ajenoYoy = await yoy(otro);
    const ajenoTrend = await comoUsuario(otro, () =>
      q("select * from public.category_trend(current_date, 12)"),
    );
    check(
      "Otro usuario no ve ni un dato de este",
      ajenoYoy.every((f) => f.net_expense_cents === null && f.prev_net_expense_cents === null) &&
        ajenoTrend.length === 0,
      `yoy con dato: ${ajenoYoy.filter((f) => f.net_expense_cents !== null).length} · trend filas: ${ajenoTrend.length}`,
    );
  } finally {
    for (const uid of usuarios) {
      await fetch(`${API}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: h }).catch(() => {});
    }
    await client.end();
  }

  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  for (const uid of usuarios) {
    await fetch(`${API}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: h }).catch(() => {});
  }
  await client.end().catch(() => {});
  process.exit(2);
});
