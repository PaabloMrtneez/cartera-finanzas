/**
 * Prueba de 20261020091000_cuadro_que_amortiza.sql (H-08, lado SQL):
 * public.loan_plan rechaza los cuadros cuya cuota no amortiza (capital <= 0 en
 * alguna cuota, o una última cuota que se aparta de la primera más de
 * max(1 €, 10 %)), y deja IGUAL todos los demás.
 *
 *   node --env-file=.env.local scripts/test-cuadro-amortiza.mjs
 *
 * TODO dentro de UNA transacción que se deshace. Los préstamos reales solo se
 * cuentan (ninguna cifra impresa). La comparación al céntimo con el lado TS
 * (cuadroAmortizacion) la hace scripts/test-prestamos.mjs.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { aplicarPendientes } from "./migraciones-pendientes.mjs";

const VERSION = "20261020091000";
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

async function plan(P, plazo, tin) {
  await q("savepoint p");
  try {
    const filas = await q(
      "select period, payment_cents::bigint::text as c, interest_cents::text as i, principal_cents::text as k, balance_after_cents::text as b from public.loan_plan($1, $2, $3::numeric, '2026-12-28') order by period",
      [P, plazo, tin],
    );
    await q("release savepoint p");
    return { filas, error: null };
  } catch (e) {
    await q("rollback to savepoint p");
    await q("release savepoint p");
    return { filas: null, error: e };
  }
}

/** La regla, aplicada a un cuadro que la base daba por bueno. */
function amortizaBien(filas) {
  if (filas.some((f) => Number(f.k) <= 0)) return false;
  if (filas.length < 2) return true;
  const primera = Number(filas[0].c);
  const ultima = Number(filas.at(-1).c);
  return Math.abs(ultima - primera) <= Math.max(100, Math.floor(primera / 10));
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    await aplicarPendientes(client, { hasta: String(Number(VERSION) - 1) });
    const principales = [10_000, 123_457, 1_000_000, 5_000_000, 99_999_999, 1_000_000_000];
    const plazos = [1, 2, 12, 60, 120, 360, 480];
    const tins = ["0", "1.5", "3.25", "6", "12.5", "25", "30", "49.9999"];
    const antes = new Map();
    for (const P of principales) for (const n of plazos) for (const t of tins) antes.set(`${P}/${n}/${t}`, await plan(P, n, t));

    const reales = (await q("select id::text as id from auth.users order by created_at")).map((r) => r.id);
    const fotos = [];
    for (const r of reales) fotos.push(await fotoUsuario(client, r, { conHoy: false }));

    const ap = await aplicarPendientes(client, { hasta: VERSION });
    if (ap.length) console.log(`(aplicadas dentro de la transacción: ${ap.join(", ")})\n`);

    console.log("— Los casos del informe —\n");
    const c1 = await plan(10_000, 480, "30");
    check("100 € a 480 meses al 30 % (479 cuotas sin capital): rechazado (22023)", c1.error?.code === "22023", c1.error?.message ?? "aceptado");
    check("… con el mensaje de la app", /no amortiza bien el préstamo/.test(c1.error?.message ?? ""));
    const c2 = await plan(5_000_000, 480, "25");
    check("50.000 € a 40 años al 25 % (última cuota 979 € por debajo): rechazado", c2.error?.code === "22023", c2.error?.message ?? "aceptado");
    const c3 = await plan(20_000_000, 360, "3");
    check("200.000 € a 30 años al 3 %: aceptado", !c3.error && c3.filas.length === 360, c3.error?.message);

    console.log("\n— Rejilla: solo cambia lo que incumple la regla —\n");
    let iguales = 0;
    let nuevosRechazos = 0;
    const raros = [];
    for (const [clave, a] of antes) {
      const [P, n, t] = clave.split("/");
      const d = await plan(Number(P), Number(n), t);
      if (a.error) {
        if (d.error?.code === "22023") iguales++;
        else raros.push(`${clave}: antes rechazado, ahora no`);
      } else if (amortizaBien(a.filas)) {
        if (!d.error && JSON.stringify(d.filas) === JSON.stringify(a.filas)) iguales++;
        else raros.push(`${clave}: cumplía la regla y cambia`);
      } else if (d.error?.code === "22023") nuevosRechazos++;
      else raros.push(`${clave}: incumple la regla y se acepta`);
    }
    check(
      `${antes.size} casos: los que cumplen la regla, idénticos fila a fila; los que no, rechazados`,
      raros.length === 0,
      raros.slice(0, 5).join("; "),
    );
    console.log(`        (${iguales} iguales, ${nuevosRechazos} rechazados ahora por la regla nueva)`);

    console.log("\n— Préstamos reales (solo recuentos) —\n");
    const prestamos = await q("select principal_cents, term_months, tin_pct::text as tin, first_charge_on::text as f from public.loan");
    let invalidos = 0;
    for (const l of prestamos) {
      await q("savepoint l");
      try {
        await q("select count(*) from public.loan_plan($1, $2, $3::numeric, $4::date)", [l.principal_cents, l.term_months, l.tin, l.f]);
      } catch {
        invalidos++;
      }
      await q("rollback to savepoint l");
      await q("release savepoint l");
    }
    check(`ninguno de los ${prestamos.length} préstamos de la base queda fuera de la regla`, invalidos === 0, `${invalidos}`);
    let mismas = 0;
    for (const [i, r] of reales.entries()) {
      if (compararFotos(fotos[i], await fotoUsuario(client, r, { conHoy: false })).length === 0) mismas++;
    }
    check(`cifras de los ${reales.length} usuarios reales idénticas (préstamos incluidos)`, mismas === reales.length);
  } finally {
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
