/**
 * Prueba la generación de cargos de suscripción.
 *
 * Lo que de verdad importa: que pulsar «Generar» dos veces no cobre dos veces, y
 * que una suscripción olvidada durante meses recupere TODOS los cargos
 * atrasados, no solo el último.
 *
 *   node --env-file=.env.local scripts/test-subscriptions.mjs
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: sslDb,
});

const API = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cabeceras = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

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

/** Ejecuta como el usuario, igual que llegaría desde el navegador. */
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

  const email = `subs-${Date.now()}@cartera.local`;
  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: cabeceras,
    body: JSON.stringify({ email, email_confirm: true }),
  });
  const usuario = await alta.json();
  const uid = usuario.id;

  try {
    const cuenta = (
      await client.query(
        "insert into public.account (user_id, name, type) values ($1,'Visa','BANCO') returning id",
        [uid],
      )
    ).rows[0].id;

    const categoria = (
      await client.query(
        "insert into public.category (user_id, name, type) values ($1,'Suscripciones','EXPENSE') returning id",
        [uid],
      )
    ).rows[0].id;

    console.log("— Generación de cargos —\n");

    // Mensual con el próximo cargo hace 3 meses: deben salir 3 (o 4) atrasados.
    await client.query(
      `insert into public.subscription
         (user_id, description, amount_cents, periodicity, next_charge_date,
          account_id, category_id, category_type, started_at)
       values ($1,'Netflix',1399,'MENSUAL', current_date - interval '3 months',
               $2,$3,'EXPENSE', current_date - interval '1 year')`,
      [uid, cuenta, categoria],
    );

    // Pausada: no debe generar nada.
    await client.query(
      `insert into public.subscription
         (user_id, description, amount_cents, periodicity, next_charge_date,
          account_id, started_at, active)
       values ($1,'Gimnasio',3490,'MENSUAL', current_date - interval '2 months',
               $2, current_date - interval '1 year', false)`,
      [uid, cuenta],
    );

    const primera = await comoUsuario(uid, async () => {
      const r = await client.query("select public.generate_subscription_charges() as n");
      return r.rows[0].n;
    });

    check(
      "Recupera todos los cargos atrasados, no solo el último",
      primera >= 3,
      `Creó ${primera}; se esperaban al menos 3 (tres meses de retraso).`,
    );

    const segunda = await comoUsuario(uid, async () => {
      const r = await client.query("select public.generate_subscription_charges() as n");
      return r.rows[0].n;
    });

    check("Pulsar otra vez no crea nada", segunda === 0, `Creó ${segunda} la segunda vez.`);

    const total = await client.query(
      "select count(*)::int as n from public.transaction where user_id = $1 and source = 'RECURRING'",
      [uid],
    );
    check(
      "No hay cargos duplicados",
      total.rows[0].n === primera,
      `${total.rows[0].n} movimientos frente a ${primera} creados.`,
    );

    const pausada = await client.query(
      `select count(*)::int as n from public.transaction t
       join public.subscription s on s.id = t.subscription_id
       where t.user_id = $1 and s.description = 'Gimnasio'`,
      [uid],
    );
    check("Una suscripción en pausa no genera nada", pausada.rows[0].n === 0);

    const avanzada = await client.query(
      "select next_charge_date > current_date as futuro from public.subscription where user_id = $1 and description = 'Netflix'",
      [uid],
    );
    check("La fecha del próximo cargo queda en el futuro", avanzada.rows[0].futuro === true);

    console.log("\n— Compromiso mensual —\n");

    const resumen = await comoUsuario(uid, async () => {
      const r = await client.query(
        "select description, monthly_cents, yearly_cents from public.v_subscription_summary where active order by description",
      );
      return r.rows;
    });

    const netflix = resumen.find((r) => r.description === "Netflix");
    check(
      "Anualiza bien una mensual",
      Number(netflix?.yearly_cents) === 1399 * 12,
      `${netflix?.yearly_cents} frente a ${1399 * 12}`,
    );
    check(
      "La pausada no aparece en el compromiso",
      resumen.every((r) => r.description !== "Gimnasio"),
    );

    // Una anual debe normalizarse a mes, no contarse entera.
    await client.query(
      `insert into public.subscription
         (user_id, description, amount_cents, periodicity, next_charge_date, account_id, started_at)
       values ($1,'Dominio',1200,'ANUAL', current_date + interval '6 months', $2, current_date)`,
      [uid, cuenta],
    );

    const anual = await comoUsuario(uid, async () => {
      const r = await client.query(
        "select monthly_cents, yearly_cents from public.v_subscription_summary where description = 'Dominio'",
      );
      return r.rows[0];
    });

    check(
      "Una anual se normaliza a mes",
      Number(anual.monthly_cents) === 100 && Number(anual.yearly_cents) === 1200,
      `mensual ${anual.monthly_cents}, anual ${anual.yearly_cents}`,
    );

    console.log("\n— Próximos cargos —\n");

    const proximos = await comoUsuario(uid, async () => {
      const r = await client.query("select * from public.upcoming_charges(60)");
      return r.rows;
    });

    check(
      "Lista los cargos de los próximos 60 días",
      proximos.length > 0,
      `Devolvió ${proximos.length}.`,
    );
    check(
      "No incluye la suscripción en pausa",
      proximos.every((c) => c.description !== "Gimnasio"),
    );
    check(
      "No incluye la anual, que cae fuera de los 60 días",
      proximos.every((c) => c.description !== "Dominio"),
    );
    console.log("\n— Gasto que se repite, en un solo paso —\n");

    // Una categoría de ingreso, para probar que se rechaza.
    const catIngreso = (
      await client.query(
        "insert into public.category (user_id, name, type) values ($1,'Nomina','INCOME') returning id",
        [uid],
      )
    ).rows[0].id;

    const antesDeTodo = (
      await client.query("select count(*)::int as n from public.transaction where user_id=$1", [uid])
    ).rows[0].n;

    const creado = await comoUsuario(uid, async () => {
      // `next_charge_date::text`: sin el cast, el controlador lo convierte a
      // medianoche local y toISOString() devuelve el dia anterior.
      const r = await client.query(
        "select transaction_id, subscription_id, next_charge_date::text as next_charge_date from public.create_expense_with_subscription($1,$2,$3::date,$4,$5,$6::public.periodicity)",
        [1299, "Netflix", "2026-01-31", cuenta, categoria, "MENSUAL"],
      );
      return r.rows[0];
    });

    check(
      "Crea el gasto y la suscripcion de una vez",
      !!creado.transaction_id && !!creado.subscription_id,
      JSON.stringify(creado),
    );

    /**
     * El 31 de enero mas un mes es el 28 de febrero, no el 3 de marzo: PostgreSQL
     * recorta. Es la misma cuenta que hace la pantalla para prometer la fecha.
     */
    check(
      "La siguiente fecha recorta al ultimo dia del mes",
      creado.next_charge_date === "2026-02-28",
      `${creado.next_charge_date}, se esperaba 2026-02-28`,
    );

    const gasto = (
      await client.query(
        "select type, amount_cents, source, status, subscription_id, category_type, occurred_on::text as fecha from public.transaction where id=$1",
        [creado.transaction_id],
      )
    ).rows[0];

    check(
      "El gasto es un EXPENSE con el importe en positivo",
      gasto.type === "EXPENSE" && Number(gasto.amount_cents) === 1299,
      `${gasto.type} ${gasto.amount_cents}`,
    );
    check(
      "Queda enlazado a su suscripcion",
      gasto.subscription_id === creado.subscription_id,
      `${gasto.subscription_id}`,
    );
    check(
      "El origen dice MANUAL, porque lo escribiste tu",
      gasto.source === "MANUAL" && gasto.status === "CONFIRMED",
      `${gasto.source}/${gasto.status}`,
    );
    check(
      "Hereda el tipo de la categoria en espejo",
      gasto.category_type === "EXPENSE",
      `${gasto.category_type}`,
    );

    /**
     * La prueba que justifica el enlace: el generador recorre las suscripciones
     * vencidas y NO puede volver a crear el cargo que ya apuntaste.
     */
    const generados = await comoUsuario(uid, async () => {
      const r = await client.query("select public.generate_subscription_charges() as n");
      return r.rows[0].n;
    });
    const netflixEse31 = (
      await client.query(
        "select count(*)::int as n from public.transaction where user_id=$1 and subscription_id=$2 and occurred_on=date '2026-01-31'",
        [uid, creado.subscription_id],
      )
    ).rows[0].n;
    check(
      "El generador no duplica el cargo que ya apuntaste",
      netflixEse31 === 1,
      `hay ${netflixEse31} cargos ese dia (genero ${generados} en total)`,
    );

    console.log("\n— Atomicidad —\n");

    /**
     * Si falla la suscripcion, el gasto NO puede quedarse. Un gasto suelto mas
     * alguien esperando un cargo que no va a llegar es peor que un error.
     */
    const antes = (
      await client.query("select count(*)::int as n from public.transaction where user_id=$1", [uid])
    ).rows[0].n;

    let rechazado = false;
    try {
      await comoUsuario(uid, () =>
        client.query(
          "select * from public.create_expense_with_subscription($1,$2,$3::date,$4,$5,$6::public.periodicity)",
          [500, "Con categoria de ingreso", "2026-03-10", cuenta, catIngreso, "MENSUAL"],
        ),
      );
    } catch {
      rechazado = true;
    }
    const despues = (
      await client.query("select count(*)::int as n from public.transaction where user_id=$1", [uid])
    ).rows[0].n;

    check("Rechaza colgar una suscripcion de una categoria de ingreso", rechazado);
    check(
      "Y no deja ningun gasto huerfano detras",
      despues === antes,
      `habia ${antes}, hay ${despues}`,
    );

    const subsHuerfanas = (
      await client.query(
        "select count(*)::int as n from public.subscription where user_id=$1 and description='Con categoria de ingreso'",
        [uid],
      )
    ).rows[0].n;
    check("Ni ninguna suscripcion a medias", subsHuerfanas === 0, `${subsHuerfanas}`);
    check(
      "El recuento total cuadra con lo que se ha creado a proposito",
      despues > antesDeTodo,
      `${antesDeTodo} antes, ${despues} ahora`,
    );

  } finally {
    await fetch(`${API}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: cabeceras });
    await client.end();
  }

  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await client.end().catch(() => {});
  process.exit(2);
});
