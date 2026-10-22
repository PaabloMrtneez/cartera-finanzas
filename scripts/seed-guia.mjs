/**
 * Datos de demostración para las capturas de la guía de uso (docs/guia).
 *
 *   node --env-file=.env.local scripts/seed-demo.mjs fase3@cartera.local
 *   node --env-file=.env.local scripts/seed-guia.mjs fase3@cartera.local
 *
 * Va DESPUÉS de seed-demo.mjs, que borra todo lo del usuario y deja tres
 * cuentas, dos posiciones de inversión y las categorías. Esto añade encima seis
 * meses de vida verosímil para que cada pantalla tenga algo que enseñar:
 * nómina, alquiler, súper, cafés, restaurantes, suscripciones con su historial,
 * un préstamo (creado con la MISMA función que usa la app), límites a distintos
 * niveles —uno pasado, otro cerca—, metas, reglas de comercio, un reembolso,
 * traspasos al ahorro y pagos del Atajo, tres de ellos pendientes.
 *
 * Las mismas salvaguardas que seed-demo.mjs: solo usuarios @cartera.local, todo
 * en una transacción y el mismo cerrojo consultivo, para no cruzarse con una
 * corrida del e2e sobre el mismo usuario. Como seed-demo.mjs borra en cascada
 * todo lo que esto crea, el siguiente e2e empieza limpio igual que siempre.
 *
 * Todo importe, en céntimos enteros. Las fechas, relativas a private.hoy()
 * (Europe/Madrid), así que las capturas siempre parecen «de este mes».
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email.endsWith("@cartera.local")) {
  console.error("Uso: node --env-file=.env.local scripts/seed-guia.mjs <usuario@cartera.local>");
  console.error("Solo usuarios de prueba @cartera.local: este script escribe datos de demostración.");
  process.exit(2);
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });
const q = (sql, params) => c.query(sql, params).then((r) => r.rows);
await c.connect();

const [usuario] = await q("select id::text as id from auth.users where email = $1", [email]);
if (!usuario) {
  console.error(`No existe ${email}. Crea antes la sesión de prueba (scripts/sesion-de-prueba.mjs).`);
  process.exit(1);
}
const uid = usuario.id;

// ── Fechas ──────────────────────────────────────────────────────────────────

const [{ hoy }] = await q("select private.hoy()::text as hoy");
const [ay, am, ad] = hoy.split("-").map(Number);
const iso = (y, m, d) => {
  const f = new Date(Date.UTC(y, m - 1, d));
  return f.toISOString().slice(0, 10);
};
/** Día `d` del mes que está `atras` meses antes del actual (recortado al fin de mes). */
function dia(atras, d) {
  const base = new Date(Date.UTC(ay, am - 1 - atras, 1));
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + 1;
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(y, m, Math.min(d, ultimo));
}
const yaPaso = (fecha) => fecha <= hoy;

// Pseudoaleatorio con semilla: los mismos datos en cada corrida.
let semilla = 20261022;
const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648);
const entre = (a, b) => Math.round(a + azar() * (b - a));

// ── Siembra ─────────────────────────────────────────────────────────────────

async function comoUsuario(trabajo) {
  await q("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
  ]);
  await q("set local role authenticated");
  try {
    return await trabajo();
  } finally {
    await q("reset role");
  }
}

