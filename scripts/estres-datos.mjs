/**
 * Datos de ESTRÉS para la prueba visual: nombres al límite, importes enormes y
 * negativos, y más de 500 movimientos en un mes. Solo para el usuario de pruebas.
 *
 *   node --env-file=.env.local scripts/estres-datos.mjs crear   <email@cartera.local> [n=520]
 *   node --env-file=.env.local scripts/estres-datos.mjs limpiar <email@cartera.local>
 *   node --env-file=.env.local scripts/estres-datos.mjs contar   <email@cartera.local>
 *
 * Todo lo que crea lleva el prefijo «ESTRES» en el nombre y cuelga de dos cuentas
 * propias, así que `limpiar` lo encuentra y lo borra entero sin tocar nada más
 * (ni los datos sembrados por `seed-demo.mjs`). `crear` limpia antes, para que
 * se pueda repetir.
 *
 * Lo que siembra:
 *   · Cuenta A (60 caracteres, el máximo) con saldo inicial 9.999.999,99 €.
 *   · Cuenta B (60 caracteres) con saldo inicial −9.999.999,99 €.
 *   · Una categoría de gasto con nombre de 40 caracteres (el máximo).
 *   · N gastos en el mes en curso (por defecto 520), con descripciones cortas,
 *     largas (≈ 110 caracteres) y una palabra sin espacios de 48 letras, más un
 *     gasto y un ingreso de 9.999.999,99 €.
 *   · Una meta de 9.999.999,99 € con nombre de 60 caracteres sobre la cuenta A.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const [modo, email, nArg] = process.argv.slice(2);
if (!["crear", "limpiar", "contar"].includes(modo) || !email) {
  console.error("Uso: estres-datos.mjs crear|limpiar|contar <email@cartera.local> [n]");
  process.exit(2);
}
if (!email.endsWith("@cartera.local")) {
  console.error(`Me niego a tocar «${email}»: solo usuarios de prueba @cartera.local.`);
  process.exit(2);
}
const N = Number(nArg ?? 520);

const NOMBRE_A = "ESTRES · Cuenta corriente compartida de la familia Martínez";
const NOMBRE_B = "ESTRES · Tarjeta de crédito con un nombre larguísimo de prue";
const NOMBRE_CAT = "ESTRES · Categoría con nombre larguísimo"; // 40, el máximo
const NOMBRE_META = "ESTRES · Meta para la casa de la playa con jardín y piscina!";
const MAX = 999_999_999; // 9.999.999,99 €

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
await c.connect();
const q = (s, p) => c.query(s, p).then((r) => r.rows);

try {
  const [usuario] = await q("select id from auth.users where email = $1", [email]);
  if (!usuario) throw new Error(`No existe ${email}`);
  const uid = usuario.id;

  async function limpiar() {
    const cuentas = (await q("select id from public.account where user_id = $1 and name like 'ESTRES%'", [uid])).map(
      (r) => r.id,
    );
    let borrados = 0;
    if (cuentas.length) {
      await q("delete from public.savings_goal where user_id = $1 and account_id = any($2)", [uid, cuentas]);
      // Por tandas: si otra sesión tiene filas del usuario bloqueadas (un e2e en
      // marcha), un único DELETE de 500 filas acaba en `statement_timeout`; en
      // tandas, cada una espera poco y el resto va en milisegundos.
      for (;;) {
        const t0 = Date.now();
        const n = (
          await c.query(
            `delete from public.transaction where id in (
               select id from public.transaction
                where user_id = $1 and (account_id = any($2) or to_account_id = any($2)) limit 50)`,
            [uid, cuentas],
          )
        ).rowCount;
        if (process.env.ESTRES_DEBUG) console.log(`tanda de ${n} en ${Date.now() - t0} ms`);
        borrados += n;
        if (n === 0) break;
      }
      await q("delete from public.account where user_id = $1 and id = any($2)", [uid, cuentas]);
    }
    await q("delete from public.category where user_id = $1 and name like 'ESTRES%'", [uid]);
    return { cuentas: cuentas.length, movimientos: borrados };
  }

  if (modo === "contar") {
    const [r] = await q(
      "select count(*)::int as n from public.transaction t join public.account a on a.id = t.account_id and a.user_id = t.user_id where t.user_id = $1 and a.name like 'ESTRES%'",
      [uid],
    );
    console.log(`Hay ${r.n} movimientos de estrés.`);
    process.exit(0);
  }

  const antes = await limpiar();
  if (modo === "limpiar") {
    console.log(`Limpio: ${antes.cuentas} cuentas y ${antes.movimientos} movimientos de estrés borrados.`);
  } else {
    const [a] = await q(
      "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,$2,'BANCO',$3) returning id",
      [uid, NOMBRE_A, MAX],
    );
    const [b] = await q(
      "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,$2,'BANCO',$3) returning id",
      [uid, NOMBRE_B, -MAX],
    );
    const [cat] = await q(
      "insert into public.category (user_id,name,type,color,icon) values ($1,$2,'EXPENSE','#6d4bc4','film') returning id",
      [uid, NOMBRE_CAT],
    );

    const largo =
      "Compra en el hipermercado de las afueras con el carro lleno hasta arriba y la tarjeta temblando de miedo";
    const palabra = "Supercalifragilisticoespialidosoextraordinarioss";
    const valores = [];
    const params = [uid, a.id, cat.id];
    for (let i = 0; i < N; i++) {
      const desc = i % 3 === 0 ? `${largo} #${i}` : i % 3 === 1 ? `${palabra}${i}` : `Café ${i}`;
      const importe = 1 + ((i * 7919) % 25_000);
      params.push(desc, importe, i);
      const k = params.length;
      valores.push(
        `($1,'EXPENSE',$${k - 1},$${k - 2},(date_trunc('month', current_date)::date + ($${k}::int % extract(day from current_date)::int)),$2,$3,'EXPENSE')`,
      );
    }
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type) values ${valores.join(",")}`,
      params,
    );
    await q(
      "insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type) values ($1,'EXPENSE',$2,$3,current_date,$4,$5,'EXPENSE')",
      [uid, MAX, `ESTRES gasto máximo ${largo}`, b.id, cat.id],
    );
    await q(
      "insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id) values ($1,'INCOME',$2,$3,current_date,$4)",
      [uid, MAX, "ESTRES ingreso máximo", a.id],
    );
    await q("insert into public.savings_goal (user_id,name,target_cents,account_id) values ($1,$2,$3,$4)", [
      uid,
      NOMBRE_META,
      MAX,
      a.id,
    ]);
    console.log(`Creado: 2 cuentas, 1 categoría, 1 meta y ${N + 2} movimientos de estrés.`);
  }
} finally {
  await c.end();
}
