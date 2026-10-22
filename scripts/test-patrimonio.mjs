/**
 * Prueba el patrimonio y el rendimiento de las inversiones.
 *
 * Los dos invariantes que no pueden fallar:
 *   · una revalorización sube el patrimonio pero NO es un ingreso
 *   · las aportaciones se descuentan antes de calcular el rendimiento
 *
 *   node --env-file=.env.local scripts/test-patrimonio.mjs
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

async function main() {
  await client.connect();
  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email: `patri-${Date.now()}@cartera.local`, email_confirm: true }),
  });
  const uid = (await alta.json()).id;

  try {
    // Cuenta con 1.000 €, cuenta de inversión a 0, y una tarjeta con 200 € de deuda.
    const banco = (
      await q(
        "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,'Nomina','BANCO',100000) returning id",
        [uid],
      )
    )[0].id;
    const inver = (
      await q(
        "insert into public.account (user_id,name,type) values ($1,'Indexa','INVERSION') returning id",
        [uid],
      )
    )[0].id;
    await q(
      "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,'Visa','BANCO',-20000)",
      [uid],
    );

    console.log("— Patrimonio —\n");

    let pn = (await comoUsuario(uid, () => q("select * from public.v_net_worth")))[0];
    check(
      "Suma las cuentas, incluida la tarjeta en negativo",
      Number(pn.net_worth_cents) === 80000,
      `${pn.net_worth_cents}, se esperaba 80000 (1000 menos 200)`,
    );

    // Traspaso de 500 € del banco a la cuenta de inversión.
    await q(
      "insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,to_account_id) values ($1,'TRANSFER',50000,current_date,$2,$3)",
      [uid, banco, inver],
    );

    pn = (await comoUsuario(uid, () => q("select * from public.v_net_worth")))[0];
    check(
      "Un traspaso no cambia el patrimonio: mueve, no crea",
      Number(pn.net_worth_cents) === 80000,
      `${pn.net_worth_cents}`,
    );
    check(
      "Ese dinero figura como no desplegado",
      Number(pn.idle_cents) === 50000,
      `sin desplegar ${pn.idle_cents}`,
    );

    // Posición con 400 € aportados.
    const pos = (
      await q(
        "insert into public.investment_position (user_id,name,account_id) values ($1,'MSCI World',$2) returning id",
        [uid, inver],
      )
    )[0].id;
    await q(
      "insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,to_account_id,position_id) values ($1,'TRANSFER',40000,current_date,$2,$3,$4)",
      [uid, banco, inver, pos],
    );

    pn = (await comoUsuario(uid, () => q("select * from public.v_net_worth")))[0];
    check(
      "Aportar a una posición tampoco cambia el patrimonio",
      Number(pn.net_worth_cents) === 80000,
      `${pn.net_worth_cents} · invertido ${pn.invested_cents} · sin desplegar ${pn.idle_cents}`,
    );
    check(
      "No hay doble conteo entre la posicion y su cuenta",
      Number(pn.invested_cents) + Number(pn.idle_cents) === 90000,
      `invertido ${pn.invested_cents} + sin desplegar ${pn.idle_cents}, se esperaba 90000`,
    );

    console.log("\n— Revalorización —\n");

    // La posición sube de 400 a 460 sin que entre un euro nuevo.
    await q(
      "insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,current_date,46000)",
      [uid, pos],
    );

    pn = (await comoUsuario(uid, () => q("select * from public.v_net_worth")))[0];
    check(
      "Una revalorizacion SI sube el patrimonio",
      Number(pn.net_worth_cents) === 86000,
      `${pn.net_worth_cents}, se esperaba 86000`,
    );

    // La fecha SIEMPRE se pide a la base, nunca a `new Date()`.
    // `new Date().toISOString()` da la fecha en UTC, y en Madrid en verano son dos
    // horas menos: entre las 00:00 y las 02:00 devolvería el dia (y el mes) anterior
    // y la prueba fallaria sola segun la hora a la que se lance. La base es la que
    // evalua `current_date` en el SQL que estamos probando.
    const hoy = (await q("select current_date::text as d"))[0].d;
    const mes = hoy.slice(0, 7) + "-01";
    const resumen = await comoUsuario(uid, () =>
      q("select * from public.v_month_summary where period_month = $1", [mes]),
    );
    check(
      "Pero NO cuenta como ingreso del mes",
      resumen.length === 0 || Number(resumen[0].income_cents) === 0,
      `ingresos ${resumen[0]?.income_cents}`,
    );

    console.log("\n— Rendimiento —\n");

    const desde = "2000-01-01";
    const hasta = hoy;
    const r = (
      await comoUsuario(uid, () => q("select * from public.position_return($1,$2)", [desde, hasta]))
    )[0];
    check(
      "Descuenta la aportacion antes de calcular la ganancia",
      Number(r.gain_cents) === 6000,
      `ganancia ${r.gain_cents}, se esperaba 6000 (460 menos 0 menos 400)`,
    );

    // Segunda posición: mucho capital, poca subida.
    const pos2 = (
      await q(
        "insert into public.investment_position (user_id,name,account_id) values ($1,'Bonos',$2) returning id",
        [uid, inver],
      )
    )[0].id;
    await q(
      "insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,to_account_id,position_id) values ($1,'TRANSFER',1000000,current_date,$2,$3,$4)",
      [uid, banco, inver, pos2],
    );
    await q(
      "insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,current_date,1010000)",
      [uid, pos2],
    );

    const cartera = (
      await comoUsuario(uid, () => q("select * from public.portfolio_return($1,$2)", [desde, hasta]))
    )[0];
    const mediaSimple = ((6000 / 40000 + 10000 / 1000000) / 2) * 100;
    check(
      "El total pondera por capital, no promedia porcentajes",
      Math.abs(Number(cartera.return_pct) - mediaSimple) > 1,
      `total ${cartera.return_pct}% frente a media simple ${mediaSimple.toFixed(2)}%. Deben diferir.`,
    );
    check(
      "Y suma bien las ganancias",
      Number(cartera.gain_cents) === 16000,
      `${cartera.gain_cents}, se esperaba 16000`,
    );

    // Regresión: aportaste ANTES del periodo y la primera valoración es
    // posterior. Sin valor de partida el denominador se iba a cero y el
    // rendimiento salía nulo, así que la pantalla decía que hacían falta dos
    // valoraciones teniendo siete. El coste hace de punto de partida.
    const posAntiguo = (
      await q(
        "insert into public.investment_position (user_id,name,account_id) values ($1,'Fondo antiguo',$2) returning id",
        [uid, inver],
      )
    )[0].id;
    await q(
      "insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,to_account_id,position_id) values ($1,'TRANSFER',100000,current_date - 60,$2,$3,$4)",
      [uid, banco, inver, posAntiguo],
    );
    await q(
      "insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,current_date,110000)",
      [uid, posAntiguo],
    );

    const anio = (
      await comoUsuario(uid, () =>
        q("select * from public.position_return((current_date - 30)::date, current_date)"),
      )
    ).find((x) => x.name === "Fondo antiguo");
    check(
      "Sin valoracion previa, el coste hace de punto de partida",
      anio && anio.return_pct !== null,
      "el rendimiento salio nulo teniendo valoracion y aportacion",
    );
    check(
      "Y ese rendimiento es el real, no una ganancia inventada",
      anio && Number(anio.return_pct) === 10 && Number(anio.gain_cents) === 10000,
      `${anio?.return_pct}% y ${anio?.gain_cents} cents, se esperaba 10% y 10000`,
    );

    console.log("\n— Aviso de valoración —\n");

    const pendientes = await comoUsuario(uid, () => q("select * from public.v_pending_valuation"));
    check(
      "No avisa de posiciones ya valoradas este mes",
      pendientes.length === 0,
      JSON.stringify(pendientes),
    );

    const pos3 = (
      await q(
        "insert into public.investment_position (user_id,name,account_id) values ($1,'Sin valorar',$2) returning id",
        [uid, inver],
      )
    )[0].id;
    const pend2 = await comoUsuario(uid, () => q("select * from public.v_pending_valuation"));
    check(
      "Avisa de una posicion nueva sin valorar",
      pend2.length === 1 && pend2[0].position_id === pos3,
      JSON.stringify(pend2),
    );

    console.log("\n— Evolución —\n");

    const hist = await comoUsuario(uid, () => q("select * from public.net_worth_history(3)"));
    check("Devuelve un punto por mes", hist.length === 3, `${hist.length} puntos`);

    const actual = (await comoUsuario(uid, () => q("select * from public.v_net_worth")))[0];
    check(
      "El ultimo mes del historico coincide con el patrimonio actual",
      Number(hist[hist.length - 1].net_worth_cents) === Number(actual.net_worth_cents),
      `historico ${hist[hist.length - 1]?.net_worth_cents} · actual ${actual.net_worth_cents}`,
    );
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
