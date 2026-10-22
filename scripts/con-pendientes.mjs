/**
 * Precarga para correr CUALQUIER prueba de base de datos con las migraciones
 * pendientes aplicadas, sin aplicarlas de verdad ni dejar nada en la base.
 *
 *   node --env-file=.env.local --import ./scripts/con-pendientes.mjs scripts/test-XXX.mjs
 *   node scripts/correr-pruebas-bd.mjs --pendientes          (todas)
 *
 * Muchas pruebas antiguas hacen `begin … commit` por bloques y dan de alta sus
 * usuarios con la API de administración de Supabase. Para que TODO ocurra en
 * una sola transacción que se deshace, esta precarga parchea `pg.Client` y
 * `fetch`:
 *
 *  · Al conectar: `begin` y se aplican las migraciones pendientes
 *    (`migraciones-pendientes.mjs`). Al cerrar (`end`) o al morir el proceso:
 *    `rollback`. Nada persiste.
 *  · El `begin` / `commit` / `rollback` de la prueba se convierten en un
 *    savepoint, su liberación y la vuelta a él. Un `commit` sobre una
 *    transacción fallida se deshace, como en Postgres. Al «confirmar», se
 *    restauran el rol y las reclamaciones del JWT (un `set local` sobrevive a
 *    la liberación de un savepoint, y fuera de la transacción la prueba vuelve
 *    a ser el propietario).
 *  · Una sentencia suelta (sin `begin`) va en su propio savepoint, como el
 *    autocommit: si falla, no tumba la transacción de fuera.
 *  · Volver a aplicar el texto ÍNTEGRO de una migración del repositorio no hace
 *    nada: aquí ya están todas aplicadas (así una prueba que reaplica la suya no
 *    deshace lo que hayan cambiado las posteriores).
 *  · `fetch` a `/auth/v1/admin/users`: el alta inserta el usuario en
 *    auth.users dentro de la transacción (el disparador de alta corre igual) y
 *    el borrado no hace nada (lo deshace el rollback final). Así ninguna prueba
 *    crea usuarios de verdad.
 *
 * Las sentencias de cada cliente se serializan (una prueba que lance consultas
 * en paralelo sobre el mismo cliente no intercala los savepoints).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { aplicarPendientes, migracionesDelRepo } from "./migraciones-pendientes.mjs";

const proto = pg.Client.prototype;
const original = { connect: proto.connect, query: proto.query, end: proto.end };
const estados = new WeakMap();
const contenidos = new Set(migracionesDelRepo().map((m) => m.sql.trim()));
const vacio = (command = "SELECT") => ({ rows: [], rowCount: 0, command, fields: [] });

let principal = null; // el primer cliente que conecta: ahí van las altas de usuario
let avisarPrincipal;
const principalListo = new Promise((ok) => (avisarPrincipal = ok));

proto.connect = function (cb) {
  // Una conexión auxiliar que solo observa (p. ej., si un candado está tomado)
  // se abre con application_name «sin-pendientes»: sin transacción ni
  // migraciones, porque esperaría por los bloqueos de la principal para siempre.
  if (this.connectionParameters?.application_name === "sin-pendientes") return original.connect.call(this, cb);
  const promesa = (async () => {
    await original.connect.call(this);
    const st = { enTx: false, cola: Promise.resolve() };
    const crudo = { query: (sql, p) => original.query.call(this, sql, p) };
    await crudo.query("begin");
    const aplicadas = await aplicarPendientes(crudo);
    if (!principal) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- el primer cliente que conecta es el que recibe las altas de usuario emuladas
      principal = this;
      console.log(
        `(con-pendientes: ${aplicadas.length} migraciones aplicadas dentro de la transacción${aplicadas.length ? `: ${aplicadas.join(", ")}` : ""})`,
      );
    }
    estados.set(this, st);
    if (principal === this) avisarPrincipal(this);
  })();
  if (typeof cb === "function") promesa.then(() => cb(), cb);
  else return promesa;
};

async function ejecutar(cliente, st, consulta, valores) {
  const crudo = (sql, p) => original.query.call(cliente, sql, p);
  const texto = (typeof consulta === "string" ? consulta : (consulta?.text ?? "")).trim();
  const t = texto.toLowerCase().replace(/;$/, "").trim();

  if (contenidos.has(texto)) return vacio("CREATE");

  if (/^(begin|start transaction)\b/.test(t)) {
    if (!st.enTx) {
      await crudo("savepoint t_emulada");
      st.enTx = true;
    }
    return vacio("BEGIN");
  }
  if (/^(commit|end)\b/.test(t) || (/^rollback\b/.test(t) && !/^rollback\s+to\b/.test(t))) {
    if (!st.enTx) return vacio(t.startsWith("rollback") ? "ROLLBACK" : "COMMIT");
    st.enTx = false;
    let deshacer = t.startsWith("rollback");
    if (!deshacer) {
      try {
        await crudo("release savepoint t_emulada");
      } catch {
        deshacer = true; // commit de una transacción fallida = rollback
      }
    }
    if (deshacer) {
      await crudo("rollback to savepoint t_emulada");
      await crudo("release savepoint t_emulada");
    } else {
      await crudo("reset role");
      await crudo("select set_config('request.jwt.claims', '', false), set_config('request.jwt.claim.sub', '', false)");
    }
    return vacio(deshacer ? "ROLLBACK" : "COMMIT");
  }
  if (st.enTx) return crudo(consulta, valores);

  // Sentencia suelta: su propio savepoint, como el autocommit.
  await crudo("savepoint t_suelta");
  try {
    const r = await crudo(consulta, valores);
    await crudo("release savepoint t_suelta");
    return r;
  } catch (e) {
    await crudo("rollback to savepoint t_suelta");
    await crudo("release savepoint t_suelta");
    throw e;
  }
}

proto.query = function (consulta, valores, cb) {
  const st = estados.get(this);
  if (!st || typeof valores === "function" || typeof cb === "function" || typeof consulta?.submit === "function") {
    return original.query.apply(this, arguments);
  }
  const p = st.cola.then(() => ejecutar(this, st, consulta, valores));
  st.cola = p.catch(() => {});
  return p;
};

proto.end = function (cb) {
  const st = estados.get(this);
  const promesa = (async () => {
    if (st) {
      await st.cola;
      estados.delete(this);
      await original.query.call(this, "rollback").catch(() => {});
    }
    return original.end.call(this);
  })();
  if (typeof cb === "function") promesa.then(() => cb(), cb);
  else return promesa;
};

const fetchOriginal = globalThis.fetch;
globalThis.fetch = async function (recurso, init = {}) {
  const url = typeof recurso === "string" ? recurso : (recurso?.url ?? String(recurso));
  const m = url.match(/\/auth\/v1\/admin\/users(?:\/([^/?#]+))?/);
  if (!m) return fetchOriginal(recurso, init);
  const metodo = (init.method ?? "GET").toUpperCase();
  const json = (cuerpo, status = 200) =>
    new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });
  if (metodo === "POST" && !m[1]) {
    const datos = init.body ? JSON.parse(init.body) : {};
    const id = randomUUID();
    const cliente = await principalListo;
    await cliente.query(
      `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), '{}'::jsonb, coalesce($3::jsonb, '{}'::jsonb), now(), now())`,
      [id, datos.email ?? null, datos.user_metadata ? JSON.stringify(datos.user_metadata) : null],
    );
    return json({ id, email: datos.email ?? null, aud: "authenticated", role: "authenticated" });
  }
  if (metodo === "DELETE") return json({});
  throw new Error(`con-pendientes: ${metodo} ${m[0]} no está emulado`);
};
