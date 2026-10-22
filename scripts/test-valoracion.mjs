/**
 * Prueba la valoración por porcentaje contra la base: que la base sobre la que
 * se aplica un «+5 %» (src/lib/valoracion.ts) es la misma cifra que da la vista
 * del valor de una posición (v_position_value, criterio de
 * 20261005090300_valor_de_posicion_con_aportes_posteriores.sql).
 *
 *   node --env-file=.env.local scripts/test-valoracion.mjs
 *
 * Importa el módulo TypeScript tal cual (Node quita los tipos): se prueban las
 * MISMAS funciones que usan la server action y la vista previa, no una copia.
 *
 * Dos partes:
 *   · un usuario de prueba con un caso construido a mano (se borra al acabar)
 *   · los datos reales, solo lectura: para cada posición activa sin valoración
 *     en el mes en curso, la base de hoy tiene que ser su value_cents. No se
 *     imprime ningún importe real, solo el resultado de la comparación.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { applyPercent, baseDeValoracion, parsePercent } from "../src/lib/valoracion.ts";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });

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

/** Lo que leen la página y la server action, con fechas como texto (::text). */
async function datosPosicion(posId) {
  const valoraciones = (
    await q(
      "select date::text as date, value_cents::bigint as value_cents from public.valuation where position_id = $1",
      [posId],
    )
  ).map((v) => ({ date: v.date, value_cents: Number(v.value_cents) }));
  const aportaciones = (
    await q(
      `select occurred_on::text as occurred_on, amount_cents::bigint as amount_cents
         from public.transaction
        where position_id = $1 and type = 'TRANSFER' and status <> 'DISCARDED'`,
      [posId],
    )
  ).map((a) => ({ occurred_on: a.occurred_on, amount_cents: Number(a.amount_cents) }));
  return { valoraciones, aportaciones };
}

async function main() {
  await client.connect();
  const [{ hoy, fin_mes_anterior, fin_hace_dos, inicio_mes }] = await q(`
    select current_date::text as hoy,
           (date_trunc('month', current_date) - interval '1 day')::date::text as fin_mes_anterior,
           (date_trunc('month', current_date) - interval '1 month' - interval '1 day')::date::text as fin_hace_dos,
           date_trunc('month', current_date)::date::text as inicio_mes`);

  const alta = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email: `valoracion-${Date.now()}@cartera.local`, email_confirm: true }),
  });
  const uid = (await alta.json()).id;

  try {
    console.log("— Caso construido —\n");

    const banco = (
      await q(
        "insert into public.account (user_id,name,type,initial_balance_cents) values ($1,'Nomina','BANCO',1000000) returning id",
        [uid],
      )
    )[0].id;
    const inver = (
      await q(
        "insert into public.account (user_id,name,type) values ($1,'Bróker','INVERSION') returning id",
        [uid],
      )
    )[0].id;
    const pos = (
      await q(
        "insert into public.investment_position (user_id,name,account_id,since) values ($1,'Indexado',$2,$3) returning id",
        [uid, inver, fin_hace_dos],
      )
    )[0].id;

    const aportar = (cents, fecha, status = "CONFIRMED") =>
      q(
        "insert into public.transaction (user_id,type,amount_cents,occurred_on,account_id,to_account_id,position_id,status) values ($1,'TRANSFER',$2,$3,$4,$5,$6,$7)",
        [uid, cents, fecha, banco, inver, pos, status],
      );

    // Cierre de hace dos meses 950 €, cierre del mes pasado 1.000 €.
    await q(
      "insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,$3,95000),($1,$2,$4,100000)",
      [uid, pos, fin_hace_dos, fin_mes_anterior],
    );
    await aportar(80000, fin_hace_dos); // dentro de la valoración de hace dos meses
    await aportar(2000, fin_mes_anterior); // mismo día que el cierre: incluida en él
    await aportar(50000, inicio_mes); // después del cierre: suma al coste
    await aportar(9900, inicio_mes, "DISCARDED"); // descartada: no cuenta

    const vista = async () =>
      Number(
        (
          await comoUsuario(uid, () =>
            q("select value_cents from public.v_position_value where position_id = $1", [pos]),
          )
        )[0].value_cents,
      );

    let d = await datosPosicion(pos);
    let base = baseDeValoracion(hoy, d.valoraciones, d.aportaciones);
    check(
      "La base es el cierre anterior más lo aportado después (1.000 + 500)",
      base?.base === 150000 && base.valorPrevio === 100000 && base.aportado === 50000,
      JSON.stringify(base),
    );
    const enVista = await vista();
    check(
      "Coincide con el valor de la posición en v_position_value",
      base?.base === enVista,
      `base ${base?.base} · vista ${enVista}`,
    );

    const nuevo = applyPercent(base.base, parsePercent("5"));
    check("+5 % sobre lo invertido: 1.575,00 €", nuevo === 157500, String(nuevo));

    // Se guarda la valoración de este mes (como haría la server action) y se
    // vuelve a valorar: la base no puede ser la que se acaba de sustituir.
    await q(
      "insert into public.valuation (user_id,position_id,date,value_cents) values ($1,$2,$3,$4)",
      [uid, pos, hoy, nuevo],
    );
    d = await datosPosicion(pos);
    const otraVez = baseDeValoracion(hoy, d.valoraciones, d.aportaciones);
    check(
      "Repetir la valoración del mes parte del mismo cierre (no del 5 % de antes)",
      otraVez?.base === 150000 && applyPercent(otraVez.base, parsePercent("5")) === nuevo,
      JSON.stringify(otraVez),
    );
    check(
      "Y la vista ya enseña la valoración guardada",
      (await vista()) === nuevo,
      String(await vista()),
    );

    // Valorar el mes pasado: parte del cierre de hace dos meses.
    const pasado = baseDeValoracion(fin_mes_anterior, d.valoraciones, d.aportaciones);
    check(
      "Valorar el mes pasado parte del cierre anterior a él (950 + 20)",
      pasado?.base === 97000,
      JSON.stringify(pasado),
    );

    check(
      "El empate de medio céntimo sube: 50,00 € + 0,29 % = 50,15 €",
      applyPercent(5000, parsePercent("0,29")) === 5015,
    );

    console.log("\n— Datos reales (solo lectura) —\n");

    const posiciones = await q(`
      select v.position_id, v.value_cents::bigint as value_cents, v.valued_on::text as valued_on
        from public.v_position_value v
       where not v.archived and v.user_id <> $1`, [uid]);

    let comparadas = 0;
    let distintas = 0;
    let sinBase = 0;
    let conValoracionDelMes = 0;
    for (const p of posiciones) {
      if (p.valued_on && p.valued_on >= inicio_mes) {
        // Ya valorada este mes: su base es el cierre ANTERIOR, que no tiene por
        // qué coincidir con el valor de hoy. Se cuenta, no se compara.
        conValoracionDelMes++;
        continue;
      }
      const datos = await datosPosicion(p.position_id);
      const b = baseDeValoracion(hoy, datos.valoraciones, datos.aportaciones);
      if (b === null) {
        sinBase++;
        continue;
      }
      comparadas++;
      if (b.base !== Number(p.value_cents)) distintas++;
    }
    console.log(
      `        ${posiciones.length} posiciones activas: ${comparadas} comparadas, ` +
        `${conValoracionDelMes} ya valoradas este mes, ${sinBase} sin valoración de un mes anterior`,
    );
    check(
      "En cada posición real comparable, la base de hoy es su valor en v_position_value",
      distintas === 0,
      `${distintas} posiciones no cuadran`,
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
