/**
 * Prueba el recordatorio diario de pagos sin asignar.
 *
 *   node --env-file=.env.local scripts/test-recordatorio.mjs
 *
 * Lo que importa: que salga UNA vez al día. La garantía no es la puntualidad
 * del cron —las tareas de GitHub Actions se retrasan— sino la marca por día.
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
    body: JSON.stringify({ email: `rec-${Date.now()}@cartera.local`, email_confirm: true }),
  });
  const uid = (await alta.json()).id;

  try {
    const cuenta = (
      await q("insert into public.account (user_id,name,type) values ($1,'Visa','BANCO') returning id", [uid])
    )[0].id;

    const pendiente = (n) =>
      q(
        `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,
           source,status,merchant_raw,external_id)
         values ($1,'EXPENSE',$2,'Cargo',current_date,$3,'SHORTCUT','PENDING','Comercio',$4)`,
        [uid, n, cuenta, "x" + Math.random()],
      );

    // La hora de Madrid ahora mismo, que decide si toca avisar.
    const hora = Number(
      (await q("select extract(hour from (now() at time zone 'Europe/Madrid'))::int as h"))[0].h,
    );
    console.log(`(son las ${hora}:00 en Madrid)\n`);

    /**
     * `claim_pending_reminder` actúa sobre TODOS los usuarios, porque la llama
     * el cron una vez para todos. Llamarla desde una prueba marcaría como
     * avisados a usuarios reales y se comería su recordatorio del día.
     *
     * Así que se guardan las marcas ajenas antes y se devuelven después, y las
     * comprobaciones se quedan solo con las filas de este usuario de prueba.
     */
    const reclamar = async (desde) => {
      const antes = await q(
        "select user_id, pending_notified_on from public.profile where user_id <> $1",
        [uid],
      );
      const filas = await q("select * from public.claim_pending_reminder($1)", [desde]);
      for (const x of antes) {
        await q("update public.profile set pending_notified_on = $2 where user_id = $1", [
          x.user_id,
          x.pending_notified_on,
        ]);
      }
      return filas.filter((f) => f.user_id === uid);
    };

    console.log("— Sin pendientes no molesta —\n");
    check("Sin pagos sin asignar no devuelve nada", (await reclamar(0)).length === 0);

    await pendiente(300);
    await pendiente(1570);

    console.log("\n— Antes de la hora, calla —\n");
    // Una hora imposible de alcanzar: nunca es esa hora todavía.
    check("Con la hora puesta por delante no avisa", (await reclamar(hora + 2 > 23 ? 23 : hora + 2)).length === 0);

    console.log("\n— A partir de la hora, avisa una vez —\n");
    const primera = await reclamar(0);
    check(
      "Avisa, con la cuenta correcta de pendientes",
      primera.length === 1 && Number(primera[0].cuantos) === 2,
      JSON.stringify(primera),
    );

    /**
     * El caso que justifica la marca: el cron dispara a las 07:00 y a las 08:00
     * UTC, y puede llegar tarde. Sin la marca, dos ejecuciones dentro de la
     * ventana darían dos avisos del mismo montón de pagos.
     */
    const segunda = await reclamar(0);
    check(
      "Una segunda ejecucion el mismo dia NO repite",
      segunda.length === 0,
      `devuelve ${segunda.length} filas`,
    );

    const tercera = await reclamar(0);
    check("Ni una tercera", tercera.length === 0);

    console.log("\n— Mañana vuelve a avisar —\n");
    await q(
      "update public.profile set pending_notified_on = pending_notified_on - 1 where user_id = $1",
      [uid],
    );
    const manana = await reclamar(0);
    check(
      "Pasado un dia vuelve a avisar",
      manana.length === 1 && Number(manana[0].cuantos) === 2,
      JSON.stringify(manana),
    );

    console.log("\n— Al clasificarlos, deja de avisar —\n");
    const cat = (
      await q(
        "insert into public.category (user_id,name,type) values ($1,'Varios','EXPENSE') returning id",
        [uid],
      )
    )[0].id;
    await q(
      "update public.transaction set category_id=$2, category_type='EXPENSE', status='CONFIRMED' where user_id=$1",
      [uid, cat],
    );
    await q("update public.profile set pending_notified_on = null where user_id = $1", [uid]);
    check("Sin pendientes ya no avisa", (await reclamar(0)).length === 0);

    console.log("\n— Aislamiento —\n");
    const otro = await fetch(`${API}/auth/v1/admin/users`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ email: `rec-otro-${Date.now()}@cartera.local`, email_confirm: true }),
    });
    const uidOtro = (await otro.json()).id;
    await pendiente(999);
    await q("update public.profile set pending_notified_on = null where user_id = $1", [uid]);
    // Sin filtrar, para comprobar que cada fila lleva su dueño.
    const sinFiltrar = await q("select * from public.claim_pending_reminder(0)");
    check(
      "Cada aviso lleva su dueño",
      sinFiltrar.every((f) => typeof f.user_id === "string" && f.user_id.length === 36),
      JSON.stringify(sinFiltrar),
    );
    check(
      "El usuario sin pendientes no aparece",
      !sinFiltrar.some((f) => f.user_id === uidOtro),
      JSON.stringify(sinFiltrar),
    );
    // Y se devuelven las marcas ajenas que esa llamada sin filtrar haya tocado.
    for (const f of sinFiltrar) {
      if (f.user_id !== uid) {
        await q("update public.profile set pending_notified_on = null where user_id = $1", [
          f.user_id,
        ]);
      }
    }
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
