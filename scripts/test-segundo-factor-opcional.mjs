/**
 * Prueba de 20261019090000_segundo_factor_opcional.sql: el segundo factor pasa
 * a ser opcional, pero quien lo tiene sigue obligado a superarlo.
 *
 *   node --env-file=.env.local scripts/test-segundo-factor-opcional.mjs
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): la
 * migración se aplica ahí dentro, los usuarios sintéticos y su factor se
 * insertan ahí dentro, y no persiste nada. De los usuarios reales solo se
 * cuentan cosas (cuántos hay, cuántas filas ve cada uno con su nivel); no se
 * lee ni se imprime ningún dato suyo.
 *
 * Comprueba, con sesiones simuladas (`request.jwt.claims` + `set local role`):
 *   a) sin factor y aal1 → ve lo suyo y puede escribir;
 *   b) con factor verificado y aal1 → cero filas y no puede escribir (como hoy);
 *   c) con factor verificado y aal2 → ve y escribe lo suyo;
 *   d) nadie ve ni toca filas de otro, con ningún nivel;
 *   e) anon → nada;
 *   f) un factor sin verificar no cuenta como factor;
 *   g) los usuarios REALES con factor siguen sin ver nada con aal1;
 *   h) permisos y forma de las funciones (security definer, search_path,
 *      EXECUTE solo para authenticated).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACION = "20261019090000_segundo_factor_opcional.sql";

const url = process.env.DATABASE_URL ?? "";
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? false : sslDb });
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

/**
 * Ejecuta `trabajo` como una sesión concreta, en un savepoint que se deshace
 * siempre. Devuelve { valor, error }.
 */
async function como(sesion, trabajo) {
  await q("savepoint s");
  let valor = null;
  let error = null;
  try {
    if (sesion.anon) {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
      await q("set local role anon");
    } else {
      await q("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: sesion.uid, role: "authenticated", aal: sesion.aal }),
      ]);
      await q("set local role authenticated");
    }
    valor = await trabajo();
  } catch (e) {
    error = e;
  }
  await q("rollback to savepoint s");
  await q("release savepoint s");
  await q("reset role");
  return { valor, error };
}

