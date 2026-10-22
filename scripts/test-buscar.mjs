/**
 * Prueba search_transactions, que arregla los tres fallos de Movimientos.
 *
 *   node --env-file=.env.local scripts/test-buscar.mjs
 *
 * Lo que se demuestra:
 *   · total_count y total_net_cents son del conjunto COMPLETO, no de la página
 *   · el gasto neto respeta el reembolso y excluye el traspaso
 *   · buscar por nombre de categoría o de cuenta encuentra lo que está más allá
 *     del límite, que antes era imposible
 *   · un usuario no ve ni cuenta nada del otro
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
const buscar = (uid, args = {}) => {
  const a = {
    p_from: null,
    p_to: null,
    p_type: null,
    p_account: null,
    p_category: null,
    p_uncategorized: false,
    p_only_shortcut: false,
    p_only_pending: false,
    p_q: null,
    p_limit: 100,
    ...args,
  };
  return comoUsuario(uid, () =>
    q(
      `select * from public.search_transactions($1::date,$2::date,$3::public.entry_type,$4::uuid,$5::uuid,$6,$7,$8,$9,$10)`,
      [
        a.p_from,
        a.p_to,
        a.p_type,
        a.p_account,
        a.p_category,
        a.p_uncategorized,
        a.p_only_shortcut,
        a.p_only_pending,
        a.p_q,
        a.p_limit,
      ],
    ),
  );
};

async function main() {
  await client.connect();
  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email: `buscar-${Date.now()}@cartera.local`, email_confirm: true }),
  });
  const uid = (await alta.json()).id;

  try {
    const banco = (
      await q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id", [uid])
    )[0].id;
    const ahorro = (
      await q("insert into public.account (user_id,name,type) values ($1,'Ahorro','AHORRO') returning id", [uid])
    )[0].id;
    const cat = (
      await q(
        "insert into public.category (user_id,name,type) values ($1,'Supermercado','EXPENSE') returning id",
        [uid],
      )
    )[0].id;

    // 150 gastos de 1 €, para pasarse del límite de página con holgura.
    for (let i = 0; i < 150; i++) {
      await q(
        `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
         values ($1,'EXPENSE',100,$2,current_date - make_interval(days => $3),$4,$5,'EXPENSE','MANUAL','CONFIRMED')`,
        [uid, `Gasto ${i}`, i % 60, banco, cat],
      );
    }

    console.log("— Los totales son del conjunto, no de la pagina —\n");

    let filas = await buscar(uid, { p_limit: 100 });
    check("Devuelve solo la pagina pedida", filas.length === 100, `${filas.length}`);
    check(
      "Pero total_count cuenta las 150",
      Number(filas[0].total_count) === 150,
      `${filas[0].total_count}`,
    );
    check(
      "Y el gasto neto es el de las 150, no el de las 100",
      Number(filas[0].total_net_cents) === 15000,
      `${filas[0].total_net_cents}, se esperaba 15000`,
    );

    filas = await buscar(uid, { p_limit: 150 });
    check("Pidiendo 150 llegan las 150", filas.length === 150, `${filas.length}`);

    console.log("\n— El gasto neto respeta los invariantes —\n");

    // Un traspaso no es gasto.
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,source,status)
       values ($1,'TRANSFER',90000,'A ahorro',current_date,$2,$3,'MANUAL','CONFIRMED')`,
      [uid, banco, ahorro],
    );
    filas = await buscar(uid, { p_limit: 200 });
    check(
      "Un traspaso no suma al gasto",
      Number(filas[0].total_net_cents) === 15000,
      `${filas[0].total_net_cents}`,
    );
    check("Pero si aparece en la lista", Number(filas[0].total_count) === 151, `${filas[0].total_count}`);

    // Un ingreso que reembolsa un gasto lo abarata.
    const unGasto = filas.find((f) => f.type === "EXPENSE").id;
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,reimburses_id,reimburses_target_type,source,status)
       values ($1,'INCOME',40,'Devolucion',current_date,$2,$3,'EXPENSE',$4,'EXPENSE','MANUAL','CONFIRMED')`,
      [uid, banco, cat, unGasto],
    );
    filas = await buscar(uid, { p_limit: 200 });
    check(
      "Un reembolso resta del gasto neto",
      Number(filas[0].total_net_cents) === 14960,
      `${filas[0].total_net_cents}, se esperaba 14960`,
    );

    console.log("\n— La busqueda alcanza mas alla del limite —\n");

    /**
     * El fallo que arregla: la busqueda por nombre de categoria se hacia en
     * memoria sobre las 100 filas ya traidas, asi que un movimiento en la
     * posicion 150 no aparecia nunca aunque casara.
     */
    const porCategoria = await buscar(uid, { p_q: "supermercado", p_limit: 100 });
    // 151, no 150: el ingreso que reembolsa cuelga de la misma categoria.
    check(
      "Buscar por nombre de categoria alcanza mas alla de la pagina",
      Number(porCategoria[0].total_count) === 151 && porCategoria.length === 100,
      `${porCategoria[0].total_count} en total, ${porCategoria.length} en la pagina`,
    );
    const porCuenta = await buscar(uid, { p_q: "ahorro", p_limit: 100 });
    check(
      "Buscar por nombre de cuenta encuentra el traspaso",
      Number(porCuenta[0].total_count) === 1 && porCuenta[0].type === "TRANSFER",
      `${porCuenta[0]?.total_count} filas`,
    );
    const porDescripcion = await buscar(uid, { p_q: "Gasto 14", p_limit: 100 });
    check(
      "Y por descripcion sigue funcionando",
      Number(porDescripcion[0].total_count) === 11,
      `${porDescripcion[0].total_count}, se esperaban 11 (Gasto 14, 140-149)`,
    );
    const nada = await buscar(uid, { p_q: "zzzz", p_limit: 100 });
    check("Sin coincidencias no devuelve nada", nada.length === 0, `${nada.length}`);

    console.log("\n— Filtros —\n");

    const soloTraspasos = await buscar(uid, { p_type: "TRANSFER", p_limit: 100 });
    check(
      "Filtrar por tipo",
      soloTraspasos.length === 1 && Number(soloTraspasos[0].total_net_cents) === 0,
      `${soloTraspasos.length} filas, neto ${soloTraspasos[0]?.total_net_cents}`,
    );

    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,source,status)
       values ($1,'EXPENSE',555,'Sin clasificar',current_date,$2,'MANUAL','CONFIRMED')`,
      [uid, banco],
    );
    const sinCat = await buscar(uid, { p_uncategorized: true, p_limit: 100 });
    // Dos: el gasto sin clasificar y el traspaso, que tampoco lleva categoria.
    check(
      "Filtrar por «sin categoria» trae solo los que no la tienen",
      sinCat.length === 2 && sinCat.every((f) => f.category_id === null),
      `${sinCat.length} filas: ${sinCat.map((f) => f.description).join(", ")}`,
    );

    console.log("\n— Aislamiento —\n");

    const otro = await fetch(`${API}/auth/v1/admin/users`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ email: `buscar-otro-${Date.now()}@cartera.local`, email_confirm: true }),
    });
    const uidOtro = (await otro.json()).id;
    const ajenas = await buscar(uidOtro, { p_limit: 100 });
    check("Otro usuario no ve ninguna fila", ajenas.length === 0, `${ajenas.length}`);
    const ajenasBuscando = await buscar(uidOtro, { p_q: "supermercado", p_limit: 100 });
    check("Ni buscando por el nombre de una categoria ajena", ajenasBuscando.length === 0);
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