async function sembrar() {
  const cuentas = Object.fromEntries(
    (await q("select name, id::text as id from public.account where user_id = $1", [uid])).map((r) => [r.name, r.id]),
  );
  const cat = Object.fromEntries(
    (await q("select name, id::text as id, type::text as type from public.category where user_id = $1", [uid])).map(
      (r) => [r.name, r],
    ),
  );
  for (const n of ["Nomina", "Visa", "Indexa Capital"]) {
    if (!cuentas[n]) throw new Error(`Falta la cuenta «${n}»: ¿corrió antes seed-demo.mjs?`);
  }

  // Cuentas: la nómina con colchón (ha pagado aportaciones y cuotas) y una de ahorro.
  await q("update public.account set name = 'Santander Nómina', initial_balance_cents = 1550000, color = '#48d4d0' where id = $1", [cuentas.Nomina]);
  await q("update public.account set name = 'Visa Oro', color = '#e6c06a' where id = $1", [cuentas.Visa]);
  await q("update public.account set color = '#8b7bf0' where id = $1", [cuentas["Indexa Capital"]]);
  const nomina = cuentas.Nomina;
  const ahorro = (
    await q(
      "insert into public.account (user_id,name,type,initial_balance_cents,color) values ($1,'ING Ahorro','AHORRO',120000,'#8de6c0') returning id::text as id",
      [uid],
    )
  )[0].id;
  await q("insert into public.card (user_id,account_id,last4,type,nickname) values ($1,$2,'7351','DEBITO','Débito nómina')", [uid, nomina]);
  await q("update public.profile set default_ingest_account_id = $2, display_name = 'Demo' where user_id = $1", [uid, nomina]);

  let n = 0;
  const mov = async (o) => {
    n++;
    const categoria = o.cat ? cat[o.cat] : null;
    const [r] = await q(
      `insert into public.transaction
         (user_id,type,amount_cents,description,occurred_on,occurred_time,account_id,to_account_id,category_id,category_type,
          source,status,merchant_raw,card_last4,external_id,subscription_id,recurring_income_id,reimburses_id,reimburses_target_type)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id::text as id`,
      [
        uid,
        o.tipo ?? "EXPENSE",
        o.cents,
        o.desc,
        o.fecha,
        // `occurred_time` no admite nulo: sin hora explícita, una verosímil.
        o.hora ?? `${String(entre(8, 21)).padStart(2, "0")}:${String(entre(0, 59)).padStart(2, "0")}:00`,
        o.cuenta ?? nomina,
        o.destino ?? null,
        categoria?.id ?? null,
        categoria?.type ?? null,
        o.fuente ?? "MANUAL",
        o.estado ?? "CONFIRMED",
        o.comercio ?? null,
        o.tarjeta ?? null,
        o.fuente === "SHORTCUT" ? `guia-${n}` : null,
        o.suscripcion ?? null,
        o.ingreso ?? null,
        o.reembolsa ?? null,
        o.reembolsa ? "EXPENSE" : null,
      ],
    );
    return r.id;
  };

  // Fijos: suscripciones e ingreso recurrente, con su historial generado.
  const subs = [
    ["Netflix", 1399, 12, "Ocio"],
    ["Spotify", 1099, 5, "Ocio"],
    ["Gimnasio", 3990, 1, "Salud"],
    ["iCloud+", 299, 20, "Compras"],
  ];
  const idsSub = {};
  for (const [nombre, cents, ancla, categoria] of subs) {
    const ultimo = yaPaso(dia(0, ancla)) ? dia(0, ancla) : dia(1, ancla);
    const proximo = yaPaso(dia(0, ancla)) ? dia(-1, ancla) : dia(0, ancla);
    idsSub[nombre] = (
      await q(
        `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,anchor_day,category_id,category_type,account_id,started_at,last_generated_on)
         values ($1,$2,$3,'MENSUAL',$4,$5,$6,'EXPENSE',$7,$8,$9) returning id::text as id`,
        [uid, nombre, cents, proximo, ancla, cat[categoria].id, nomina, dia(5, ancla), ultimo],
      )
    )[0].id;
    for (let atras = 5; atras >= 0; atras--) {
      if (yaPaso(dia(atras, ancla))) {
        await mov({ cents, desc: nombre, fecha: dia(atras, ancla), cat: categoria, fuente: "RECURRING", suscripcion: idsSub[nombre] });
      }
    }
  }
  await q(
    `insert into public.subscription (user_id,description,amount_cents,periodicity,next_charge_date,anchor_day,category_id,category_type,account_id,started_at,last_generated_on)
     values ($1,'Seguro del coche',38200,'ANUAL',$2,15,$3,'EXPENSE',$4,$5,$5)`,
    [uid, dia(-5, 15), cat.Transporte.id, nomina, dia(7, 15)],
  );

  const nominaFija = (
    await q(
      `insert into public.recurring_income (user_id,description,amount_cents,periodicity,next_income_date,anchor_day,category_id,category_type,account_id,started_at,last_generated_on)
       values ($1,'Nómina',235000,'MENSUAL',$2,28,$3,'INCOME',$4,$5,$6) returning id::text as id`,
      [uid, yaPaso(dia(0, 28)) ? dia(-1, 28) : dia(0, 28), cat["Nómina"].id, nomina, dia(5, 28), yaPaso(dia(0, 28)) ? dia(0, 28) : dia(1, 28)],
    )
  )[0].id;

  // Seis meses de día a día.
  for (let atras = 5; atras >= 0; atras--) {
    const f = (d) => dia(atras, d);
    const si = async (fecha, o) => (yaPaso(fecha) ? mov({ ...o, fecha }) : null);

    await si(f(28), { tipo: "INCOME", cents: 235000, desc: "Nómina", cat: "Nómina", fuente: "RECURRING", ingreso: nominaFija });
    await si(f(1), { cents: 85000, desc: "Alquiler", cat: "Casa" });
    await si(f(2), { cents: 5460, desc: "Abono transporte", cat: "Transporte" });
    await si(f(8), { cents: entre(5400, 7600), desc: "Iberdrola", cat: "Suministros", comercio: "IBERDROLA CLIENTES" });
    if (atras % 2 === 0) await si(f(15), { cents: entre(2400, 3300), desc: "Canal de Isabel II", cat: "Suministros" });
    await si(f(18), { cents: 3250, desc: "Tiendanimal", cat: "Mascota" });
    await si(f(12), { cents: entre(4800, 6200), desc: "Repsol", cat: "Transporte", comercio: "REPSOL E.S. 2240" });
    await si(f(29), { tipo: "TRANSFER", cents: 30000, desc: "Al ahorro", cat: "Ahorro", destino: ahorro });
    if (atras === 3) await si(f(9), { cents: 4595, desc: "Zara", cat: "Ropa" });
    if (atras === 2) await si(f(21), { cents: 12900, desc: "Udemy · curso de SQL", cat: "Educación" });
    if (atras === 4) await si(f(6), { cents: 2480, desc: "Farmacia", cat: "Salud" });

    // Este mes, con las cifras ajustadas para que los límites cuenten algo:
    // el súper cerca del tope y los restaurantes, pasados.
    if (atras === 0) continue;
    for (const [d, sitio] of [[3, "Mercadona"], [10, "Lidl"], [17, "Mercadona"], [24, "Carrefour"]]) {
      await si(f(d), { cents: entre(5200, 9400), desc: sitio, cat: "Supermercado", comercio: sitio.toUpperCase() });
    }
    for (const d of [6, 14, 23]) {
      await si(f(d), { cents: entre(1900, 4600), desc: ["La Tagliatella", "Goiko", "Taberna El Sur"][d % 3], cat: "Restaurantes" });
    }
    for (const d of [4, 7, 11, 16, 19, 25]) {
      await si(f(d), { cents: entre(160, 390), desc: "Café", cat: "Café", comercio: "STARBUCKS" });
    }
    await si(f(20), { cents: 990, desc: "Cines Yelmo", cat: "Ocio" });
    await si(f(26), { cents: entre(1999, 3999), desc: "Amazon", cat: "Compras" });
  }

  // El mes en curso, a mano. Lo del Atajo (tarjeta 7351) entra como SHORTCUT.
  const atajo = { fuente: "SHORTCUT", tarjeta: "7351" };
  const esteMes = [
    [3, 9120, "Mercadona", "Supermercado", "MERCADONA"],
    [10, 8460, "Lidl", "Supermercado", "LIDL"],
    [17, 9750, "Mercadona", "Supermercado", "MERCADONA"],
    [20, 6300, "Carrefour", "Supermercado", "CARREFOUR"],
    [4, 4250, "Goiko", "Restaurantes", "GOIKO GRILL"],
    [9, 3880, "La Tagliatella", "Restaurantes", "TAGLIATELLA"],
    [16, 2710, "Taberna El Sur", "Restaurantes", "TABERNA EL SUR"],
    [5, 340, "Café", "Café", "STARBUCKS"],
    [12, 290, "Café", "Café", "STARBUCKS"],
    [15, 375, "Café", "Café", "STARBUCKS"],
    [19, 310, "Café", "Café", "STARBUCKS"],
    [13, 1890, "Cines Yelmo", "Ocio", "YELMO CINES"],
  ];
  for (const [d, cents, desc, categoria, comercio] of esteMes) {
    const fecha = dia(0, d);
    if (yaPaso(fecha)) await mov({ ...atajo, cents, desc, cat: categoria, comercio, fecha, hora: `${10 + (d % 10)}:${String(d * 2).padStart(2, "0")}:00` });
  }
  // Una cena a pachas: el gasto entero y el Bizum del amigo, que lo abarata.
  const cena = dia(0, Math.min(11, ad));
  const idCena = await mov({ ...atajo, cents: 9600, desc: "Sala Bar", cat: "Restaurantes", comercio: "SALA BAR", fecha: cena, hora: "22:41:00" });
  await mov({ tipo: "INCOME", cents: 4800, desc: "Bizum de Lucía · cena", fecha: dia(0, Math.min(12, ad)), reembolsa: idCena });

  // Tres pagos del Atajo que ninguna regla supo clasificar: la bandeja de pendientes.
  for (const [atrasDias, cents, comercio] of [[0, 2349, "AMZN Mktp ES"], [1, 3995, "ZARA ESPAÑA"], [2, 1280, "BURGER KING 0412"]]) {
    const fecha = iso(ay, am, Math.max(1, ad - atrasDias));
    await mov({ ...atajo, cents, desc: comercio, comercio, fecha, hora: "13:1" + atrasDias + ":00", estado: "PENDING" });
  }

  // Reglas de comercio.
  for (const [texto, categoria, usos] of [
    ["MERCADONA", "Supermercado", 14],
    ["LIDL", "Supermercado", 6],
    ["CARREFOUR", "Supermercado", 5],
    ["STARBUCKS", "Café", 31],
    ["REPSOL", "Transporte", 6],
    ["IBERDROLA", "Suministros", 6],
    ["GOIKO", "Restaurantes", 3],
  ]) {
    await q(
      "insert into public.merchant_rule (user_id,match_text,category_id,category_type,hit_count) values ($1,$2,$3,'EXPENSE',$4)",
      [uid, texto, cat[categoria].id, usos],
    );
  }

  // Límites: el súper cerca del tope (82 %), los restaurantes pasados.
  for (const [categoria, tope] of [
    ["Supermercado", 40000],
    ["Restaurantes", 15000],
    ["Ocio", 8000],
    ["Café", 4000],
    ["Transporte", 13000],
    ["Compras", 10000],
  ]) {
    await q("insert into public.budget (user_id,category_id,category_type,monthly_cap_cents) values ($1,$2,'EXPENSE',$3)", [
      uid,
      cat[categoria].id,
      tope,
    ]);
  }

  // Metas de ahorro.
  await q("insert into public.savings_goal (user_id,name,target_cents,account_id,deadline) values ($1,'Viaje a Japón',450000,$2,$3)", [
    uid,
    ahorro,
    iso(ay + 1, 6, 30),
  ]);
  await q("insert into public.savings_goal (user_id,name,target_cents,account_id) values ($1,'Fondo de emergencia',900000,$2)", [
    uid,
    nomina,
  ]);

  // El préstamo del coche y el dispositivo del Atajo, con las funciones de la app.
  // seed-demo.mjs no borra los dispositivos: el de una siembra anterior se
  // sustituye aquí (solo el de la demo), o cada corrida dejaría otro más hasta
  // chocar con el máximo de 5 por usuario.
  await q("delete from public.ingest_device where user_id = $1 and name = 'iPhone de Demo'", [uid]);
  await comoUsuario(async () => {
    const inicio = dia(6, 20);
    await q(
      "select public.create_loan($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9::date,$10::date,$11)",
      ["Coche", nomina, 900000, 48, 6.45, 6.89, 0, 5, inicio, dia(5, 5), false],
    );
    await q("select public.create_ingest_device('iPhone de Demo')");
  });
  await q(
    "update public.ingest_device set request_count = 42, rejected_count = 0, last_used_at = now() - interval '25 minutes' where user_id = $1",
    [uid],
  );

  return n;
}

let total;
try {
  await q("begin");
  await q("set local lock_timeout = '10s'");
  await q("select pg_advisory_xact_lock(hashtext('seed-demo:' || $1::text))", [uid]);
  total = await sembrar();
  await q("commit");
} catch (error) {
  await q("rollback").catch(() => {});
  await c.end();
  console.error("seed-guia: no se ha tocado nada (la transacción se ha deshecho).");
  throw error;
}
await c.end();
console.log(`Guía sembrada en ${email}: ${total} movimientos, 5 fijos, 1 préstamo, 6 límites, 2 metas, 7 reglas.`);
