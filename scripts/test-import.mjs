/**
 * Prueba la importación de extractos bancarios.
 *
 * Lo que se demuestra aquí, por orden de lo que costaría descubrirlo tarde:
 *   · la previsualización promete exactamente lo que la importación entrega
 *   · en seco no escribe ni una fila
 *   · los repetidos se detectan dentro del fichero, no solo contra la base
 *   · el signo decide el tipo y el importe se guarda en positivo
 *   · una regla de ingreso no clasifica un gasto
 *   · no se puede importar en la cuenta de otro
 *
 *   node --env-file=.env.local scripts/test-import.mjs
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

async function crearUsuario(prefijo) {
  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email: `${prefijo}-${Date.now()}@cartera.local`, email_confirm: true }),
  });
  return (await alta.json()).id;
}

const importar = (uid, cuenta, filas, opciones = {}) =>
  comoUsuario(uid, () =>
    q("select * from public.import_transactions($1,$2::jsonb,$3,$4)", [
      cuenta,
      JSON.stringify(filas),
      opciones.saltarDuplicados ?? true,
      opciones.enSeco ?? false,
    ]),
  );

const cuantos = (uid) =>
  q("select count(*)::int as n from public.transaction where user_id = $1", [uid]).then(
    (r) => r[0].n,
  );

async function main() {
  await client.connect();
  const uid = await crearUsuario("import");
  const otro = await crearUsuario("import-otro");

  try {
    const cuenta = (
      await q(
        "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,'Nomina','BANCO',100000) returning id",
        [uid],
      )
    )[0].id;
    const cuentaAjena = (
      await q(
        "insert into public.account (user_id,name,type) values ($1,'Ajena','BANCO') returning id",
        [otro],
      )
    )[0].id;

    const extracto = [
      { occurred_on: "2026-08-18", description: "MERCADONA 4021 MADRID", amount_cents: -2345 },
      { occurred_on: "2026-08-17", description: "BAR PEPE", amount_cents: -1240 },
      { occurred_on: "2026-08-01", description: "NOMINA AGOSTO", amount_cents: 185000 },
    ];

    console.log("— La previsualización no miente —\n");

    const seco = (await importar(uid, cuenta, extracto, { enSeco: true }))[0];
    check(
      "En seco anuncia las 3 que va a meter",
      seco.insertadas === 3 && seco.duplicadas === 0,
      JSON.stringify(seco),
    );
    check("Y no ha escrito nada", (await cuantos(uid)) === 0, `hay ${await cuantos(uid)}`);

    const real = (await importar(uid, cuenta, extracto))[0];
    check(
      "La importación real entrega lo prometido",
      real.insertadas === seco.insertadas &&
        real.duplicadas === seco.duplicadas &&
        real.clasificadas === seco.clasificadas &&
        real.sin_clasificar === seco.sin_clasificar,
      `seco ${JSON.stringify(seco)} · real ${JSON.stringify(real)}`,
    );
    check("Y ahora sí hay 3 movimientos", (await cuantos(uid)) === 3, `hay ${await cuantos(uid)}`);

    console.log("\n— El signo decide el tipo, el importe va en positivo —\n");

    const guardados = await q(
      "select type, amount_cents, description, source, status, merchant_raw from public.transaction where user_id = $1 order by occurred_on",
      [uid],
    );
    check(
      "El negativo del extracto es un gasto",
      guardados[1].type === "EXPENSE" && Number(guardados[1].amount_cents) === 1240,
      `${guardados[1].type} ${guardados[1].amount_cents}`,
    );
    check(
      "El positivo es un ingreso",
      guardados[0].type === "INCOME" && Number(guardados[0].amount_cents) === 185000,
      `${guardados[0].type} ${guardados[0].amount_cents}`,
    );
    check(
      "Ningun importe se guarda en negativo",
      guardados.every((g) => Number(g.amount_cents) > 0),
      guardados.map((g) => g.amount_cents).join(", "),
    );
    check(
      "Queda constancia de que vino de un extracto",
      guardados.every((g) => g.source === "IMPORT" && g.status === "CONFIRMED"),
      guardados.map((g) => `${g.source}/${g.status}`).join(", "),
    );
    check(
      "El concepto queda tambien como texto de comercio, para las reglas",
      guardados.every((g) => g.merchant_raw === g.description),
      "merchant_raw no coincide con description",
    );

    console.log("\n— Duplicados —\n");

    const repetido = (await importar(uid, cuenta, extracto))[0];
    check(
      "Reimportar el mismo extracto no duplica nada",
      repetido.insertadas === 0 && repetido.duplicadas === 3,
      JSON.stringify(repetido),
    );
    check("Siguen siendo 3", (await cuantos(uid)) === 3, `hay ${await cuantos(uid)}`);

    /**
     * El caso que delata una previsualización mal hecha: dos filas idénticas
     * DENTRO del fichero. En seco no hay nada insertado con lo que choque la
     * segunda, así que una implementación ingenua anunciaría 2 y metería 1.
     */
    const conRepeEnFichero = [
      { occurred_on: "2026-07-15", description: "GASOLINERA", amount_cents: -5000 },
      { occurred_on: "2026-07-15", description: "GASOLINERA", amount_cents: -5000 },
    ];
    const secoRepe = (await importar(uid, cuenta, conRepeEnFichero, { enSeco: true }))[0];
    const realRepe = (await importar(uid, cuenta, conRepeEnFichero))[0];
    check(
      "Detecta el repetido dentro del propio fichero",
      secoRepe.insertadas === 1 && secoRepe.duplicadas === 1,
      JSON.stringify(secoRepe),
    );
    check(
      "Y en seco anuncia lo mismo que entrega",
      secoRepe.insertadas === realRepe.insertadas && secoRepe.duplicadas === realRepe.duplicadas,
      `seco ${JSON.stringify(secoRepe)} · real ${JSON.stringify(realRepe)}`,
    );

    const gasolineras = await q(
      "select count(*)::int as n from public.transaction where user_id=$1 and description='GASOLINERA'",
      [uid],
    );
    check("Solo se guardo una gasolinera", gasolineras[0].n === 1, `${gasolineras[0].n}`);

    // Quien de verdad tomo dos cafes iguales el mismo dia puede pedir que entren.
    const forzado = (
      await importar(uid, cuenta, conRepeEnFichero, { saltarDuplicados: false })
    )[0];
    check(
      "Se puede pedir que los duplicados entren igual",
      forzado.insertadas === 2,
      JSON.stringify(forzado),
    );

    console.log("\n— Reglas de comercio —\n");

    const catGasto = (
      await q(
        "insert into public.category (user_id,name,type,color,icon) values ($1,'Supermercado','EXPENSE','#2f8f4e','shopping-cart') returning id",
        [uid],
      )
    )[0].id;
    const catIngreso = (
      await q(
        "insert into public.category (user_id,name,type,color,icon) values ($1,'Nomina','INCOME','#0e7352','banknote') returning id",
        [uid],
      )
    )[0].id;
    await q(
      "insert into public.merchant_rule (user_id,match_text,category_id,category_type) values ($1,'MERCADONA',$2,'EXPENSE')",
      [uid, catGasto],
    );
    await q(
      "insert into public.merchant_rule (user_id,match_text,category_id,category_type) values ($1,'NOMINA',$2,'INCOME')",
      [uid, catIngreso],
    );

    const nuevo = [
      { occurred_on: "2026-06-10", description: "MERCADONA 5511 SEVILLA", amount_cents: -3000 },
      { occurred_on: "2026-06-05", description: "NOMINA JUNIO", amount_cents: 190000 },
      { occurred_on: "2026-06-03", description: "COMERCIO DESCONOCIDO", amount_cents: -1000 },
      // Un gasto cuyo concepto menciona NOMINA: la regla que casa apunta a una
      // categoria de INGRESO, asi que no debe aplicarse.
      { occurred_on: "2026-06-02", description: "DEVOLUCION NOMINA ERRONEA", amount_cents: -500 },
    ];
    const conReglas = (await importar(uid, cuenta, nuevo))[0];
    check(
      "Clasifica lo que casa y deja el resto sin clasificar",
      conReglas.clasificadas === 2 && conReglas.sin_clasificar === 2,
      JSON.stringify(conReglas),
    );

    const malPuesta = await q(
      "select category_id, category_type from public.transaction where user_id=$1 and description='DEVOLUCION NOMINA ERRONEA'",
      [uid],
    );
    check(
      "Una regla de ingreso NO clasifica un gasto",
      malPuesta[0].category_id === null && malPuesta[0].category_type === null,
      `quedo con ${malPuesta[0].category_id} / ${malPuesta[0].category_type}`,
    );

    const bienPuesta = await q(
      "select category_id, category_type, type from public.transaction where user_id=$1 and description like 'MERCADONA 5511%'",
      [uid],
    );
    check(
      "Y la del mismo signo si, con el tipo en espejo",
      bienPuesta[0].category_id === catGasto && bienPuesta[0].category_type === "EXPENSE",
      JSON.stringify(bienPuesta[0]),
    );

    console.log("\n— Aislamiento —\n");

    let rechazada = false;
    try {
      await importar(uid, cuentaAjena, extracto);
    } catch {
      rechazada = true;
    }
    check("No se puede importar en la cuenta de otro", rechazada);

    const delOtro = await cuantos(otro);
    check("Y al otro no le ha entrado nada", delOtro === 0, `tiene ${delOtro}`);

    console.log("\n— Saldo derivado —\n");

    // Lo importado tiene que moverse el saldo como cualquier otro movimiento.
    const saldo = await comoUsuario(uid, () =>
      q("select balance_cents from public.v_account_balance where account_id = $1", [cuenta]),
    );
    const suma = await q(
      "select coalesce(sum(case when type='INCOME' then amount_cents else -amount_cents end),0)::bigint as neto from public.transaction where user_id=$1 and account_id=$2 and status<>'DISCARDED'",
      [uid, cuenta],
    );
    check(
      "El saldo sale de los movimientos importados, no de una columna",
      Number(saldo[0].balance_cents) === 100000 + Number(suma[0].neto),
      `saldo ${saldo[0].balance_cents} · inicial 100000 + neto ${suma[0].neto}`,
    );
  } finally {
    for (const id of [uid, otro]) {
      await fetch(`${API}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: h });
    }
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
