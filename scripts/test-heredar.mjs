/**
 * Prueba la herencia de categoría por comercio repetido.
 *
 *   node --env-file=.env.local scripts/test-heredar.mjs
 *
 * La regla no es «copia la anterior» sino «hereda solo si TODO el historial de
 * ese comercio coincide». El caso que lo justifica salió de datos reales: en un
 * festival se pagan copas, ropa y regalos en el mismo comercio, y copiar la
 * última categoría habría metido tres cargos mal clasificados sin avisar.
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

const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

async function main() {
  await client.connect();
  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email: `her-${Date.now()}@cartera.local`, email_confirm: true }),
  });
  const uid = (await alta.json()).id;

  try {
    const cuenta = (
      await q(
        "insert into public.account (user_id,name,type) values ($1,'Visa','BANCO') returning id",
        [uid],
      )
    )[0].id;
    // El Atajo enruta por public.card: la tarjeta 4412 apunta a esta cuenta.
    await q(
      "insert into public.card (user_id,account_id,last4,type) values ($1,$2,'4412','DEBITO')",
      [uid, cuenta],
    );
    const cat = async (nombre) =>
      (
        await q(
          "insert into public.category (user_id,name,type) values ($1,$2,'EXPENSE') returning id",
          [uid, nombre],
        )
      )[0].id;

    const peajes = await cat("Gasolina y peajes");
    const copas = await cat("Copas");
    const ropa = await cat("Ropa");

    const apuntar = (comercio, cents, categoria) =>
      q(
        `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,
           category_id,category_type,source,status,merchant_raw,external_id)
         values ($1,'EXPENSE',$2,$3,current_date,$4,$5,
           case when $5::uuid is null then null else 'EXPENSE'::public.entry_type end,
           'SHORTCUT',
           case when $5::uuid is null then 'PENDING'::public.tx_status else 'CONFIRMED'::public.tx_status end,
           $3,$6)`,
        [uid, cents, comercio, cuenta, categoria, "x" + Math.random()],
      );

    const deduce = async (comercio) => {
      const r = await q(
        "select co.name from private.infer_category($1,$2) i left join public.category co on co.id = i.category_id",
        [uid, comercio],
      );
      return r.length === 0 ? null : r[0].name;
    };

    console.log("— Historial unánime: hereda —\n");

    await apuntar("Castellana De Autopist", 1570, peajes);
    check(
      "Con una sola vez clasificada ya hereda",
      (await deduce("Castellana De Autopist")) === "Gasolina y peajes",
      `${await deduce("Castellana De Autopist")}`,
    );

    await apuntar("Castellana De Autopist", 1570, peajes);
    check(
      "Y con dos iguales sigue heredando",
      (await deduce("Castellana De Autopist")) === "Gasolina y peajes",
    );

    console.log("\n— Historial dividido: NO adivina —\n");

    /**
     * El caso del festival, tal cual apareció en datos reales: mismo comercio,
     * categorías distintas cada vez porque se compran cosas distintas.
     */
    await apuntar("Riverland Festival", 1800, copas);
    check(
      "Con una sola vez, hereda",
      (await deduce("Riverland Festival")) === "Copas",
    );

    await apuntar("Riverland Festival", 4000, ropa);
    check(
      "En cuanto hay dos criterios distintos, deja de adivinar",
      (await deduce("Riverland Festival")) === null,
      `deduce «${await deduce("Riverland Festival")}» y no deberia deducir nada`,
    );

    await apuntar("Riverland Festival", 2000, copas);
    check(
      "Y ni por mayoria: dos de tres tampoco vale",
      (await deduce("Riverland Festival")) === null,
      `deduce «${await deduce("Riverland Festival")}»`,
    );

    console.log("\n— Lo que no cuenta para deducir —\n");

    check("Un comercio nunca visto no deduce nada", (await deduce("Cafeteria")) === null);

    // Un cargo sin clasificar no enseña nada.
    await apuntar("Kiosco", 200, null);
    check("Un pendiente sin categoria no deduce nada", (await deduce("Kiosco")) === null);

    // Un descartado tampoco.
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,
         category_id,category_type,source,status,merchant_raw,external_id)
       values ($1,'EXPENSE',500,'Tienda X',current_date,$2,$3,'EXPENSE','SHORTCUT','DISCARDED','Tienda X',$4)`,
      [uid, cuenta, copas, "x" + Math.random()],
    );
    check("Un descartado no enseña su categoria", (await deduce("Tienda X")) === null);

    console.log("\n— Da igual mayúsculas y espacios —\n");

    check(
      "Reconoce el mismo comercio escrito distinto",
      (await deduce("  castellana de autopist  ")) === "Gasolina y peajes",
    );

    console.log("\n— Aislamiento —\n");

    const otro = await fetch(`${API}/auth/v1/admin/users`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ email: `her-otro-${Date.now()}@cartera.local`, email_confirm: true }),
    });
    const uidOtro = (await otro.json()).id;
    const ajena = await q(
      "select count(*)::int as n from private.infer_category($1,'Castellana De Autopist')",
      [uidOtro],
    );
    check(
      "No hereda de la clasificacion de otra persona",
      ajena[0].n === 0,
      `devuelve ${ajena[0].n} filas`,
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
