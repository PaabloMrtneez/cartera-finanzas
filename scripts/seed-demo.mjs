/**
 * Siembra datos realistas para revisar a ojo Patrimonio e Inversiones.
 *
 *   node --env-file=.env.local scripts/seed-demo.mjs <email>
 *
 * Borra lo que hubiera antes y vuelve a sembrar, para que se pueda repetir.
 *
 * Ese borrado es la razón de la salvaguarda de abajo: el script SOLO acepta
 * usuarios @cartera.local. Con datos financieros reales de por medio, un script
 * de desarrollo que borra cuentas no puede depender de que quien lo lanza
 * escriba bien el correo.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const email = process.argv[2];
if (!email) {
  console.error("Falta el correo: node --env-file=.env.local scripts/seed-demo.mjs <email>");
  process.exit(1);
}
if (!email.endsWith("@cartera.local")) {
  console.error(`Me niego a sembrar en «${email}»: borra datos y solo acepto usuarios de prueba @cartera.local.`);
  process.exit(1);
}

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: sslDb,
});
await c.connect();
const q = (s, p) => c.query(s, p).then((r) => r.rows);

const encontrado = await q("select id from auth.users where email = $1", [email]);
if (encontrado.length === 0) {
  console.error(`No existe ningún usuario con el correo ${email}.`);
  process.exit(1);
}
const uid = encontrado[0].id;

/*
 * ── Por qué una transacción, un `lock_timeout` y reintentos ────────────────
 *
 * El borrado de abajo es barato: unas decenas de filas, ~10 ms (EXPLAIN
 * ANALYZE y pg_stat_statements: 206 ejecuciones, máximo 20 ms). Cuando fallaba
 * con «canceling statement due to statement timeout» (2 min para `postgres`)
 * no era por coste ni por bloat: estaba ESPERANDO UN BLOQUEO. El
 * `statement_timeout` cuenta también el tiempo de espera de un lock, y
 * `delete` necesita `ROW EXCLUSIVE` sobre `public.transaction`, que choca con:
 *
 *   · `scripts/bench-volumen.mjs --propuesta=…`: aplica la migración propuesta
 *     (`create index … on public.transaction`) DENTRO de su única transacción,
 *     que dura minutos y se deshace al final. `CREATE INDEX` toma `SHARE` sobre
 *     la tabla hasta el rollback: mientras tanto, nadie puede escribir en
 *     `transaction` —ni el seed, ni la app—.
 *   · `vacuum full` (`ACCESS EXCLUSIVE`), y cualquier `ALTER TABLE` de una
 *     migración en curso.
 *
 * Por eso: (1) todo el seed va en UNA transacción, de modo que si falla no
 * deja al usuario a medias (sin movimientos pero con cuentas, o sin cuentas);
 * (2) `lock_timeout` corto, para que una espera se note en segundos y no a los
 * 2 minutos; (3) si expira, se dice QUIÉN bloquea (pid, antigüedad y consulta)
 * y se reintenta un par de veces; (4) un cerrojo consultivo por usuario, para
 * que dos corridas del e2e sobre el mismo usuario (dos agentes, o el CI y un
 * agente) se pongan en fila en vez de intercalar borrados e inserciones.
 */
const LOCK_TIMEOUT = "10s";
const INTENTOS = 3;

async function quienBloquea() {
  // Quién tiene un lock sobre las tablas que vamos a vaciar. Solo metadatos de
  // sesión (pid, estado, antigüedad y el principio de la consulta), sin datos.
  return q(
    `select a.pid, a.state, (now() - a.xact_start)::text as antiguedad,
            l.mode, l.relation::regclass::text as tabla, left(a.query, 120) as consulta
       from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.granted and a.pid <> pg_backend_pid()
        and ((l.relation in ('public.transaction'::regclass, 'public.account'::regclass,
                             'public.category'::regclass, 'public.investment_position'::regclass)
              and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'))
             -- otra corrida del seed sobre el mismo usuario
             or (l.locktype = 'advisory' and l.objid = hashtext('seed-demo:' || $1::text)::oid))`,
    [uid],
  );
}

