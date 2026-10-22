/**
 * Prueba la señal de salud de la ingesta del Atajo y su aviso.
 *
 *   node --env-file=.env.local scripts/test-salud-ingesta.mjs
 *
 * Verifica la DETECCIÓN, no el envío: no manda ningún push. Siembra un
 * dispositivo mudo y unos rechazos para un usuario @cartera.local y comprueba
 * que la señal se dispara cuando toca, que NO se dispara cuando no, y que el
 * aviso no se repite a diario mientras el problema dura. Limpia lo que siembra.
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

async function crearUsuario(prefijo) {
  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email: `${prefijo}-${Date.now()}@cartera.local`, email_confirm: true }),
  });
  return (await alta.json()).id;
}

async function main() {
  await client.connect();
  const uid = await crearUsuario("salud");
  let uidOtro = null;

  try {
    // Dispositivo activo hoy: el punto de partida sano.
    const dev = (
      await q(
        `insert into public.ingest_device
           (user_id, name, token_hash, token_prefix, request_count, last_used_at)
         values ($1, 'iPhone test',
                 decode(replace(gen_random_uuid()::text, '-', ''), 'hex'),
                 'cart_test', 5, now())
         returning id`,
        [uid],
      )
    )[0].id;

    const rechazo = (recibidoHace) =>
      q(
        `insert into public.ingest_dead_letter (device_id, user_id, reason, payload, received_at)
         values ($1, $2, 'invalid_amount', '{"amount":""}'::jsonb, now() - $3::interval)`,
        [dev, uid, recibidoHace],
      );

    const limpiarRechazos = () => q("delete from public.ingest_dead_letter where device_id = $1", [dev]);
    const resetMarca = () =>
      q("update public.profile set ingest_health_notified_on = null where user_id = $1", [uid]);
    const verSalud = async () =>
      (await q("select * from public.v_ingest_health where user_id = $1", [uid]))[0] ?? null;

    /**
     * claim_ingest_health_alerts actúa sobre TODOS los usuarios, como el cron.
     * Llamarla desde la prueba marcaría a usuarios reales y se comería su aviso.
     * Se guardan sus marcas antes y se devuelven después; nos quedamos con uid.
     */
    const reclamar = async (fromHour = 0, cooldown = 3) => {
      const antes = await q(
        "select user_id, ingest_health_notified_on from public.profile where user_id <> $1",
        [uid],
      );
      const filas = await q("select * from public.claim_ingest_health_alerts($1, $2)", [
        fromHour,
        cooldown,
      ]);
      for (const x of antes) {
        await q("update public.profile set ingest_health_notified_on = $2 where user_id = $1", [
          x.user_id,
          x.ingest_health_notified_on,
        ]);
      }
      return filas.filter((f) => f.user_id === uid);
    };

    console.log("— La vista está aislada por RLS —\n");
    const inv = await q(
      `select coalesce((select option_value from pg_options_to_table(c.reloptions)
                        where option_name = 'security_invoker'), 'false') as v
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'v_ingest_health'`,
    );
    check("v_ingest_health es security_invoker", inv[0]?.v === "true", JSON.stringify(inv));

    console.log("\n— Sano no molesta —\n");
    const sano = await verSalud();
    check(
      "Con el dispositivo activo y sin rechazos, no hay señal",
      sano === null || sano.unhealthy === false,
      JSON.stringify(sano),
    );
    await resetMarca();
    check("Sano no dispara aviso", (await reclamar()).length === 0);

    console.log("\n— Rechazos recientes: 3 en 24 h disparan —\n");
    await rechazo("1 hour");
    await rechazo("2 hours");
    await rechazo("3 hours");
    const conRechazos = await verSalud();
    check(
      "La vista ve 3 rechazos y marca la señal",
      conRechazos &&
        Number(conRechazos.rejections_24h) === 3 &&
        conRechazos.many_rejections === true &&
        conRechazos.unhealthy === true,
      JSON.stringify(conRechazos),
    );

    await resetMarca();
    const primera = await reclamar();
    check(
      "Avisa, con el recuento de rechazos correcto",
      primera.length === 1 &&
        Number(primera[0].rejections_24h) === 3 &&
        primera[0].many_rejections === true,
      JSON.stringify(primera),
    );

    console.log("\n— No se repite a diario mientras dura —\n");
    check("Recién avisado, no repite en la misma corrida", (await reclamar()).length === 0);
    // Dos días después: aún dentro de la ventana de reposo (3 días).
    await q(
      "update public.profile set ingest_health_notified_on = (now() at time zone 'Europe/Madrid')::date - 2 where user_id = $1",
      [uid],
    );
    check("A los 2 días (reposo 3) sigue callado", (await reclamar(0, 3)).length === 0);
    // Tres días después: cumplida la ventana, vuelve a avisar.
    await q(
      "update public.profile set ingest_health_notified_on = (now() at time zone 'Europe/Madrid')::date - 3 where user_id = $1",
      [uid],
    );
    check("A los 3 días vuelve a avisar", (await reclamar(0, 3)).length === 1);

    console.log("\n— Por debajo del umbral no dispara —\n");
    await limpiarRechazos();
    await rechazo("1 hour");
    await rechazo("2 hours");
    await rechazo("30 hours"); // fuera de la ventana de 24 h: no cuenta
    const pocos = await verSalud();
    check(
      "2 rechazos en 24 h (más 1 viejo) no es señal",
      pocos &&
        Number(pocos.rejections_24h) === 2 &&
        pocos.many_rejections === false &&
        pocos.unhealthy === false,
      JSON.stringify(pocos),
    );
    await resetMarca();
    check("Con pocos rechazos no avisa", (await reclamar()).length === 0);

    console.log("\n— Dispositivo mudo: 5+ días callado dispara —\n");
    await limpiarRechazos();
    await q(
      "update public.ingest_device set last_used_at = now() - interval '6 days', request_count = 5 where id = $1",
      [dev],
    );
    const mudo = await verSalud();
    check(
      "La vista ve el dispositivo mudo",
      mudo &&
        Number(mudo.mute_devices) === 1 &&
        Number(mudo.max_mute_days) >= 5 &&
        mudo.many_rejections === false &&
        mudo.unhealthy === true,
      JSON.stringify(mudo),
    );
    await resetMarca();
    const porMudo = await reclamar();
    check(
      "Avisa por dispositivo mudo, con los días callado",
      porMudo.length === 1 &&
        Number(porMudo[0].mute_devices) === 1 &&
        Number(porMudo[0].max_mute_days) >= 5,
      JSON.stringify(porMudo),
    );

    console.log("\n— Callado pero por debajo del umbral no dispara —\n");
    await q(
      "update public.ingest_device set last_used_at = now() - interval '3 days' where id = $1",
      [dev],
    );
    const casiMudo = await verSalud();
    check(
      "3 días callado todavía no es señal",
      casiMudo === null || casiMudo.unhealthy === false,
      JSON.stringify(casiMudo),
    );
    await resetMarca();
    check("A los 3 días callado no avisa", (await reclamar()).length === 0);

    console.log("\n— Un dispositivo que nunca funcionó no cuenta como mudo —\n");
    await q(
      "update public.ingest_device set request_count = 0, last_used_at = now() - interval '10 days' where id = $1",
      [dev],
    );
    const nuncaActivo = await verSalud();
    check(
      "Sin envíos correctos (request_count = 0) no es dispositivo mudo",
      nuncaActivo === null || nuncaActivo.unhealthy === false,
      JSON.stringify(nuncaActivo),
    );

    console.log("\n— La hora de la mañana manda —\n");
    await q(
      "update public.ingest_device set last_used_at = now() - interval '6 days', request_count = 5 where id = $1",
      [dev],
    );
    await resetMarca();
    // Una hora imposible de alcanzar (24): nunca es aún esa hora.
    check("Antes de la hora acordada, no avisa", (await reclamar(24)).length === 0);
    check("A partir de la hora, sí avisa", (await reclamar(0)).length === 1);

    console.log("\n— Aislamiento entre usuarios —\n");
    uidOtro = await crearUsuario("salud-otro");
    // El otro tiene un dispositivo sano, activo hoy.
    await q(
      `insert into public.ingest_device
         (user_id, name, token_hash, token_prefix, request_count, last_used_at)
       values ($1, 'iPhone sano',
               decode(replace(gen_random_uuid()::text, '-', ''), 'hex'),
               'cart_test', 3, now())`,
      [uidOtro],
    );
    // uid sigue mudo (arriba). Reset de marcas de ambos usuarios de prueba.
    await resetMarca();
    await q("update public.profile set ingest_health_notified_on = null where user_id = $1", [
      uidOtro,
    ]);

    // Llamada sin filtrar para inspeccionar el reparto, protegiendo a los reales.
    const antesReales = await q(
      "select user_id, ingest_health_notified_on from public.profile where user_id <> $1 and user_id <> $2",
      [uid, uidOtro],
    );
    const todos = await q("select * from public.claim_ingest_health_alerts(0, 3)");
    for (const x of antesReales) {
      await q("update public.profile set ingest_health_notified_on = $2 where user_id = $1", [
        x.user_id,
        x.ingest_health_notified_on,
      ]);
    }
    check(
      "El usuario mudo aparece en el reparto",
      todos.some((f) => f.user_id === uid),
      JSON.stringify(todos.map((f) => f.user_id)),
    );
    check(
      "El usuario sano NO aparece",
      !todos.some((f) => f.user_id === uidOtro),
      JSON.stringify(todos.map((f) => f.user_id)),
    );
    check(
      "Cada aviso lleva su dueño",
      todos.every((f) => typeof f.user_id === "string" && f.user_id.length === 36),
      JSON.stringify(todos),
    );
  } finally {
    // Borrar los usuarios arrastra dispositivos (FK on delete cascade) y, con
    // ellos, los rechazos sembrados (dead_letter.device_id on delete cascade).
    await fetch(`${API}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: h });
    if (uidOtro) {
      await fetch(`${API}/auth/v1/admin/users/${uidOtro}`, { method: "DELETE", headers: h });
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
