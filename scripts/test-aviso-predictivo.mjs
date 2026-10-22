/**
 * Prueba del aviso PREDICTIVO de límite: claim_budget_forecast_alerts y la tabla
 * anti-repetición budget_forecast_alert.
 *
 *   node --env-file=.env.local scripts/test-aviso-predictivo.mjs
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): se
 * siembran usuarios y datos, se comprueba y no persiste nada.
 *
 * Prueba el esquema ACTUAL. Antes reaplicaba 20260928090000 dentro de la
 * transacción; ya está aplicada en producción y reaplicarla falla (la tabla
 * budget_forecast_alert ya existe, y en otras pruebas, 42P13 por firmas que
 * cambiaron después). Una migración aplicada no vuelve a correrse: se prueba lo
 * que hay.
 *
 * Las llamadas a claim_budget_forecast_alerts reclaman también los avisos de los
 * usuarios REALES (dentro de la transacción que se deshace, así que no se pierde
 * ninguno): por eso lo que se compara e imprime se filtra a los sembrados. La conexión es el rol `postgres`, que
 * —como `service_role` en producción— evita la RLS: llamar a la función como
 * postgres reproduce fielmente cómo la llama el cron.
 *
 * Lo que se demuestra:
 *   (positivo) una categoría cuya PREVISIÓN rebasa el tope con margen, pero cuyo
 *              gastado aún NO lo ha pasado, se reclama y devuelve nombre, previsión
 *              y tope.
 *   (a)        una segunda llamada el mismo mes NO repite.
 *   (b)        si ya se pasó de verdad (gastado >= tope) NO avisa: es del reactivo.
 *   (margen)   un rebase de calderilla (previsión > tope pero < tope*1,05) no avisa.
 *   (c)        NO avisa demasiado pronto en el mes (guardo de días y de fracción).
 *   (d)        aislamiento: cada aviso lleva su dueño, y un usuario solo ve sus
 *              propias marcas en la tabla (RLS).
 *
 * Las fechas se piden a la base con ::text: el driver pg convierte un `date` a
 * medianoche local y toISOString() devolvería el día anterior.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

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

// Fechas siempre relativas al mes en curso, evaluadas por la base.
const PRIMERO = "date_trunc('month', current_date)::date";
const FIN_MES = "(date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date";

let uid = 0;
async function nuevoUsuario() {
  // Solo `id` es obligatorio en auth.users; el resto tiene default o es nullable.
  const id = (await q("insert into auth.users (id) values (gen_random_uuid()) returning id"))[0].id;
  return id;
}

async function cuentaYCategoria(u) {
  const banco = (
    await q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id", [u])
  )[0].id;
  const cat = (
    await q(
      "insert into public.category (user_id,name,type,color,icon) values ($1,$2,'EXPENSE','#7f6a45','cart') returning id",
      [u, "Compras-" + ++uid],
    )
  )[0].id;
  return { banco, cat };
}

const gasto = (u, banco, cat, cents, fechaSql) =>
  q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
     values ($1,'EXPENSE',$2,'x',${fechaSql},$3,$4,'EXPENSE','MANUAL','CONFIRMED') returning id`,
    [u, cents, banco, cat],
  ).then((r) => r[0].id);

const suscripcionPendiente = (u, banco, cat, cents) =>
  q(
    `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,category_id,category_type,account_id)
     values ($1,'Sub',$2,'MENSUAL',${FIN_MES},$3,'EXPENSE',$4)`,
    [u, cents, cat, banco],
  );

const limite = (u, cat, cap, warn = true) =>
  q(
    "insert into public.budget (user_id,category_id,monthly_cap_cents,warn_at_80) values ($1,$2,$3,$4)",
    [u, cat, cap, warn],
  );

const claim = (mes, minDias = 0, fracNum = 0, fracDen = 3) =>
  q("select * from public.claim_budget_forecast_alerts($1,$2,$3,$4)", [mes, minDias, fracNum, fracDen]);

async function main() {
  await client.connect();
  await client.query("begin");

  try {
    const mes = (await q("select to_char(date_trunc('month',current_date),'YYYY-MM-DD') as m"))[0].m;
    const [{ dias_transcurridos: dt, dias_totales: dtot }] = await q(
      `select * from public.month_forecast(${PRIMERO})`,
    );
    console.log(`(día ${dt} de ${dtot} del mes)\n`);

    // === Usuario A: DISPARA. gastado < tope, pero previsión >= tope*1,05 ======
    // Con una suscripción pendiente de 6000 este mes, la previsión >= 5000+6000 =
    // 11000 sea cual sea el día, y 11000 >= 10000*1,05 = 10500. gastado 5000 < 10000.
    const A = await nuevoUsuario();
    const ca = await cuentaYCategoria(A);
    await limite(A, ca.cat, 10000);
    await gasto(A, ca.banco, ca.cat, 5000, PRIMERO);
    await suscripcionPendiente(A, ca.banco, ca.cat, 6000);

    // === Usuario B: NO dispara. Ya se pasó de verdad (gastado > tope). =========
    const B = await nuevoUsuario();
    const cb = await cuentaYCategoria(B);
    await limite(B, cb.cat, 10000);
    await gasto(B, cb.banco, cb.cat, 11000, PRIMERO);

    // === Usuario E: NO dispara. Calderilla: previsión > tope pero < tope*1,05. =
    // Sin gasto (no hay ritmo que extrapolar) y una suscripción de 10200: la
    // previsión es exactamente 10200, entre 10000 y 10500. Determinista.
    const E = await nuevoUsuario();
    const ce = await cuentaYCategoria(E);
    await limite(E, ce.cat, 10000);
    await suscripcionPendiente(E, ce.banco, ce.cat, 10200);

    // === Usuario D: DISPARA, para el aislamiento (otro dueño). ================
    const D = await nuevoUsuario();
    const cd = await cuentaYCategoria(D);
    await limite(D, cd.cat, 10000);
    await gasto(D, cd.banco, cd.cat, 5000, PRIMERO);
    await suscripcionPendiente(D, cd.banco, cd.cat, 6000);

    // Lo que dice la previsión de A (la misma cifra que ve el usuario en Análisis).
    const cfA = (await q(`select * from public.category_forecast(${PRIMERO})`)).find(
      (c) => c.category_id === ca.cat,
    );
    check(
      "Sembrado de A correcto: rebasa, gastado<tope, previsión>=tope*1,05",
      cfA &&
        cfA.rebasa === true &&
        Number(cfA.gastado_cents) < Number(cfA.cap_cents) &&
        Number(cfA.prevision_cents) * 100 >= Number(cfA.cap_cents) * 105,
      cfA ? JSON.stringify(cfA) : "sin fila de A en category_forecast",
    );

    // ---------------------------------------------------------------------------
    // (c) Demasiado pronto: el guardo temporal calla y NO marca nada.
    // ---------------------------------------------------------------------------
    console.log("— (c) No avisa demasiado pronto —\n");
    const porDias = await claim(mes, dtot + 5, 0, 3); // exige más días de los que hay
    check("Con el mínimo de días por delante, no avisa", porDias.length === 0, `filas ${porDias.length}`);
    const porFraccion = await claim(mes, 0, 100, 1); // exige dt >= 100*dtot: imposible
    check("Con la fracción de mes sin cumplir, no avisa", porFraccion.length === 0, `filas ${porFraccion.length}`);

    // ---------------------------------------------------------------------------
    // (positivo) + (b) + (margen): una sola llamada con el guardo desactivado.
    // ---------------------------------------------------------------------------
    console.log("\n— (positivo) Reclama a quien va camino de pasarse —\n");
    // Solo las filas de los usuarios sembrados: las de los reales ni se miran.
    const sembrados = new Set([A, B, D, E]);
    const primera = (await claim(mes)).filter((r) => sembrados.has(r.user_id)); // guardo desactivado
    const filaA = primera.find((r) => r.user_id === A);
    const filaD = primera.find((r) => r.user_id === D);

    check(
      "Devuelve el aviso de A con nombre, previsión y tope",
      filaA &&
        typeof filaA.category_name === "string" &&
        Number(filaA.prevision_cents) === Number(cfA.prevision_cents) &&
        Number(filaA.cap_cents) === 10000,
      JSON.stringify(filaA),
    );
    check("Devuelve también el aviso de D (otro usuario)", !!filaD, JSON.stringify(filaD));
    check(
      "(b) NO avisa de quien ya se pasó de verdad (gastado>=tope)",
      !primera.some((r) => r.user_id === B),
      "B no debería aparecer: de él avisa el reactivo",
    );
    check(
      "(margen) NO avisa de un rebase de calderilla (<tope*1,05)",
      !primera.some((r) => r.user_id === E),
      "E no debería aparecer: previsión < tope*1,05",
    );
    check(
      "Cada aviso lleva su dueño",
      primera.every((r) => typeof r.user_id === "string" && r.user_id.length === 36),
      JSON.stringify(primera),
    );

    // ---------------------------------------------------------------------------
    // (a) Anti-repetición: una segunda llamada NO vuelve a devolver los mismos.
    // ---------------------------------------------------------------------------
    console.log("\n— (a) No repite el mismo mes —\n");
    const segunda = (await claim(mes)).filter((r) => sembrados.has(r.user_id));
    check(
      "La segunda llamada no repite A ni D",
      !segunda.some((r) => r.user_id === A || r.user_id === D),
      `devuelve ${segunda.length} filas: ${JSON.stringify(segunda)}`,
    );

    // ---------------------------------------------------------------------------
    // (d) Aislamiento por RLS: A solo ve su propia marca en la tabla.
    // ---------------------------------------------------------------------------
    console.log("\n— (d) Aislamiento entre usuarios —\n");
    // Comprobación de que ambas marcas EXISTEN (visto como postgres, que ve todo).
    const marcas = await q(
      "select user_id from public.budget_forecast_alert where user_id = any($1)",
      [[A, D]],
    );
    check("Se anotaron las marcas de A y D", marcas.length === 2, `marcas ${marcas.length}`);

    // Ahora como el usuario A (authenticated + su JWT): solo debe ver la suya.
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: A, role: "authenticated", aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    const visibles = await q("select user_id from public.budget_forecast_alert");
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");

    check(
      "El usuario A solo ve su propia marca (no la de D)",
      visibles.length === 1 && visibles[0].user_id === A,
      `ve ${visibles.length} filas: ${JSON.stringify(visibles)}`,
    );
  } finally {
    // Nada persiste: se deshace la migración, los usuarios y las marcas.
    await client.query("rollback").catch(() => {});
    await client.end();
  }

  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
  process.exit(2);
});
