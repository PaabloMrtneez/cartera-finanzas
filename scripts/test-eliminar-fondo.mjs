/**
 * Prueba de 20261008100000_eliminar_fondos.sql:
 *   position_delete_preview(uuid), delete_position(uuid, text) y la política
 *   de borrado de investment_position, redefinida.
 *
 *   node --env-file=.env.local scripts/test-eliminar-fondo.mjs
 *
 * TODO ocurre dentro de UNA transacción que al final se DESHACE (rollback): la
 * migración se aplica ahí dentro si aún no está en la base, los usuarios de
 * prueba se insertan en auth.users ahí dentro, y no persiste nada.
 *
 * Cuatro bloques:
 *
 *   1. DATOS REALES. Para cada usuario y cada posición suya, el preview cuadra
 *      con recuentos independientes. Para la posición con más aportaciones de
 *      cada usuario se ejecuta delete_position dentro de un savepoint y se
 *      comprueba que el saldo de CADA cuenta y el patrimonio cambian
 *      exactamente lo que dijo el preview, que no queda nada de la posición y
 *      que nada más se toca. Se deshace al momento. No se imprime ninguna cifra
 *      de nadie: solo si cuadra o no.
 *   2. DATOS SEMBRADOS. Un fondo con valoraciones, libro de participaciones
 *      (ALTA y AJUSTE sobre un instrumento con precio), aportaciones desde dos
 *      cuentas (una con participaciones), una descartada CON participaciones,
 *      un traspaso en sentido contrario enlazado, y alrededor todo lo que NO se
 *      debe tocar: otra posición con su aportación, un traspaso sin posición,
 *      un gasto con su reembolso, una meta, el catálogo y los precios.
 *   3. AISLAMIENTO Y PERMISOS. Otro usuario no puede ni previsualizar ni
 *      borrar, ni abriendo él la variable de la política; sin aal2 tampoco;
 *      anon no puede ejecutar; el DELETE directo sigue sin borrar nada.
 *   4. delete_account SIGUE FUNCIONANDO con la política redefinida, también
 *      con una posición sincronizada (su libro cae en cascada).
 *
 * Las fechas se piden con ::text: el driver pg convierte un `date` a medianoche
 * local y toISOString() daría el día anterior.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACION = "20261008100000_eliminar_fondos.sql";
const sqlMigracion = readFileSync(join(raiz, "supabase", "migrations", MIGRACION), "utf8");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
const n = (v) => (v === null || v === undefined ? null : Number(v));

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

/** Ejecuta `trabajo` con la sesión de `uid` (authenticated + aal) y vuelve a postgres. */
async function comoUsuario(uid, trabajo, aal = "aal2") {
  await q("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal }),
  ]);
  await q("set local role authenticated");
  try {
    return await trabajo();
  } finally {
    await q("reset role");
  }
}

/** Como `comoUsuario`, en un savepoint que se deshace pase lo que pase. Devuelve el error o null. */
async function intentoComo(uid, trabajo, aal = "aal2") {
  await q("savepoint intento");
  let error = null;
  try {
    await q("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal }),
    ]);
    await q("set local role authenticated");
    await trabajo();
  } catch (e) {
    error = e;
  }
  await q("rollback to savepoint intento");
  await q("release savepoint intento");
  return error;
}

const preview = (id) => q("select public.position_delete_preview($1) as p", [id]).then((r) => r[0].p);
const borrar = (id, nombre) => q("select public.delete_position($1, $2) as r", [id, nombre]).then((r) => r[0].r);
const saldos = () =>
  q("select account_id::text as id, balance_cents from public.v_account_balance").then(
    (rows) => new Map(rows.map((r) => [r.id, n(r.balance_cents)])),
  );
const patrimonio = () =>
  q("select coalesce(sum(net_worth_cents), 0) as c from public.v_net_worth").then((r) => n(r[0].c));