/** Borra y vuelve a sembrar. Corre dentro de la transacción de abajo. */
async function sembrar() {
  // Segunda red: el borrado se ata al id que acabamos de resolver del correo ya
  // validado, nunca a un id suelto pasado por argumento.
  //
  // El orden lo dictan las claves foráneas. `investment_position`, `subscription`
  // y `transaction` referencian a `account` con `on delete restrict`, así que hay
  // que vaciarlas antes de borrar las cuentas: si queda una sola suscripción,
  // `delete from account` aborta con 23503. `valuation` cuelga de
  // `investment_position` (on delete cascade) y va primero por orden. La FK
  // transaction.subscription_id → subscription es `on delete set null`, de modo
  // que borrar las transacciones antes que las suscripciones no puede violar
  // ninguna clave.
  await q("delete from public.valuation where user_id = $1", [uid]);
  // Primero los reembolsos: la base no deja borrar un gasto que tenga alguno
  // (private.tg_gasto_con_reembolsos, 55000), para que ese dinero no pase a
  // contar como ingreso. Sin esto, un reembolso que dejara una prueba o la
  // siembra de la guía hacía abortar el borrado entero.
  await q("delete from public.transaction where user_id = $1 and reimburses_id is not null", [uid]);
  await q("delete from public.transaction where user_id = $1", [uid]);
  // Las categorías se resiembran enteras para que el juego de demo sea
  // determinista y con iconos válidos (el test arrastraba categorías viejas con
  // iconos que ya no existen, y salía la interrogación de reserva). Es seguro
  // borrarlas: ninguna FK a `category` es `restrict` —los movimientos ya se fueron
  // arriba, los límites caen en cascada y las reglas quedan sin categoría (set
  // null)—.
  await q("delete from public.category where user_id = $1", [uid]);
  await q("delete from public.subscription where user_id = $1", [uid]);
  // Los ingresos fijos también cuelgan de la cuenta con clave compuesta: uno solo
  // que quedara hacía abortar el `delete from account` y, con él, todo el e2e.
  await q("delete from public.recurring_income where user_id = $1", [uid]);
  // El libro de participaciones (alta, ajustes, bajas) cae en cascada con la
  // posición, pero se borra explícito: si un día la clave dejara de ser en
  // cascada, el seed fallaría aquí con un mensaje claro y no a medias. Los
  // instrumentos y sus precios son COMPARTIDOS y no se tocan.
  await q("delete from public.position_unit_event where user_id = $1", [uid]);
  await q("delete from public.investment_position where user_id = $1", [uid]);
  // Los préstamos cuelgan de dos cuentas (la de pago y su cuenta-pasivo) con
  // `on delete restrict`: uno solo que quedara —el de un e2e a medias— hacía
  // abortar el `delete from account`. Sus movimientos (desembolso, cuotas) ya
  // se fueron arriba con el resto. Esta conexión no pasa por la RLS, así que el
  // borrado cerrado de `loan` (solo dentro de delete_loan) no la afecta.
  await q("delete from public.loan where user_id = $1", [uid]);
  await q("delete from public.account where user_id = $1", [uid]);

  const banco = (
    await q(
      "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,'Nomina','BANCO',250000) returning id",
      [uid],
    )
  )[0].id;
  const inver = (
    await q(
      "insert into public.account (user_id,name,type) values ($1,'Indexa Capital','INVERSION') returning id",
      [uid],
    )
  )[0].id;
  const visa = (
    await q(
      "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,'Visa','BANCO',-43200) returning id",
      [uid],
    )
  )[0].id;
  // La tarjeta va a public.card (ya no a account.card_last4): es lo que enruta el Atajo.
  await q(
    "insert into public.card (user_id,account_id,last4,type) values ($1,$2,'4412','DEBITO')",
    [uid, visa],
  );

  const p1 = (
    await q(
      "insert into public.investment_position (user_id,name,account_id,color,since) values ($1,'MSCI World',$2,'#6d4bc4',current_date - interval '8 months') returning id",
      [uid, inver],
    )
  )[0].id;
  const p2 = (
    await q(
      "insert into public.investment_position (user_id,name,account_id,color,since) values ($1,'Bonos globales',$2,'#1f7fa8',current_date - interval '8 months') returning id",
      [uid, inver],
    )
  )[0].id;

  // Aportaciones antiguas y valoraciones mensuales, para que haya curva y para
  // que el rendimiento tenga de dónde partir.
  await q(
    "insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,position_id) values ($1,'TRANSFER',400000,'Aportacion',current_date - interval '8 months',$2,$3,$4)",
    [uid, banco, inver, p1],
  );
  await q(
    "insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,to_account_id,position_id) values ($1,'TRANSFER',200000,'Aportacion',current_date - interval '8 months',$2,$3,$4)",
    [uid, banco, inver, p2],
  );

  const meses = [6, 5, 4, 3, 2, 1, 0];
  const v1 = [410000, 425000, 418000, 440000, 455000, 470000, 486000];
  const v2 = [202000, 204000, 203000, 206000, 208000, 210000, 212000];
  for (let i = 0; i < meses.length; i++) {
    const sql =
      "insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,least((date_trunc('month', current_date - make_interval(months => $4)) + interval '1 month' - interval '1 day')::date, current_date),$3) on conflict do nothing";
    await q(sql, [uid, p1, v1[i], meses[i]]);
    await q(sql, [uid, p2, v2[i], meses[i]]);
  }

  // Categorías de demo, con icono y color VÁLIDOS: los nombres de icono salen del
  // mapa de `src/components/ui/icon.tsx` y los colores, de la paleta del editor
  // (`CATEGORY_COLORS`). Cubren los tres tipos para que ninguna pestaña de
  // Categorías salga vacía. La oferta del primer arranque vive aparte, en
  // `src/lib/onboarding.ts`.
  const categorias = [
    ["Supermercado", "EXPENSE", "#2f8f4e", "shopping-cart"],
    ["Restaurantes", "EXPENSE", "#c96a1e", "utensils"],
    ["Transporte", "EXPENSE", "#1f7fa8", "bus"],
    ["Casa", "EXPENSE", "#8a5a12", "house"],
    ["Suministros", "EXPENSE", "#7a6a2e", "lightbulb"],
    ["Ocio", "EXPENSE", "#6d4bc4", "film"],
    ["Salud", "EXPENSE", "#b03060", "heart-pulse"],
    ["Compras", "EXPENSE", "#8b3fbf", "shopping-bag"],
    ["Café", "EXPENSE", "#b5541f", "coffee"],
    ["Ropa", "EXPENSE", "#a32c55", "shirt"],
    ["Mascota", "EXPENSE", "#0d9488", "dog"],
    ["Educación", "EXPENSE", "#0a63d6", "graduation-cap"],
    ["Nómina", "INCOME", "#0e7352", "banknote"],
    ["Intereses", "INCOME", "#4b4bc8", "hand-coins"],
    ["Regalos", "INCOME", "#b03060", "gift"],
    ["Ahorro", "TRANSFER", "#6d4bc4", "piggy-bank"],
  ];
  for (const [name, type, color, icon] of categorias) {
    await q(
      "insert into public.category (user_id,name,type,color,icon) values ($1,$2,$3,$4,$5)",
      [uid, name, type, color, icon],
    );
  }

  return categorias.length;
}

