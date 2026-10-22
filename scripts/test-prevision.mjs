/**
 * Prueba «Previsión de fin de mes»: month_forecast y category_forecast.
 *
 *   node --env-file=.env.local scripts/test-prevision.mjs
 *
 * Lo que se demuestra:
 *   · la previsión es la suma de sus tres piezas: gastado + suscripciones que
 *     faltan + discrecional extrapolado, y esa suma cuadra con `prevision_cents`
 *   · lo recurrente NO entra en el ritmo extrapolado (no se cuenta dos veces)
 *   · un cargo de suscripción REEMBOLSADO se descuenta en neto: si no, el ritmo
 *     discrecional saldría corto (el fix 5a). Es el caso que distingue la versión
 *     buena de la ingenua
 *   · un mes ya cerrado tiene por previsión su total (extrapolación y futuro a 0)
 *   · category_forecast proyecta por categoría y marca la que se va a rebasar
 *   · un usuario no ve ni un céntimo de otro
 *
 * Las fechas se piden a la base con ::text. El driver convierte un `date` a
 * medianoche local y toISOString() devolvería el día anterior.
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

// El mismo redondeo que Postgres para enteros positivos: mitad hacia arriba.
const round = (n) => Math.round(n);

async function comoUsuario(uid, trabajo) {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    return await trabajo();
  } finally {
    await client.query("commit");
  }
}

const q = (sql, params) => client.query(sql, params).then((r) => r.rows);

const usuarios = [];
async function nuevoUsuario(prefijo) {
  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      email: `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@cartera.local`,
      email_confirm: true,
    }),
  });
  const uid = (await alta.json()).id;
  usuarios.push(uid);
  return uid;
}

// Atajos de fecha, siempre relativos al mes en curso.
const PRIMERO = "date_trunc('month', current_date)::date";
const FIN_MES = "(date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date";
const MES_QUE_VIENE = "(date_trunc('month', current_date) + interval '1 month')::date";

async function cuentaYCategoria(uid) {
  const banco = (
    await q("insert into public.account (user_id,name,type) values ($1,'Banco','BANCO') returning id", [
      uid,
    ])
  )[0].id;
  const cat = (
    await q(
      "insert into public.category (user_id,name,type,color,icon) values ($1,'Compras','EXPENSE','#7f6a45','cart') returning id",
      [uid],
    )
  )[0].id;
  return { banco, cat };
}

const gasto = (uid, banco, cat, cents, fechaSql, extra = "") =>
  q(
    `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status${extra ? "," + extra.cols : ""})
     values ($1,'EXPENSE',$2,'x',${fechaSql},$3,$4,'EXPENSE',${extra ? extra.source : "'MANUAL'"},'CONFIRMED'${extra ? "," + extra.vals : ""}) returning id`,
    [uid, cents, banco, cat],
  ).then((r) => r[0].id);

async function main() {
  await client.connect();

  try {
    // =====================================================================
    // A · Mes en curso: descomposición y el caso de suscripción reembolsada
    // =====================================================================
    console.log("— Mes en curso: descomposición y reembolso de suscripción —\n");

    const uidA = await nuevoUsuario("prev");
    const { banco, cat } = await cuentaYCategoria(uidA);

    // subA: ya cobrada este mes (día 1), y con su próximo cargo el mes que viene
    // —así NO entra en «lo que falta»—. subB: pendiente, cobra a fin de mes.
    const subA = (
      await q(
        `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,category_id,category_type,account_id)
         values ($1,'Netflix',5000,'MENSUAL',${MES_QUE_VIENE},$2,'EXPENSE',$3) returning id`,
        [uidA, cat, banco],
      )
    )[0].id;
    // subB solo necesita EXISTIR: la función la lee de la tabla, aquí no hace
    // falta su id.
    await q(
      `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,category_id,category_type,account_id)
       values ($1,'Gimnasio',5000,'MENSUAL',${FIN_MES},$2,'EXPENSE',$3)`,
      [uidA, cat, banco],
    );

    // Cargo recurrente de subA ya realizado (día 1).
    const cargoA = await gasto(uidA, banco, cat, 5000, PRIMERO, {
      cols: "subscription_id",
      source: "'RECURRING'",
      vals: `'${subA}'`,
    });
    // Gasto discrecional (día 1).
    await gasto(uidA, banco, cat, 3000, PRIMERO);
    // Un reembolso de 2000 del cargo de subA: abarata lo RECURRENTE, no lo
    // discrecional. Sin el neto, el ritmo saldría corto.
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,reimburses_id,reimburses_target_type,source,status)
       values ($1,'INCOME',2000,'Devolucion',${PRIMERO},$2,$3,'EXPENSE',$4,'EXPENSE','MANUAL','CONFIRMED')`,
      [uidA, banco, cat, cargoA],
    );

    const [f] = await comoUsuario(uidA, () =>
      q(`select * from public.month_forecast(${PRIMERO})`),
    );

    const dt = f.dias_transcurridos;
    const dr = f.dias_restantes;
    const discrecional = 3000; // 5000 recurrente + 3000 disc − 2000 reemb − (5000−2000) recurrente_neto
    const extrapoladoEsperado = dt > 0 ? round((discrecional * dr) / dt) : 0;

    check(
      "Lo gastado hasta hoy es el neto (5000+3000−2000)",
      Number(f.gasto_real_cents) === 6000,
      `gasto_real ${f.gasto_real_cents}, se esperaba 6000`,
    );
    check(
      "Las suscripciones que faltan son solo la pendiente (subB=5000)",
      Number(f.suscripciones_cents) === 5000,
      `suscripciones ${f.suscripciones_cents}, se esperaba 5000`,
    );
    check(
      "Un reembolso de suscripcion no encoge el ritmo discrecional (fix 5a)",
      Number(f.extrapolado_cents) === extrapoladoEsperado,
      `extrapolado ${f.extrapolado_cents}, se esperaba ${extrapoladoEsperado}` +
        (dr === 0 ? " · OJO: hoy es fin de mes, dr=0, no discrimina 5a" : ""),
    );
    check(
      "La prevision es la suma de las tres piezas",
      Number(f.prevision_cents) ===
        Number(f.gasto_real_cents) + Number(f.suscripciones_cents) + Number(f.extrapolado_cents),
      `prevision ${f.prevision_cents} vs suma ${
        Number(f.gasto_real_cents) + Number(f.suscripciones_cents) + Number(f.extrapolado_cents)
      }`,
    );
    check(
      "El reembolso no cuenta como ingreso real",
      Number(f.ingresos_real_cents) === 0,
      `ingresos_real ${f.ingresos_real_cents}, se esperaba 0`,
    );

    // =====================================================================
    // B · category_forecast: proyección por categoría y aviso de rebase
    // =====================================================================
    console.log("\n— Por categoria: proyeccion y aviso de rebase —\n");

    // Un tope bajo: con prevision = 11000 + extrapolado, se rebasa seguro.
    await q(
      "insert into public.budget (user_id,category_id,monthly_cap_cents) values ($1,$2,10000)",
      [uidA, cat],
    );

    const cats = await comoUsuario(uidA, () =>
      q(`select * from public.category_forecast(${PRIMERO})`),
    );
    const compras = cats.find((c) => c.category_id === cat);

    check("Devuelve la categoria con limite", !!compras, `filas: ${cats.length}`);
    check(
      "El gastado de la categoria cuadra con el del mes (6000)",
      compras && Number(compras.gastado_cents) === 6000,
      compras ? `gastado ${compras.gastado_cents}` : "sin fila",
    );
    check(
      "La prevision de la unica categoria == prevision global del mes",
      compras && Number(compras.prevision_cents) === Number(f.prevision_cents),
      compras ? `cat ${compras.prevision_cents} vs mes ${f.prevision_cents}` : "sin fila",
    );
    check(
      "Marca que se va a rebasar el limite",
      compras && compras.rebasa === true && Number(compras.prevision_cents) > 10000,
      compras ? `rebasa ${compras.rebasa}, prevision ${compras.prevision_cents}` : "sin fila",
    );

    // =====================================================================
    // C · Un mes ya cerrado: la prevision es su total
    // =====================================================================
    console.log("\n— Un mes ya cerrado —\n");

    const uidC = await nuevoUsuario("prev-pasado");
    const cc = await cuentaYCategoria(uidC);
    // Un gasto en julio (mes cerrado; hoy es septiembre en los datos reales).
    await q(
      `insert into public.transaction (user_id,type,amount_cents,description,occurred_on,account_id,category_id,category_type,source,status)
       values ($1,'EXPENSE',4000,'Julio',date '2026-07-10',$2,$3,'EXPENSE','MANUAL','CONFIRMED')`,
      [uidC, cc.banco, cc.cat],
    );
    const [pasado] = await comoUsuario(uidC, () =>
      q("select * from public.month_forecast(date '2026-07-01')"),
    );
    check(
      "Un mes cerrado no extrapola ni suma futuro",
      Number(pasado.extrapolado_cents) === 0 &&
        Number(pasado.suscripciones_cents) === 0 &&
        Number(pasado.dias_restantes) === 0,
      `extrap ${pasado.extrapolado_cents} · susc ${pasado.suscripciones_cents} · dr ${pasado.dias_restantes}`,
    );
    check(
      "La prevision de un mes cerrado es su total real",
      Number(pasado.prevision_cents) === 4000 && Number(pasado.gasto_real_cents) === 4000,
      `prevision ${pasado.prevision_cents} · gasto_real ${pasado.gasto_real_cents}`,
    );

    // =====================================================================
    // D · Aislamiento entre usuarios
    // =====================================================================
    console.log("\n— Aislamiento —\n");

    const uidD = await nuevoUsuario("prev-otro");
    const [ajeno] = await comoUsuario(uidD, () =>
      q(`select * from public.month_forecast(${PRIMERO})`),
    );
    const catsAjeno = await comoUsuario(uidD, () =>
      q(`select * from public.category_forecast(${PRIMERO})`),
    );
    check(
      "Otro usuario no ve ni un centimo de este",
      Number(ajeno.gasto_real_cents) === 0 &&
        Number(ajeno.suscripciones_cents) === 0 &&
        Number(ajeno.prevision_cents) === 0 &&
        catsAjeno.length === 0,
      `gasto ${ajeno.gasto_real_cents} · susc ${ajeno.suscripciones_cents} · cats ${catsAjeno.length}`,
    );
  } finally {
    for (const uid of usuarios) {
      await fetch(`${API}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: h }).catch(
        () => {},
      );
    }
    await client.end();
  }

  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  for (const uid of usuarios) {
    await fetch(`${API}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: h }).catch(
      () => {},
    );
  }
  await client.end().catch(() => {});
  process.exit(2);
});