/** Lo que queda de una posición (como postgres, sin RLS: no fiarse de lo que deja ver). */
async function restos(positionId) {
  const [r] = await q(
    `select
       (select count(*) from public.investment_position where id = $1) as posiciones,
       (select count(*) from public.valuation where position_id = $1) as valoraciones,
       (select count(*) from public.position_unit_event where position_id = $1) as eventos,
       (select count(*) from public.transaction where position_id = $1) as aportaciones`,
    [positionId],
  );
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, n(v)]));
}
const todoCero = (r) => Object.values(r).every((v) => v === 0);

/** Recuentos globales de un usuario, menos lo que pertenece a la posición. */
async function huella(uid, positionId) {
  const [r] = await q(
    `select
       (select count(*) from public.investment_position where user_id = $1 and id <> $2) as posiciones,
       (select count(*) from public.valuation where user_id = $1 and position_id <> $2) as valoraciones,
       (select count(*) from public.position_unit_event where user_id = $1 and position_id <> $2) as eventos,
       (select count(*) from public.transaction where user_id = $1 and position_id is distinct from $2) as movimientos,
       (select count(*) from public.account where user_id = $1) as cuentas,
       (select count(*) from public.savings_goal where user_id = $1) as metas,
       (select count(*) from public.transaction where user_id = $1 and reimburses_id is not null) as reembolsos,
       (select count(*) from public.instrument) as instrumentos,
       (select count(*) from public.instrument_price) as precios,
       (select count(*) from public.fx_rate) as cambios`,
    [uid, positionId],
  );
  return JSON.stringify(Object.values(r).map(n));
}

/** El efecto esperado en cada cuenta, calculado aparte (en JS, por lados). */
async function efectosIndependientes(positionId) {
  const filas = await q(
    `select account_id::text as origen, to_account_id::text as destino, amount_cents
     from public.transaction
     where position_id = $1 and type = 'TRANSFER' and status <> 'DISCARDED'`,
    [positionId],
  );
  const m = new Map();
  for (const f of filas) {
    m.set(f.origen, (m.get(f.origen) ?? 0) + n(f.amount_cents));
    m.set(f.destino, (m.get(f.destino) ?? 0) - n(f.amount_cents));
  }
  return m;
}

