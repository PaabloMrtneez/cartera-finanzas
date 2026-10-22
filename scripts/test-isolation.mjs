/**
 * Prueba de aislamiento entre usuarios e invariantes financieros.
 *
 * Crea dos usuarios de verdad, intenta atacar el aislamiento desde uno contra
 * el otro, y comprueba que la base de datos rechaza cada intento por sí sola,
 * sin depender de que el código de la app haga nada bien.
 *
 * Al terminar borra los dos usuarios y todo lo suyo.
 *
 *   node scripts/test-isolation.mjs
 *
 * Necesita DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const DB = process.env.DATABASE_URL;
const API = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!DB || !API || !SECRET) {
  console.error("Faltan DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const client = new pg.Client({ connectionString: DB, ssl: sslDb });

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  OK    ${name}`);
}

function ko(name, detail) {
  failed++;
  console.log(`  FALLO ${name}`);
  console.log(`        ${detail}`);
}

// --- gestión de usuarios de prueba -----------------------------------------

async function createUser(email) {
  const response = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password: crypto.randomUUID(), email_confirm: true }),
  });
  if (!response.ok) throw new Error(`Alta de ${email}: ${response.status} ${await response.text()}`);
  return (await response.json()).id;
}

async function deleteUser(id) {
  await fetch(`${API}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
  });
}

/**
 * Ejecuta consultas haciéndose pasar por un usuario, exactamente como llegarían
 * desde el navegador: rol `authenticated` y las reclamaciones del JWT que lee
 * auth.uid(). Todo dentro de una transacción que siempre se deshace.
 */
async function asUser(userId, aal, work) {
  await client.query("begin");
  try {
    const claims = JSON.stringify({ sub: userId, role: "authenticated", aal });
    await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await client.query("set local role authenticated");
    return await work();
  } finally {
    await client.query("rollback");
  }
}

/** Espera que la operación falle con un código SQLSTATE concreto. */
async function expectFail(name, code, work) {
  try {
    await work();
    ko(name, `Se esperaba el error ${code}, pero la operación fue ACEPTADA.`);
  } catch (error) {
    if (error.code === code) ok(name);
    else ko(name, `Se esperaba ${code} y llegó ${error.code}: ${error.message}`);
  }
}

// --- la prueba --------------------------------------------------------------

