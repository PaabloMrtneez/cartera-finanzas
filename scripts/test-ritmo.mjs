/**
 * Prueba «Ritmo del mes»: el acumulado día a día contra el mes anterior.
 *
 *   node --env-file=.env.local scripts/test-ritmo.mjs
 *
 * Lo que se demuestra:
 *   · el acumulado del último día conocido ES el gasto neto del mes
 *   · los días que aún no han pasado llegan como null, no como cero
 *   · los traspasos no aparecen y los reembolsos restan
 *   · si el mes anterior es más corto, su serie se queda en su total
 *
 * Las fechas se piden a la base con ::text. El driver convierte un `date` a
 * medianoche local y toISOString() devolvería el día anterior.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: sslDb,
});

const API = process.env.NEXT_PUBLIC_SUPABASE_URL;
const S = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: S, Authorization: `Bearer ${S}`, "Content-Type": "application/json" };

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

async function main() {
  await client.connect();
  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email: `ritmo-${Date.now()}@cartera.local`, email_confirm: true }),
  });
  const uid = (await alta.json()).id;

  try {
    const [a, b] = await Promise.all([
      q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id", [uid]),
      q("insert into public.account (user_id,name,type) values ($1,'Ahorro','AHORRO') returning id", [uid]),
    ]);
    const banco = a[0].id;
    const ahorro = b[0].id;
    const cat = (
      await q(
        "insert into public.category (user_id,name,type) values ($1,'Compras','EXPENSE') returning id",
        [uid],
      )
    )[0].id;

    const hoy = (await q("select current_date::text as d"))[0].d;
    const diaDeHoy = Number(hoy.slice(8, 10));

    // Un gasto el día 1 del mes en curso, y otro hoy.
    const gasto = async (dia, cents) =>
      (
        await q(
          `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
           values ($1,'EXPENSE',$2,'Compra',(date_trunc('month', current_date) + make_interval(days => $3))::date,$4,$5,'EXPENSE','MANUAL','CONFIRMED') returning id`,
          [uid, cents, dia - 1, banco, cat],
        )
      )[0].id;

    await gasto(1, 10000);
    const elDeHoy = await gasto(diaDeHoy, 5000);

    console.log("— Acumulado —\n");

    let filas = await comoUsuario(uid, () =>
      q("select * from public.month_pace(date_trunc('month', current_date)::date)"),
    );

    const conocidos = filas.filter((f) => f.actual_cents !== null);
    const ultimo = conocidos[conocidos.length - 1];
    const resumen = await comoUsuario(uid, () =>
      q(
        "select net_expense_cents from public.v_month_summary where period_month = date_trunc('month', current_date)::date",
      ),
    );

    check(
      "El acumulado del ultimo dia es el gasto neto del mes",
      Number(ultimo.actual_cents) === Number(resumen[0].net_expense_cents),
      `acumulado ${ultimo.actual_cents} · neto ${resumen[0].net_expense_cents}`,
    );
    check("Crece, no baja", Number(ultimo.actual_cents) === 15000, `${ultimo.actual_cents}`);
    check(
      "El ultimo dia conocido es hoy",
      ultimo.dia === diaDeHoy,
      `dia ${ultimo.dia}, hoy es ${diaDeHoy}`,
    );

    console.log("\n— Los dias que faltan —\n");

    const futuros = filas.filter((f) => f.dia > diaDeHoy);
    check(
      "Los dias futuros llegan como null, no como cero",
      futuros.length === 0 || futuros.every((f) => f.actual_cents === null),
      `${futuros.filter((f) => f.actual_cents !== null).length} con valor`,
    );

    console.log("\n— Traspasos y reembolsos —\n");

    // Un traspaso no es gasto: no puede mover la curva.
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,source,status)
       values ($1,'TRANSFER',50000,'A ahorro',current_date,$2,$3,'MANUAL','CONFIRMED')`,
      [uid, banco, ahorro],
    );
    filas = await comoUsuario(uid, () =>
      q("select * from public.month_pace(date_trunc('month', current_date)::date)"),
    );
    const trasTraspaso = filas.filter((f) => f.actual_cents !== null).pop();
    check(
      "Un traspaso no toca la curva",
      Number(trasTraspaso.actual_cents) === 15000,
      `${trasTraspaso.actual_cents}, se esperaba 15000`,
    );

    // Un ingreso que reembolsa el gasto de hoy lo abarata.
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,reimburses_id,reimburses_target_type,source,status)
       values ($1,'INCOME',2000,'Devolucion',current_date,$2,$3,'EXPENSE',$4,'EXPENSE','MANUAL','CONFIRMED')`,
      [uid, banco, cat, elDeHoy],
    );
    filas = await comoUsuario(uid, () =>
      q("select * from public.month_pace(date_trunc('month', current_date)::date)"),
    );
    const trasReembolso = filas.filter((f) => f.actual_cents !== null).pop();
    check(
      "Un reembolso resta del acumulado",
      Number(trasReembolso.actual_cents) === 13000,
      `${trasReembolso.actual_cents}, se esperaba 13000`,
    );

    console.log("\n— El mes anterior mas corto —\n");

    /**
     * Comparar marzo (31 dias) con febrero (28). A partir del dia 29 no hay
     * febrero con el que comparar: su serie se queda en su total, en lugar de
     * cortarse o volver a cero.
     */
    const enFebrero = async (dia, cents) =>
      q(
        `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
         values ($1,'EXPENSE',$2,'Feb',date '2026-02-01' + make_interval(days => $3),$4,$5,'EXPENSE','MANUAL','CONFIRMED')`,
        [uid, cents, dia - 1, banco, cat],
      );
    await enFebrero(5, 3000);
    await enFebrero(28, 4000);

    const marzo = await comoUsuario(uid, () =>
      q("select * from public.month_pace(date '2026-03-01')"),
    );
    check("Marzo tiene 31 puntos", marzo.length === 31, `${marzo.length}`);

    const d28 = marzo.find((f) => f.dia === 28);
    const d29 = marzo.find((f) => f.dia === 29);
    const d31 = marzo.find((f) => f.dia === 31);
    check(
      "El dia 28 compara con todo febrero",
      Number(d28.anterior_cents) === 7000,
      `${d28.anterior_cents}, se esperaba 7000`,
    );
    check(
      "Y del 29 al 31 se queda en el total de febrero, sin cortarse",
      Number(d29.anterior_cents) === 7000 && Number(d31.anterior_cents) === 7000,
      `dia 29 ${d29.anterior_cents} · dia 31 ${d31.anterior_cents}`,
    );
    check(
      "Marzo, que ya paso, no tiene ningun dia en null",
      marzo.every((f) => f.actual_cents !== null),
      `${marzo.filter((f) => f.actual_cents === null).length} en null`,
    );

    console.log("\n— Aislamiento —\n");

    const otro = await fetch(`${API}/auth/v1/admin/users`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ email: `ritmo-otro-${Date.now()}@cartera.local`, email_confirm: true }),
    });
    const uidOtro = (await otro.json()).id;
    const delOtro = await comoUsuario(uidOtro, () =>
      q("select * from public.month_pace(date_trunc('month', current_date)::date)"),
    );
    check(
      "Otro usuario no ve ni un centimo de este",
      delOtro.every((f) => Number(f.actual_cents ?? 0) === 0 && Number(f.anterior_cents) === 0),
      "aparecen importes ajenos",
    );
    await fetch(`${API}/auth/v1/admin/users/${uidOtro}`, { method: "DELETE", headers: h });
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