// --------------------------------------------------------------------------
// 1. Datos reales
// --------------------------------------------------------------------------
async function datosReales(uid, etiqueta) {
  const posiciones = await comoUsuario(uid, () =>
    q("select id::text as id, name from public.investment_position order by created_at"),
  );
  if (posiciones.length === 0) {
    console.log(`  (${etiqueta}: sin posiciones)`);
    return;
  }

  let cuadran = 0;
  const fallos = [];
  let elegida = null;
  for (const pos of posiciones) {
    const p = await comoUsuario(uid, () => preview(pos.id));
    const [ind] = await q(
      `select
         (select count(*) from public.valuation where position_id = $1) as valoraciones,
         (select count(*) from public.position_unit_event where position_id = $1) as eventos,
         (select count(*) from public.transaction where position_id = $1 and status <> 'DISCARDED') as aportaciones,
         (select count(*) from public.transaction where position_id = $1 and status = 'DISCARDED') as descartadas,
         (select coalesce(sum(amount_cents), 0) from public.transaction
           where position_id = $1 and type = 'TRANSFER' and status <> 'DISCARDED') as aportado`,
      [pos.id],
    );
    const [vista] = await comoUsuario(uid, () =>
      q("select contributed_cents, value_cents from public.v_position_value where position_id = $1", [pos.id]),
    );
    const esperado = await efectosIndependientes(pos.id);
    const efectos = new Map(p.balance_effects.map((x) => [x.account_id, n(x.balance_delta_cents)]));
    const efectosIguales =
      esperado.size === efectos.size && [...esperado].every(([id, d]) => efectos.get(id) === d);
    const suma = p.balance_effects.reduce((s, x) => s + n(x.balance_delta_cents), 0);

    const iguales =
      p.name === pos.name &&
      n(p.valuations) === n(ind.valoraciones) &&
      n(p.unit_events) === n(ind.eventos) &&
      n(p.contributions.count) === n(ind.aportaciones) &&
      n(p.contributions.discarded) === n(ind.descartadas) &&
      n(p.contributions.cents) === n(ind.aportado) &&
      n(p.contributions.cents) === n(vista.contributed_cents) &&
      n(p.value_cents) === n(vista.value_cents ?? 0) &&
      efectosIguales &&
      suma === 0;
    if (iguales) cuadran++;
    else fallos.push(pos.id.slice(0, 8));
    if (!elegida || n(p.contributions.count) > n(elegida.p.contributions.count)) elegida = { pos, p };
  }
  check(
    `${etiqueta}: el preview cuadra con recuentos independientes y con v_position_value en ${posiciones.length} posiciones`,
    cuadran === posiciones.length,
    fallos.join(", "),
  );

  // Borrado de verdad, dentro de un savepoint que se deshace al momento.
  const { pos, p } = elegida;
  await q("savepoint real");
  try {
    const huellaAntes = await huella(uid, pos.id);
    const antes = await comoUsuario(uid, saldos);
    const pAntes = await comoUsuario(uid, patrimonio);
    const r = await comoUsuario(uid, () => borrar(pos.id, pos.name));
    const despues = await comoUsuario(uid, saldos);
    const pDespues = await comoUsuario(uid, patrimonio);

    const esperado = new Map(p.balance_effects.map((x) => [x.account_id, n(x.balance_delta_cents)]));
    const malas = [];
    for (const [id, saldo] of antes) {
      const delta = (despues.get(id) ?? NaN) - saldo;
      if (delta !== (esperado.get(id) ?? 0)) malas.push(id.slice(0, 8));
    }
    check(
      `${etiqueta}: al borrar una posición, el saldo de cada cuenta cambia exactamente lo que dijo el preview (${antes.size} cuentas)`,
      malas.length === 0,
      malas.join(", "),
    );
    check(
      `${etiqueta}: el patrimonio cambia exactamente net_worth_delta_cents`,
      pDespues - pAntes === n(p.net_worth_delta_cents),
    );
    check(
      `${etiqueta}: delete_position devuelve los recuentos del preview`,
      n(r.valuations) === n(p.valuations) &&
        n(r.unit_events) === n(p.unit_events) &&
        n(r.transactions) === n(p.contributions.count) + n(p.contributions.discarded) &&
        n(r.contributed_cents) === n(p.contributions.cents),
    );
    check(`${etiqueta}: no queda nada de la posición borrada`, todoCero(await restos(pos.id)));
    check(`${etiqueta}: nada más del usuario ni del catálogo cambia`, (await huella(uid, pos.id)) === huellaAntes);
    const [vivas] = await comoUsuario(uid, () =>
      q("select count(*) as n from public.v_position_market"),
    );
    check(`${etiqueta}: las vistas de inversiones siguen respondiendo`, n(vivas.n) === posiciones.length - 1);
  } finally {
    await q("rollback to savepoint real");
    await q("release savepoint real");
  }
}

// --------------------------------------------------------------------------
// 2. Datos sembrados
// --------------------------------------------------------------------------
const NOMBRE = "Fondo Índice Ñ";