async function main() {
  await client.connect();

  const stamp = Date.now();
  const emailA = `cartera-test-a-${stamp}@example.com`;
  const emailB = `cartera-test-b-${stamp}@example.com`;
  let userA, userB;

  try {
    userA = await createUser(emailA);
    userB = await createUser(emailB);
    console.log(`Usuarios de prueba creados.\n`);

    // El disparador de alta debe haber creado el perfil de cada uno.
    const profiles = await client.query(
      "select count(*)::int as n from public.profile where user_id = any($1)",
      [[userA, userB]],
    );
    if (profiles.rows[0].n === 2) ok("El alta de usuario crea su perfil");
    else ko("El alta de usuario crea su perfil", `Se esperaban 2 perfiles y hay ${profiles.rows[0].n}`);

    // Datos de partida de A, insertados con privilegios de administración para
    // no depender todavía de las políticas.
    const accountA = (
      await client.query(
        `insert into public.account (user_id, name, type) values ($1,'Cuenta A','BANCO') returning id`,
        [userA],
      )
    ).rows[0].id;
    const catA = (
      await client.query(
        `insert into public.category (user_id, name, type) values ($1,'Comida A','EXPENSE') returning id`,
        [userA],
      )
    ).rows[0].id;
    const catIncomeA = (
      await client.query(
        `insert into public.category (user_id, name, type) values ($1,'Nómina A','INCOME') returning id`,
        [userA],
      )
    ).rows[0].id;
    const accountB = (
      await client.query(
        `insert into public.account (user_id, name, type) values ($1,'Cuenta B','BANCO') returning id`,
        [userB],
      )
    ).rows[0].id;

    console.log("\n— Aislamiento entre usuarios —");

    // 1. B no ve absolutamente nada de A.
    await asUser(userB, "aal2", async () => {
      const seen = await client.query(
        `select
           (select count(*)::int from public.account  where user_id = $1) as cuentas,
           (select count(*)::int from public.category where user_id = $1) as categorias`,
        [userA],
      );
      const { cuentas, categorias } = seen.rows[0];
      if (cuentas === 0 && categorias === 0) ok("Un usuario no ve las filas de otro");
      else ko("Un usuario no ve las filas de otro", `Ve ${cuentas} cuentas y ${categorias} categorías ajenas`);
    });

    // 2. El ataque de verdad: B inserta un movimiento SUYO que apunta a una
    //    categoría de A. La política pasa (el user_id es el de B) y la
    //    categoría existe: solo la clave foránea compuesta lo detiene.
    await asUser(userB, "aal2", async () => {
      await expectFail(
        "Referenciar una categoría de otro usuario se rechaza",
        "23503",
        () =>
          client.query(
            `insert into public.transaction
               (user_id, type, amount_cents, occurred_on, account_id, category_id, category_type)
             values ($1,'EXPENSE',1000,current_date,$2,$3,'EXPENSE')`,
            [userB, accountB, catA],
          ),
      );
    });

    // 3. Lo mismo con una cuenta ajena.
    await asUser(userB, "aal2", async () => {
      await expectFail(
        "Referenciar una cuenta de otro usuario se rechaza",
        "23503",
        () =>
          client.query(
            `insert into public.transaction (user_id, type, amount_cents, occurred_on, account_id)
             values ($1,'EXPENSE',1000,current_date,$2)`,
            [userB, accountA],
          ),
      );
    });

    // 4. Escribir directamente una fila a nombre de otro.
    await asUser(userB, "aal2", async () => {
      await expectFail(
        "Insertar una fila a nombre de otro usuario se rechaza",
        "42501",
        () =>
          client.query(
            `insert into public.category (user_id, name, type) values ($1,'Intrusa','EXPENSE')`,
            [userA],
          ),
      );
    });

    console.log("\n— Segundo factor —");

    // 5. Sin superar el 2FA la sesión no ve NADA, ni siquiera lo propio.
    // Desde 20261019090000_segundo_factor_opcional el segundo factor solo se
    // exige a quien tiene uno verificado: se le da uno a B (con la regla
    // anterior, aal1 no veía nada tuviera o no factor; la prueba vale para las dos).
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'prueba-aislamiento', 'totp', 'verified', now(), now())`,
      [userB],
    );
    await asUser(userB, "aal1", async () => {
      const seen = await client.query(`select count(*)::int as n from public.account`);
      if (seen.rows[0].n === 0) ok("Sin segundo factor no se ve ni la propia cuenta");
      else ko("Sin segundo factor no se ve ni la propia cuenta", `Ve ${seen.rows[0].n} filas`);
    });

    // 6. Y tampoco puede escribir.
    await asUser(userB, "aal1", async () => {
      await expectFail(
        "Sin segundo factor tampoco se puede escribir",
        "42501",
        () =>
          client.query(
            `insert into public.category (user_id, name, type) values ($1,'Sin 2FA','EXPENSE')`,
            [userB],
          ),
      );
    });

    console.log("\n— Invariantes financieros —");

    const expenseA = (
      await client.query(
        `insert into public.transaction
           (user_id, type, amount_cents, occurred_on, account_id, category_id, category_type)
         values ($1,'EXPENSE',12000,current_date,$2,$3,'EXPENSE') returning id`,
        [userA, accountA, catA],
      )
    ).rows[0].id;

    await expectFail("Un gasto no puede reembolsar nada", "23514", () =>
      client.query(
        `insert into public.transaction
           (user_id, type, amount_cents, occurred_on, account_id, reimburses_id, reimburses_target_type)
         values ($1,'EXPENSE',8000,current_date,$2,$3,'EXPENSE')`,
        [userA, accountA, expenseA],
      ),
    );

    await expectFail("Un ingreso no puede reembolsar otro ingreso", "23503", async () => {
      const incomeA = (
        await client.query(
          `insert into public.transaction (user_id, type, amount_cents, occurred_on, account_id)
           values ($1,'INCOME',5000,current_date,$2) returning id`,
          [userA, accountA],
        )
      ).rows[0].id;
      return client.query(
        `insert into public.transaction
           (user_id, type, amount_cents, occurred_on, account_id, reimburses_id, reimburses_target_type)
         values ($1,'INCOME',5000,current_date,$2,$3,'EXPENSE')`,
        [userA, accountA, incomeA],
      );
    });

    await expectFail("Un traspaso sin destino se rechaza", "23514", () =>
      client.query(
        `insert into public.transaction (user_id, type, amount_cents, occurred_on, account_id)
         values ($1,'TRANSFER',5000,current_date,$2)`,
        [userA, accountA],
      ),
    );

    await expectFail("Un traspaso a la misma cuenta se rechaza", "23514", () =>
      client.query(
        `insert into public.transaction
           (user_id, type, amount_cents, occurred_on, account_id, to_account_id)
         values ($1,'TRANSFER',5000,current_date,$2,$2)`,
        [userA, accountA],
      ),
    );

    await expectFail("Un gasto no puede colgar de una categoría de ingreso", "23503", () =>
      client.query(
        `insert into public.transaction
           (user_id, type, amount_cents, occurred_on, account_id, category_id, category_type)
         values ($1,'EXPENSE',1000,current_date,$2,$3,'EXPENSE')`,
        [userA, accountA, catIncomeA],
      ),
    );

    await expectFail("Un importe negativo se rechaza", "23514", () =>
      client.query(
        `insert into public.transaction (user_id, type, amount_cents, occurred_on, account_id)
         values ($1,'EXPENSE',-1000,current_date,$2)`,
        [userA, accountA],
      ),
    );

    await expectFail("El tipo de una categoría no se puede cambiar", "23514", () =>
      client.query(`update public.category set type = 'INCOME' where id = $1`, [catA]),
    );

    console.log("\n— Motor de reglas de comercio —");

    await client.query(
      `insert into public.merchant_rule (user_id, match_text, category_id, category_type)
       values ($1,'CARREFOUR',$2,'EXPENSE'), ($1,'CARREFOUR EXPRESS',$2,'EXPENSE')`,
      [userA, catA],
    );

    const winner = await client.query(
      `select r.match_text from private.match_rule($1, $2) m
       join public.merchant_rule r on r.id = m.rule_id`,
      [userA, "COMPRA EN CARREFOUR EXPRESS MADRID"],
    );
    if (winner.rows[0]?.match_text === "CARREFOUR EXPRESS") {
      ok("Entre dos reglas que casan gana la más específica");
    } else {
      ko("Entre dos reglas que casan gana la más específica", `Ganó ${winner.rows[0]?.match_text}`);
    }

    // Regresión del fallo del LIKE: con comodines, «50%» habría casado con
    // cualquier comercio que empiece por «50».
    await client.query(
      `insert into public.merchant_rule (user_id, match_text, category_id, category_type)
       values ($1,'50%',$2,'EXPENSE')`,
      [userA, catA],
    );
    const wildcard = await client.query(`select * from private.match_rule($1, $2)`, [
      userA,
      "MERCADONA 5012 MADRID",
    ]);
    if (wildcard.rows.length === 0) ok("Los comodines de una regla no actúan como tales");
    else ko("Los comodines de una regla no actúan como tales", "La regla «50%» casó con «MERCADONA 5012»");

    console.log("\n— Cálculo derivado —");

    const balance = await client.query(
      `select balance_cents from public.v_account_balance where account_id = $1`,
      [accountA],
    );
    // Cuenta a 0 + un gasto de 120,00 € + un ingreso de 50,00 € = -70,00 €
    if (balance.rows[0].balance_cents === "-7000") {
      ok("El saldo se deriva de los movimientos");
    } else {
      ko("El saldo se deriva de los movimientos", `Esperado -7000, obtenido ${balance.rows[0].balance_cents}`);
    }
  } finally {
    if (userA) await deleteUser(userA);
    if (userB) await deleteUser(userB);
    await client.end();
  }

  console.log(`\n${passed} correctas · ${failed} fallidas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await client.end().catch(() => {});
  process.exit(2);
});