/** `proconfig` llega como texto de array: {"search_path=\"\""}. */
const SIN_PATH = { test: (conf) => /search_path=(,|}|$)/.test(conf.replace(/[\\"']/g, "")) };

const cuenta = async (tabla) => Number((await q(`select count(*) as n from public.${tabla}`))[0].n);

async function crearUsuario() {
  const [u] = await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id");
  return u.id;
}

async function darFactor(uid, estado) {
  await q(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, 'totp', $3, now(), now())`,
    [uid, `prueba-${estado}-${uid.slice(0, 8)}`, estado],
  );
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    console.log(`Base ${local ? "LOCAL" : "remota"}`);

    // Usuarios reales: solo cuántos y cuántos con factor, para el bloque g.
    const reales = await q(`
      select u.id::text as id,
             exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified') as con_factor
        from auth.users u`);

    await client.query(readFileSync(join(raiz, "supabase", "migrations", MIGRACION), "utf8"));
    console.log(`(migración ${MIGRACION} aplicada dentro de la transacción)\n`);

    // Usuarios sintéticos, cada uno con una cuenta propia (sembrada como
    // propietario, saltando la RLS, para no depender de lo que se prueba).
    const sin = await crearUsuario(); // sin factor
    const con = await crearUsuario(); // con factor verificado
    const otro = await crearUsuario(); // sin factor, para el aislamiento
    const aMedias = await crearUsuario(); // solo un factor SIN verificar
    await darFactor(con, "verified");
    await darFactor(aMedias, "unverified");
    for (const uid of [sin, con, otro, aMedias]) {
      await q("insert into public.account (user_id, name, type) values ($1, 'Prueba 2FA', 'BANCO')", [uid]);
    }

    const insertarCuenta = (uid) => () =>
      q("insert into public.account (user_id, name, type) values ($1, 'Nueva', 'EFECTIVO') returning id", [uid]);

    // ── a) Sin factor, aal1 ────────────────────────────────────────────────
    console.log("— a) sin factor, solo contraseña (aal1) —");
    let r = await como({ uid: sin, aal: "aal1" }, () => cuenta("account"));
    check("ve sus cuentas (1)", r.valor === 1, `ve ${r.valor} · ${r.error?.message ?? ""}`);
    r = await como({ uid: sin, aal: "aal1" }, () => cuenta("profile"));
    check("ve su perfil", r.valor === 1, `ve ${r.valor}`);
    r = await como({ uid: sin, aal: "aal1" }, insertarCuenta(sin));
    check("puede insertar lo suyo", !r.error && r.valor?.length === 1, r.error?.message);
    r = await como({ uid: sin, aal: "aal1" }, () =>
      q("update public.account set name = 'Cambiada' where user_id = $1 returning id", [sin]),
    );
    check("puede actualizar lo suyo", !r.error && r.valor?.length === 1, r.error?.message);
    r = await como({ uid: sin, aal: "aal1" }, () => q("select private.current_user_id()::text as id"));
    check("current_user_id() es su uid", r.valor?.[0]?.id === sin);
    // Una función security definer que llama a current_user_id() (corre como
    // su propietario): la regla nueva tiene que valer también ahí.
    r = await como({ uid: sin, aal: "aal1" }, () => q("select public.create_ingest_device('Prueba 2FA') as t"));
    check("puede usar una RPC security definer (create_ingest_device)", !r.error, r.error?.message);
    r = await como({ uid: con, aal: "aal1" }, () => q("select public.create_ingest_device('Prueba 2FA') as t"));
    check("con factor y aal1, esa misma RPC se niega", !!r.error, "funcionó");

    // ── b) Con factor verificado, aal1 ─────────────────────────────────────
    console.log("\n— b) con factor verificado, solo contraseña (aal1) —");
    r = await como({ uid: con, aal: "aal1" }, () => cuenta("account"));
    check("no ve nada (0 cuentas)", r.valor === 0, `ve ${r.valor}`);
    r = await como({ uid: con, aal: "aal1" }, () => cuenta("profile"));
    check("ni su perfil", r.valor === 0, `ve ${r.valor}`);
    r = await como({ uid: con, aal: "aal1" }, insertarCuenta(con));
    check("no puede insertar", !!r.error, "insertó");
    r = await como({ uid: con, aal: "aal1" }, () =>
      q("update public.account set name = 'X' where user_id = $1 returning id", [con]),
    );
    check("no puede actualizar (0 filas)", !r.error && r.valor?.length === 0, r.error?.message);
    r = await como({ uid: con, aal: "aal1" }, () =>
      q("delete from public.account where user_id = $1 returning id", [con]),
    );
    check("no puede borrar (0 filas)", !r.error && r.valor?.length === 0, r.error?.message);
    r = await como({ uid: con, aal: "aal1" }, () => q("select private.current_user_id() as id"));
    check("current_user_id() es nulo", r.valor?.[0]?.id === null);
    // Sin la marca `aal` en el token, igual que aal1.
    r = await como({ uid: con, aal: undefined }, () => cuenta("account"));
    check("sin `aal` en el token, tampoco", r.valor === 0, `ve ${r.valor}`);

    // ── c) Con factor verificado, aal2 ─────────────────────────────────────
    console.log("\n— c) con factor verificado y superado (aal2) —");
    r = await como({ uid: con, aal: "aal2" }, () => cuenta("account"));
    check("ve sus cuentas (1)", r.valor === 1, `ve ${r.valor}`);
    r = await como({ uid: con, aal: "aal2" }, insertarCuenta(con));
    check("puede insertar lo suyo", !r.error && r.valor?.length === 1, r.error?.message);
    r = await como({ uid: sin, aal: "aal2" }, () => cuenta("account"));
    check("sin factor y aal2 (caso raro) también ve lo suyo", r.valor === 1, `ve ${r.valor}`);

    // ── d) Aislamiento ─────────────────────────────────────────────────────
    console.log("\n— d) nadie ve ni toca lo de otro —");
    for (const [quien, uid, aal] of [
      ["sin factor aal1", sin, "aal1"],
      ["con factor aal2", con, "aal2"],
    ]) {
      r = await como({ uid, aal }, () =>
        q("select count(*)::int as n from public.account where user_id <> $1", [uid]),
      );
      check(`${quien}: 0 cuentas ajenas`, r.valor?.[0]?.n === 0, `ve ${r.valor?.[0]?.n}`);
      r = await como({ uid, aal }, insertarCuenta(otro));
      check(`${quien}: no inserta a nombre de otro`, !!r.error, "insertó");
      r = await como({ uid, aal }, () =>
        q("update public.account set name = 'Robada' where user_id = $1 returning id", [otro]),
      );
      check(`${quien}: no actualiza lo de otro`, !r.error && r.valor?.length === 0, r.error?.message);
      r = await como({ uid, aal }, () =>
        q("delete from public.account where user_id = $1 returning id", [otro]),
      );
      check(`${quien}: no borra lo de otro`, !r.error && r.valor?.length === 0, r.error?.message);
    }
    r = await como({ uid: sin, aal: "aal1" }, () =>
      q("select private.segundo_factor_cumplido() as v"),
    );
    check("segundo_factor_cumplido() no admite preguntar por otro (no tiene parámetros)", r.valor?.[0]?.v === true);
    r = await como({ uid: sin, aal: "aal1" }, () => q("select count(*) from auth.mfa_factors"));
    check("authenticated sigue sin poder leer auth.mfa_factors", !!r.error);

    // ── e) anon ────────────────────────────────────────────────────────────
    console.log("\n— e) sin sesión (anon) —");
    r = await como({ anon: true }, () => cuenta("account"));
    check("anon no lee cuentas", !!r.error || r.valor === 0, `ve ${r.valor}`);
    r = await como({ anon: true }, () => q("select private.segundo_factor_cumplido()"));
    check("anon no puede ejecutar segundo_factor_cumplido()", !!r.error);

    // ── f) Factor a medias ─────────────────────────────────────────────────
    console.log("\n— f) un factor SIN verificar no cuenta —");
    r = await como({ uid: aMedias, aal: "aal1" }, () => cuenta("account"));
    check("con solo un factor sin verificar, entra como sin factor", r.valor === 1, `ve ${r.valor}`);

    // ── g) Usuarios reales ─────────────────────────────────────────────────
    console.log(`\n— g) usuarios reales (${reales.length}; solo conteos) —`);
    let conFactorCiegos = 0;
    let conFactor = 0;
    let conFactorVenAal2 = 0;
    for (const u of reales.filter((x) => x.con_factor)) {
      conFactor++;
      const a1 = await como({ uid: u.id, aal: "aal1" }, async () => {
        const tablas = ["account", "transaction", "category", "profile"];
        let total = 0;
        for (const t of tablas) total += await cuenta(t);
        return total;
      });
      if (a1.valor === 0) conFactorCiegos++;
      const a2 = await como({ uid: u.id, aal: "aal2" }, () => cuenta("profile"));
      if (a2.valor === 1) conFactorVenAal2++;
    }
    check(
      `los ${conFactor} con factor verificado no ven nada con aal1 (como hoy)`,
      conFactorCiegos === conFactor,
      `${conFactorCiegos} de ${conFactor}`,
    );
    check(
      `los ${conFactor} con factor ven su perfil con aal2`,
      conFactorVenAal2 === conFactor,
      `${conFactorVenAal2} de ${conFactor}`,
    );
    console.log(`  (sin factor verificado: ${reales.length - conFactor}; con aal1 pasarán a ver lo suyo)`);

    // ── h) Forma y permisos ────────────────────────────────────────────────
    console.log("\n— h) forma y permisos —");
    const [f] = await q(`
      select p.prosecdef as definer, p.provolatile as vol, p.proconfig::text as conf,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
             has_function_privilege('anon', p.oid, 'execute') as anon_x,
             has_function_privilege('public', p.oid, 'execute') as public_x
        from pg_proc p where p.oid = 'private.segundo_factor_cumplido()'::regprocedure`);
    check("segundo_factor_cumplido es security definer y stable", f.definer && f.vol === "s");
    check("con search_path vacío", SIN_PATH.test(f.conf ?? ""), f.conf);
    check("EXECUTE para authenticated", f.auth_x);
    check("sin EXECUTE para anon ni public", !f.anon_x && !f.public_x);
    const [c] = await q(`
      select p.prosecdef as definer, p.proconfig::text as conf
        from pg_proc p where p.oid = 'private.current_user_id()'::regprocedure`);
    check("current_user_id sigue siendo security invoker con search_path vacío", !c.definer && SIN_PATH.test(c.conf ?? ""));
    const [pol] = await q(`
      select count(*)::int as total,
             count(*) filter (where coalesce(qual, '') || coalesce(with_check, '') like '%current_user_id%')::int as cuid
        from pg_policies where schemaname = 'public'`);
    check(
      `las ${pol.total} políticas de public siguen pasando por current_user_id()`,
      pol.total === pol.cuid && pol.total > 0,
      `${pol.cuid} de ${pol.total}`,
    );
    const [aal] = await q(`
      select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosrc ~ '''aal'''
         and p.proname not in ('segundo_factor_cumplido')`);
    check("ninguna otra función mira `aal` por su cuenta", aal.n === 0, `${aal.n}`);
    const [vis] = await q(`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v'
         and not coalesce(c.reloptions::text, '') like '%security_invoker=true%'`);
    check("todas las vistas siguen con security_invoker", vis.n === 0, `${vis.n} sin él`);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
  console.log(`\n${ok} correctas · ${mal} fallidas · nada persiste (rollback)`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
  process.exit(2);
});