async function sembrar() {
  const uid = (await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id"))[0].id;
  const cuenta = async (nombre, tipo, inicial) =>
    (
      await q(
        "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,$2,$3,$4) returning id::text as id",
        [uid, nombre, tipo, inicial],
      )
    )[0].id;
  const B1 = await cuenta("BBVA Nómina", "BANCO", 1000000);
  const B2 = await cuenta("Hucha", "AHORRO", 200000);
  const I = await cuenta("MyInvestor", "INVERSION", 0);

  const tx = async (campos) => {
    const cols = Object.keys(campos);
    const vals = Object.values(campos);
    const [r] = await q(
      `insert into public.transaction (user_id,${cols.join(",")}) values ($1,${cols.map((_, i) => `$${i + 2}`).join(",")}) returning id::text as id`,
      [uid, ...vals],
    );
    return r.id;
  };
  const dia = async (k) => (await q(`select (current_date - ${k})::text as d`))[0].d;
  const d30 = await dia(30);
  const d20 = await dia(20);
  const d10 = await dia(10);

  // Catálogo compartido: un instrumento con dos precios.
  const simbolo = `TST${Math.floor(Math.random() * 1e6)}.F`;
  const INS = (
    await q(
      "insert into public.instrument (kind,yahoo_symbol,name,currency) values ('FONDO',$1,'Fondo de prueba','EUR') returning id::text as id",
      [simbolo],
    )
  )[0].id;
  await q("insert into public.instrument_price (instrument_id,date,close) values ($1,$2,10.5),($1,$3,11.25)", [INS, d20, d10]);

  // P: el fondo a borrar. Q: otro fondo de la misma cuenta, que no se toca.
  const pos = async (nombre) =>
    (
      await q(
        "insert into public.investment_position (user_id,name,account_id,since) values ($1,$2,$3,(current_date - 60)) returning id::text as id",
        [uid, nombre, I],
      )
    )[0].id;
  const P = await pos(NOMBRE);
  const Q = await pos("Bonos");

  // Valoraciones de P (dos meses distintos) y de Q.
  await q("insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,current_date - 40,250000)", [uid, P]);
  await q("insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,$3,330000)", [uid, P, d10]);
  await q("insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,$3,21000)", [uid, Q, d10]);

  // Libro de participaciones de P: ALTA y AJUSTE.
  await q(
    "insert into public.position_unit_event (user_id,position_id,kind,date,instrument_id,units,contributed_cents) values ($1,$2,'ALTA',$3,$4,100,250000)",
    [uid, P, d20, INS],
  );
  await q("insert into public.position_unit_event (user_id,position_id,kind,date,units) values ($1,$2,'AJUSTE',$3,101.5)", [uid, P, d10]);

  // Aportaciones de P:
  //   B1→I 300000 con participaciones         (B1 +300000, I −300000)
  //   B2→I  50000                              (B2  +50000, I  −50000)
  //   B1→I   7000 DESCARTADA con participaciones (sin efecto; se borra)
  //   I→B1   2000 enlazada en sentido contrario (B1   −2000, I   +2000)
  // Esperado: B1 +298000, B2 +50000, I −348000. Aportado (vista) 352000.
  await tx({ type: "TRANSFER", amount_cents: 300000, occurred_on: d30, account_id: B1, to_account_id: I, position_id: P, position_units: "27.5" });
  await tx({ type: "TRANSFER", amount_cents: 50000, occurred_on: d20, account_id: B2, to_account_id: I, position_id: P });
  await tx({ type: "TRANSFER", amount_cents: 7000, occurred_on: d20, account_id: B1, to_account_id: I, position_id: P, position_units: "1.25", status: "DISCARDED" });
  await tx({ type: "TRANSFER", amount_cents: 2000, occurred_on: d10, account_id: I, to_account_id: B1, position_id: P });

  // Lo que NO se toca: aportación a Q, traspaso sin posición, gasto con su
  // reembolso, un ingreso, una meta.
  await tx({ type: "TRANSFER", amount_cents: 20000, occurred_on: d20, account_id: B1, to_account_id: I, position_id: Q });
  await tx({ type: "TRANSFER", amount_cents: 15000, occurred_on: d20, account_id: B1, to_account_id: I });
  const g = await tx({ type: "EXPENSE", amount_cents: 4000, occurred_on: d10, account_id: B1 });
  await tx({ type: "INCOME", amount_cents: 1500, occurred_on: d10, account_id: B2, reimburses_id: g, reimburses_target_type: "EXPENSE" });
  await tx({ type: "INCOME", amount_cents: 180000, occurred_on: d10, account_id: B1 });
  await q("insert into public.savings_goal (user_id,name,target_cents,account_id) values ($1,'Meta inversión',1000000,$2)", [uid, I]);

  return { uid, B1, B2, I, P, Q, INS };
}

async function pruebasSembradas(s) {
  console.log("\n— Datos sembrados —\n");
  const p = await comoUsuario(s.uid, () => preview(s.P));

  check("preview: nombre, cuenta y sincronizada", p.name === NOMBRE && p.account_id === s.I && p.account_name === "MyInvestor" && p.follows_instrument === true && p.archived === false, JSON.stringify({ n: p.name, a: p.account_name, f: p.follows_instrument }));
  check("preview: 2 valoraciones y 2 eventos del libro", n(p.valuations) === 2 && n(p.unit_events) === 2);
  check(
    "preview: 3 aportaciones que mueven saldo (352000) y 1 descartada",
    n(p.contributions.count) === 3 && n(p.contributions.cents) === 352000 && n(p.contributions.discarded) === 1,
    JSON.stringify(p.contributions),
  );
  const ef = Object.fromEntries(p.balance_effects.map((x) => [x.account_id, n(x.balance_delta_cents)]));
  check(
    "preview: efecto en saldos B1 +298000, B2 +50000, MyInvestor −348000 (y en ese orden)",
    p.balance_effects.length === 3 &&
      ef[s.B1] === 298000 && ef[s.B2] === 50000 && ef[s.I] === -348000 &&
      p.balance_effects[0].name === "BBVA Nómina" && p.balance_effects[2].name === "MyInvestor",
    JSON.stringify(p.balance_effects),
  );
  check("preview: los efectos suman cero (un traspaso solo mueve)", p.balance_effects.reduce((a, x) => a + n(x.balance_delta_cents), 0) === 0);
  const [v] = await comoUsuario(s.uid, () => q("select value_cents from public.v_position_value where position_id = $1", [s.P]));
  check("preview: value_cents = v_position_value", n(p.value_cents) === n(v.value_cents), `${p.value_cents} vs ${v.value_cents}`);
  check("preview: net_worth_delta = aportado − valor", n(p.net_worth_delta_cents) === 352000 - n(v.value_cents));
  const enteros = JSON.stringify(p).match(/"\w*cents":-?\d+(\.\d+)?/g) ?? [];
  check("preview: todo importe es entero", enteros.length > 0 && enteros.every((x) => !x.includes(".")));
  check("preview: no borra nada", JSON.stringify(await restos(s.P)) === JSON.stringify({ posiciones: 1, valoraciones: 2, eventos: 2, aportaciones: 4 }));

  // DELETE directo: la política sigue cerrada.
  const directo = await comoUsuario(s.uid, async () => (await client.query("delete from public.investment_position where id = $1", [s.P])).rowCount);
  check("DELETE directo sobre investment_position: 0 filas", directo === 0);

  // Nombre equivocado: error y nada borrado.
  for (const malo of ["fondo índice ñ", "Fondo Indice Ñ", "Fondo Índice N", "Fondo", "", null]) {
    const e = await intentoComo(s.uid, () => borrar(s.P, malo));
    check(`nombre ${JSON.stringify(malo)}: rechazado (22023)`, e?.code === "22023", e?.message);
  }
  check("tras los intentos fallidos no se ha borrado nada", (await restos(s.P)).aportaciones === 4 && (await restos(s.P)).posiciones === 1);
  const noExiste = await intentoComo(s.uid, () => borrar("00000000-0000-0000-0000-000000000000", "x"));
  check("posición inexistente: «no encontrada» (P0002)", noExiste?.code === "P0002", noExiste?.message);

  // El borrado de verdad, con espacios alrededor del nombre.
  const huellaAntes = await huella(s.uid, s.P);
  const antes = await comoUsuario(s.uid, saldos);
  const pAntes = await comoUsuario(s.uid, patrimonio);
  const [qAntes] = await comoUsuario(s.uid, () => q("select contributed_cents, value_cents from public.v_position_value where position_id = $1", [s.Q]));
  const r = await comoUsuario(s.uid, () => borrar(s.P, `  ${NOMBRE} `));
  check(
    "delete_position devuelve 4 movimientos, 352000 aportados, 2 valoraciones, 2 eventos",
    n(r.transactions) === 4 && n(r.contributed_cents) === 352000 && n(r.valuations) === 2 && n(r.unit_events) === 2,
    JSON.stringify(r),
  );
  const resto = await restos(s.P);
  check("no queda nada de la posición (fila, valoraciones, libro, aportaciones)", todoCero(resto), JSON.stringify(resto));

  const despues = await comoUsuario(s.uid, saldos);
  const delta = (id) => despues.get(id) - antes.get(id);
  check("saldo de BBVA Nómina: +298000, lo que dijo el preview", delta(s.B1) === 298000, String(delta(s.B1)));
  check("saldo de Hucha: +50000", delta(s.B2) === 50000, String(delta(s.B2)));
  check("saldo de MyInvestor: −348000", delta(s.I) === -348000, String(delta(s.I)));
  const pDespues = await comoUsuario(s.uid, patrimonio);
  check("patrimonio: cambia exactamente net_worth_delta_cents", pDespues - pAntes === n(p.net_worth_delta_cents), `${pDespues - pAntes} vs ${p.net_worth_delta_cents}`);

  check("NADA más cambia (otra posición y su historia, movimientos ajenos, reembolso, meta, catálogo, precios, cambios)", (await huella(s.uid, s.P)) === huellaAntes);
  const [qDespues] = await comoUsuario(s.uid, () => q("select contributed_cents, value_cents from public.v_position_value where position_id = $1", [s.Q]));
  check("la otra posición vale y aporta lo mismo", n(qDespues.contributed_cents) === n(qAntes.contributed_cents) && n(qDespues.value_cents) === n(qAntes.value_cents));
  const [cat] = await q("select (select count(*) from public.instrument where id = $1) as i, (select count(*) from public.instrument_price where instrument_id = $1) as p", [s.INS]);
  check("el instrumento y sus precios siguen en el catálogo", n(cat.i) === 1 && n(cat.p) === 2);
  const [huerfanas] = await q("select count(*) as n from public.transaction where position_id is null and position_units is not null");
  check("ninguna fila con participaciones y sin posición", n(huerfanas.n) === 0);

  const [guc] = await q("select coalesce(current_setting('cartera.posicion_a_borrar', true), '') as v");
  check("la variable que abre la política queda vacía al terminar", guc.v === "");
  const directoQ = await comoUsuario(s.uid, async () => (await client.query("delete from public.investment_position where id = $1", [s.Q])).rowCount);
  check("tras delete_position, un DELETE directo sobre otra posición sigue sin borrar nada", directoQ === 0);

  const [rend] = await comoUsuario(s.uid, () => q("select count(*) as n from public.v_position_market"));
  check("v_position_market sigue respondiendo (1 posición)", n(rend.n) === 1);
}

// --------------------------------------------------------------------------
// 3. Aislamiento y permisos
// --------------------------------------------------------------------------
async function aislamiento() {
  console.log("\n— Aislamiento y permisos —\n");
  const s = await sembrar();
  const otro = (await q("insert into auth.users (id) values (gen_random_uuid()) returning id::text as id"))[0].id;

  const e1 = await intentoComo(otro, () => preview(s.P));
  check("otro usuario no puede previsualizar la posición ajena (P0002)", e1?.code === "P0002", e1?.message);
  const e2 = await intentoComo(otro, () => borrar(s.P, NOMBRE));
  check("otro usuario no puede borrarla, ni con el nombre correcto (P0002)", e2?.code === "P0002", e2?.message);
  const abierto = await comoUsuario(otro, async () => {
    await q("select set_config('cartera.posicion_a_borrar', $1, true)", [s.P]);
    const filas = (await client.query("delete from public.investment_position where id = $1", [s.P])).rowCount;
    await q("select set_config('cartera.posicion_a_borrar', '', true)");
    return filas;
  });
  check("otro usuario con la variable abierta a mano sigue sin poder borrarla", abierto === 0 && (await restos(s.P)).posiciones === 1);

  // Con el 2FA opcional (20261019090000) solo se exige aal2 a quien tiene un
  // factor verificado: se le da uno (con la regla anterior da igual).
  await q(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (gen_random_uuid(), $1, 'prueba', 'totp', 'verified', now(), now())`,
    [s.uid],
  );
  const e3 = await intentoComo(s.uid, () => preview(s.P), "aal1");
  check("sesión sin aal2: no puede previsualizar (42501)", e3?.code === "42501", e3?.message);
  const e4 = await intentoComo(s.uid, () => borrar(s.P, NOMBRE), "aal1");
  check("sesión sin aal2: no puede borrar (42501)", e4?.code === "42501", e4?.message);
  check("nada borrado tras los intentos ajenos", JSON.stringify(await restos(s.P)) === JSON.stringify({ posiciones: 1, valoraciones: 2, eventos: 2, aportaciones: 4 }));

  for (const f of ["public.position_delete_preview(uuid)", "public.delete_position(uuid, text)"]) {
    const [pr] = await q(
      "select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth, has_function_privilege('public', $1, 'execute') as pub",
      [f],
    );
    check(`${f}: authenticated sí, anon y public no`, pr.auth === true && pr.anon === false && pr.pub === false);
  }
  const [cfg] = await q(
    `select count(*) as total,
            count(*) filter (where p.prosecdef) as definer,
            count(*) filter (where not coalesce(p.proconfig, '{}') @> array['search_path=""']) as sin_path
     from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname in ('position_delete_preview', 'delete_position')`,
  );
  check("las dos son security invoker y con search_path = ''", n(cfg.total) === 2 && n(cfg.definer) === 0 && n(cfg.sin_path) === 0, JSON.stringify(cfg));
}

// --------------------------------------------------------------------------
// 4. delete_account sigue funcionando con la política redefinida
// --------------------------------------------------------------------------
async function eliminarCuentaSigue() {
  console.log("\n— delete_account con la política nueva —\n");
  const s = await sembrar();
  const r = await comoUsuario(s.uid, () =>
    q("select public.delete_account($1, $2) as r", [s.I, "MyInvestor"]).then((x) => x[0].r),
  );
  check("delete_account borra la cuenta de inversión con sus 2 posiciones y 3 valoraciones", n(r.positions) === 2 && n(r.valuations) === 3, JSON.stringify(r));
  const [quedan] = await q(
    `select (select count(*) from public.investment_position where account_id = $1) as pos,
            (select count(*) from public.position_unit_event where position_id = $2) as libro,
            (select count(*) from public.account where id = $1) as cuenta`,
    [s.I, s.P],
  );
  check("…y el libro de participaciones cae en cascada", n(quedan.pos) === 0 && n(quedan.libro) === 0 && n(quedan.cuenta) === 0, JSON.stringify(quedan));
  const [guc] = await q("select coalesce(current_setting('cartera.cuenta_a_borrar', true), '') as v");
  check("la variable de la cuenta queda vacía", guc.v === "");
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const [ya] = await q("select count(*) as n from pg_proc where proname = 'delete_position'");
    if (n(ya.n) === 0) {
      await client.query(sqlMigracion);
      console.log(`(migración ${MIGRACION} aplicada dentro de la transacción)`);
    } else {
      console.log(`(migración ${MIGRACION} ya presente en la base)`);
    }

    const reales = await q("select u.id::text as id from auth.users u order by u.created_at");
    console.log(`\n— Datos reales: ${reales.length} usuarios (solo se informa si cuadra) —\n`);
    for (const [i, u] of reales.entries()) await datosReales(u.id, `real ${i + 1}`);

    const s = await sembrar();
    await pruebasSembradas(s);
    await aislamiento();
    await eliminarCuentaSigue();
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