let nCategorias;
for (let intento = 1; ; intento++) {
  try {
    await q("begin");
    await q(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    // Una sola corrida a la vez por usuario: la segunda espera a la primera.
    await q("select pg_advisory_xact_lock(hashtext('seed-demo:' || $1::text))", [uid]);
    nCategorias = await sembrar();
    await q("commit");
    break;
  } catch (error) {
    await q("rollback").catch(() => {});
    // 55P03 = lock_not_available: expiró el lock_timeout.
    if (error.code !== "55P03") throw error;
    const bloqueos = await quienBloquea().catch(() => []);
    console.error(
      `seed-demo: intento ${intento}/${INTENTOS}: esperando un bloqueo más de ${LOCK_TIMEOUT}. ` +
        (bloqueos.length
          ? `Lo tiene: ${JSON.stringify(bloqueos)}`
          : "(ya no se ve quién lo tenía)"),
    );
    if (intento >= INTENTOS) {
      console.error(
        "seed-demo: me rindo. Algo mantiene un bloqueo largo sobre las tablas del usuario " +
          "(¿un bench-volumen con --propuesta, un vacuum full o una migración en curso?). " +
          "No se ha tocado nada: la transacción se ha deshecho.",
      );
      await c.end();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 5_000 * intento));
  }
}

await c.end();
console.log(
  `Sembrado en ${email}: 3 cuentas, 2 posiciones, 14 valoraciones, ${nCategorias} categorías.`,
);
