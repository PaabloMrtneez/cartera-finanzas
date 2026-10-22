/**
 * Prueba de la ingesta del Atajo, de punta a punta contra el endpoint real.
 *
 *   node scripts/test-ingest.mjs <token> [url]
 *
 * Comprueba lo que de verdad puede salir mal en producción: que una regla
 * clasifique sola, que lo desconocido quede pendiente, que un reintento no
 * duplique el cargo, y que un token inválido no consiga nada.
 */
const TOKEN = process.argv[2];
const URL = process.argv[3] ?? "http://localhost:3000/api/ingest";

if (!TOKEN) {
  console.error("Uso: node scripts/test-ingest.mjs <token> [url]");
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  OK    ${name}`);
  } else {
    failed++;
    console.log(`  FALLO ${name}`);
    console.log(`        ${detail}`);
  }
}

async function send(body, token = TOKEN) {
  const response = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { http: response.status, ...(await response.json()) };
}

const uuid = () => crypto.randomUUID();

console.log("— Ingesta desde el Atajo —\n");

// 1. Una regla acierta: entra ya clasificado y contando.
const conRegla = await send({
  merchant: "MERCADONA 4021 MADRID",
  amount: "23,45 €",
  card: "4412",
  external_id: uuid(),
});
check(
  "Un comercio con regla entra ya confirmado",
  conRegla.ok && conRegla.status === "CONFIRMED" && conRegla.category === "Supermercado",
  JSON.stringify(conRegla),
);
check(
  "El importe con símbolo y coma se convierte bien",
  conRegla.amount_cents === 2345,
  `Esperado 2345, llegó ${conRegla.amount_cents}`,
);

// 2. Sin regla: espera en la bandeja de pendientes.
const sinRegla = await send({
  merchant: "BAR PEPE",
  amount: "12,40",
  card: "4412",
  external_id: uuid(),
});
check(
  "Un comercio desconocido queda pendiente",
  sinRegla.ok && sinRegla.status === "PENDING" && sinRegla.category === null,
  JSON.stringify(sinRegla),
);

// 3. Idempotencia: el disparador de iOS agota el tiempo y reintenta.
const repetido = uuid();
const primera = await send({ merchant: "MERCADONA CENTRO", amount: "9,99", card: "4412", external_id: repetido });
const segunda = await send({ merchant: "MERCADONA CENTRO", amount: "9,99", card: "4412", external_id: repetido });
check(
  "Un reintento no duplica el cargo",
  segunda.ok && segunda.duplicate === true && segunda.id === primera.id,
  JSON.stringify({ primera, segunda }),
);
check(
  "Y responde 200, no un error",
  segunda.http === 200,
  `Devolvió ${segunda.http}. Con un error, el atajo avisaría de un fallo que no existe.`,
);

// 4. Un token que no existe no consigue nada.
const malToken = await send({ merchant: "X", amount: "1,00", external_id: uuid() }, "cart_noexiste");
check("Un token inválido se rechaza con 401", malToken.http === 401, JSON.stringify(malToken));

// 5. Basura en el importe: se rechaza en vez de inventarse una cifra.
const malImporte = await send({ merchant: "X", amount: "no es un importe", external_id: uuid() });
check(
  "Un importe ilegible se rechaza",
  malImporte.http === 422 && malImporte.error === "invalid_amount",
  JSON.stringify(malImporte),
);

// 6. Otra divisa: no se convierte a ciegas.
const otraDivisa = await send({ merchant: "X", amount: "10.00", currency: "USD", external_id: uuid() });
check(
  "Una divisa distinta del euro se rechaza",
  otraDivisa.http === 422 && otraDivisa.error === "currency_not_supported",
  JSON.stringify(otraDivisa),
);

console.log(`\n${passed} correctas · ${failed} fallidas`);
process.exit(failed === 0 ? 0 : 1);
