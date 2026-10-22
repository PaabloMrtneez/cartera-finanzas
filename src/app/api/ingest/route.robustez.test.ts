// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La ruta del Atajo (/api/ingest) con la base y los avisos simulados (fase 1:
 * robustez). Lo que se mira: que la basura se corta antes de tocar la base, que
 * todo rechazo deja rastro, que el importe nunca pasa por coma flotante sin
 * control, y qué protege contra el doble envío del mismo pago.
 *
 * La idempotencia de verdad vive en la base (`tx_external_id_uq` + `on
 * conflict do nothing` en `ingest_transaction`); aquí solo se comprueba que la
 * ruta le pasa lo necesario y que un duplicado no dispara un segundo aviso.
 */

type Llamada = { nombre: string; args: Record<string, unknown> };
const llamadas: Llamada[] = [];
let respuestaIngesta: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let respuestaRechazo: { data: unknown; error: null } = { data: { ok: true }, error: null };
const tareasAfter: Array<() => unknown> = [];

/**
 * Lo que devuelven las consultas de la ventana de reintento (H-21): el
 * dispositivo del token y el último cargo idéntico. `null` en `dispositivo`
 * simula que la consulta falla.
 */
let dispositivo: { data: { id: string } | null; error: unknown } = { data: { id: "dev-1" }, error: null };
let previos: { data: Array<{ external_id: string }> | null; error: unknown } = { data: [], error: null };
const filtrosTx: Array<[string, ...unknown[]]> = [];

function consultaEncadenable(tabla: string) {
  const cadena: Record<string, unknown> = {};
  for (const metodo of ["select", "eq", "is", "gte", "not", "order"]) {
    cadena[metodo] = (...args: unknown[]) => {
      if (tabla === "transaction") filtrosTx.push([metodo, ...args]);
      return cadena;
    };
  }
  cadena.maybeSingle = async () => dispositivo;
  cadena.limit = async () => previos;
  return cadena;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (nombre: string, args: Record<string, unknown>) => {
      llamadas.push({ nombre, args });
      if (nombre === "record_ingest_rejection") return respuestaRechazo;
      return respuestaIngesta;
    },
    from: (tabla: string) => consultaEncadenable(tabla),
  }),
}));

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (tarea: () => unknown) => {
    tareasAfter.push(tarea);
  },
}));

const enviarAviso = vi.fn(async () => ({ enviados: 1, caducados: 0 }));
vi.mock("@/lib/push", () => ({ configurarPush: () => true, enviarAviso: (...a: unknown[]) => enviarAviso(...(a as [])) }));

const { POST } = await import("./route");

let ip = 0;
/** Cada prueba con su propia IP, para no compartir el cubo del cortafuegos de ráfaga. */
function peticion(cuerpo: unknown, { token = "cart_prueba", ipFija }: { token?: string | null; ipFija?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": ipFija ?? `10.0.0.${++ip}` };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/ingest", {
    method: "POST",
    headers,
    body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
  });
}

const okIngesta = (extra: Record<string, unknown> = {}) => ({
  data: { ok: true, id: "tx-1", duplicate: false, status: "PENDING", user_id: "u-1", merchant: "Bar", ...extra },
  error: null,
});

const llamadasA = (nombre: string) => llamadas.filter((l) => l.nombre === nombre);

beforeEach(() => {
  llamadas.length = 0;
  tareasAfter.length = 0;
  filtrosTx.length = 0;
  dispositivo = { data: { id: "dev-1" }, error: null };
  previos = { data: [], error: null };
  enviarAviso.mockClear();
  respuestaIngesta = okIngesta();
  respuestaRechazo = { data: { ok: true }, error: null };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "clave-de-prueba";
});

describe("POST /api/ingest · la basura se corta antes de la base", () => {
  it("sin token, o sin el prefijo cart_, 401 y ni una consulta", async () => {
    expect((await POST(peticion({ amount: "1" }, { token: null }))).status).toBe(401);
    expect((await POST(peticion({ amount: "1" }, { token: "otro" }))).status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it("una ráfaga de más de 60 por minuto desde la misma IP se corta en memoria (429)", async () => {
    const estados: number[] = [];
    for (let i = 0; i < 61; i++) estados.push((await POST(peticion("{", { ipFija: "203.0.113.7" }))).status);
    expect(estados.slice(0, 60).every((s) => s === 400)).toBe(true);
    expect(estados[60]).toBe(429);
  });

  it("cuerpo de más de 4 KB: 413; JSON roto: 400; ninguno toca la base", async () => {
    expect((await POST(peticion("x".repeat(4097)))).status).toBe(413);
    expect((await POST(peticion("{no es json"))).status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });
});

describe("POST /api/ingest · todo rechazo deja rastro", () => {
  it("un importe sin números se rechaza con 422, se guarda el rechazo y la pista dice qué llegó", async () => {
    const r = await POST(peticion({ amount: "[Importe]", external_id: "e1" }));
    expect(r.status).toBe(422);
    const cuerpo = await r.json();
    expect(cuerpo).toMatchObject({ ok: false, error: "invalid_amount", recibido: "[Importe]" });
    expect(cuerpo.pista).toMatch(/variable/);
    expect(llamadasA("record_ingest_rejection")).toHaveLength(1);
    expect(llamadasA("ingest_transaction")).toHaveLength(0);
  });

  it("importes cero, negativos en texto o gigantes se rechazan", async () => {
    for (const amount of ["0", "0,00", "-12,50", "9".repeat(39), ""]) {
      expect((await POST(peticion({ amount }))).status).toBe(422);
    }
    expect(llamadasA("ingest_transaction")).toHaveLength(0);
  });

  it("si los rechazos de ese dispositivo pasan del límite, 429 con Retry-After (y la base ya no guarda nada)", async () => {
    respuestaRechazo = { data: { ok: false, error: "rate_limited", retry_after: 600 }, error: null };
    const r = await POST(peticion({ amount: "[Importe]" }));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("600");
    expect(await r.json()).toMatchObject({ ok: false, error: "rate_limited" });
  });

  it("otra divisa: 422 currency_not_supported, con rastro", async () => {
    const r = await POST(peticion({ amount: "12,50", currency: "USD" }));
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe("currency_not_supported");
    expect(llamadasA("record_ingest_rejection")).toHaveLength(1);
  });

  it("campos de más de lo admitido (merchant de 10 000) son payload inválido, con rastro", async () => {
    const r = await POST(peticion(JSON.stringify({ amount: "1", merchant: "x".repeat(3000) })));
    expect(r.status).toBe(422);
    expect(llamadasA("record_ingest_rejection")).toHaveLength(1);
  });

  // H-02: la tarjeta y la fecha no se validan en la ruta. Una tarjeta que no
  // son 4 dígitos («123», «12345») choca con el CHECK `tx_card_last4_fmt` y
  // una fecha que no entiende Postgres («ayer», «19 oct 2026, 14:32») revienta
  // el `::timestamptz`. En los dos casos la función de la base lanza, la ruta
  // responde 500 y el pago NO queda ni en movimientos ni en los rechazos: se
  // pierde sin rastro, y el Atajo reintenta con el mismo resultado.
  it("una tarjeta que no son 4 dígitos se rechaza con rastro (422), no con un 500 mudo", async () => {
    respuestaIngesta = { data: null, error: { message: 'new row violates check constraint "tx_card_last4_fmt"' } };
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await POST(peticion({ amount: "12,50", card: "123", external_id: "e2" }));
    consola.mockRestore();
    expect(r.status).toBe(422);
    expect(llamadasA("record_ingest_rejection")).toHaveLength(1);
  });

  it("la tarjeta llega a la base como sus 4 últimas cifras, o null si no hay 4", async () => {
    for (const [card, esperada] of [
      ["1234", "1234"],
      ["•••• 5678", "5678"],
      ["4111 1111 1111 1234", "1234"],
      ["123", null],
      ["Visa", null],
    ] as const) {
      llamadas.length = 0;
      await POST(peticion({ amount: "1", card, external_id: `c-${card}` }));
      expect((llamadasA("ingest_transaction")[0].args.p_payload as { card: unknown }).card).toBe(esperada);
    }
  });

  it("una fecha que Postgres no entiende se rechaza con rastro (422), no con un 500 mudo", async () => {
    respuestaIngesta = { data: null, error: { message: 'invalid input syntax for type timestamp with time zone: "ayer"' } };
    const r = await POST(peticion({ amount: "12,50", occurred_at: "ayer", external_id: "e3" }));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: "invalid_date", recibido: "ayer" });
    expect(llamadasA("record_ingest_rejection")).toHaveLength(1);
    expect(llamadasA("ingest_transaction")).toHaveLength(0);
  });

  it("una fecha ISO 8601 válida pasa a la base tal cual", async () => {
    await POST(peticion({ amount: "1", occurred_at: "2026-10-19T14:32:00+02:00", external_id: "e4" }));
    expect((llamadasA("ingest_transaction")[0].args.p_payload as { occurred_at: string }).occurred_at).toBe(
      "2026-10-19T14:32:00+02:00",
    );
  });

  it("un error de la base responde 500 genérico, sin filtrar el mensaje de Postgres, y deja rastro", async () => {
    respuestaIngesta = { data: null, error: { message: "relation public.transaction: detalle interno" } };
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await POST(peticion({ amount: "12,50" }));
    consola.mockRestore();
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ ok: false, error: "server_error" });
    expect(llamadasA("record_ingest_rejection")).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ p_reason: "DB_ERROR" }) }),
    ]);
  });

  it("el tope de 4 KB cuenta bytes, no caracteres (4 000 «€» son 12 000 bytes)", async () => {
    expect((await POST(peticion(JSON.stringify({ amount: "1", merchant: "€".repeat(1400) })))).status).toBe(413);
    expect(llamadas).toHaveLength(0);
  });
});

describe("POST /api/ingest · el importe", () => {
  it("texto en cualquier formato del iPhone → céntimos enteros", async () => {
    for (const [amount, cents] of [
      ["23,45 €", 2345],
      ["1.234,56", 123_456],
      ["23.45", 2345],
      ["€23.45", 2345],
    ] as const) {
      llamadas.length = 0;
      await POST(peticion({ amount }));
      expect(llamadasA("ingest_transaction")[0].args.p_amount_cents).toBe(cents);
    }
  });

  it("un número JSON con dos decimales también da el céntimo exacto (0,29 · 100 no es 28,99…)", async () => {
    for (const [amount, cents] of [
      [0.29, 29],
      [1.15, 115],
      [12.5, 1250],
      [1234.56, 123_456],
    ] as const) {
      llamadas.length = 0;
      await POST(peticion({ amount }));
      expect(llamadasA("ingest_transaction")[0].args.p_amount_cents).toBe(cents);
    }
  });

  // H-06: con un número JSON negativo, la ruta hace Math.abs y lo guarda como
  // GASTO positivo. El mismo importe en texto («-12,50») se rechaza. Una
  // devolución que el Atajo mandara como −12,50 acabaría sumando gasto.
  it("un importe numérico negativo se rechaza igual que en texto", async () => {
    const r = await POST(peticion({ amount: -12.5 }));
    expect(r.status).toBe(422);
    expect(llamadasA("ingest_transaction")).toHaveLength(0);
  });

  // Un número con más de dos decimales se redondeaba en coma flotante sin
  // avisar (1.005 → 1,00 €).
  it("un importe numérico con más de dos decimales no se redondea a escondidas", async () => {
    for (const amount of [1.005, 1e-7, 1e21, 0]) {
      expect((await POST(peticion({ amount }))).status).toBe(422);
    }
    expect(llamadasA("ingest_transaction")).toHaveLength(0);
  });
});

describe("POST /api/ingest · doble envío del mismo pago", () => {
  it("el external_id viaja a la base, que es quien deduplica (tx_external_id_uq)", async () => {
    await POST(peticion({ amount: "4,20", merchant: "Café", external_id: "atajo-123" }));
    await POST(peticion({ amount: "4,20", merchant: "Café", external_id: "atajo-123" }));
    const ingestas = llamadasA("ingest_transaction");
    expect(ingestas).toHaveLength(2);
    expect(ingestas.every((l) => (l.args.p_payload as { external_id: string }).external_id === "atajo-123")).toBe(true);
  });

  it("el reintento que la base marca como duplicado responde 200 y NO avisa otra vez", async () => {
    respuestaIngesta = okIngesta();
    await POST(peticion({ amount: "4,20", external_id: "atajo-9" }));
    expect(tareasAfter).toHaveLength(1);

    respuestaIngesta = okIngesta({ duplicate: true });
    const r = await POST(peticion({ amount: "4,20", external_id: "atajo-9" }));
    expect(r.status).toBe(200);
    expect(tareasAfter).toHaveLength(1); // ningún aviso nuevo
  });

  // H-21: sin external_id (el Atajo de la guía no lo manda), la base
  // sintetizaba uno por MINUTO: un reintento que cruzaba el minuto duplicaba
  // el cargo y dos cafés iguales en el mismo minuto se fundían en uno. Ahora
  // la ruta mira una ventana deslizante de 90 s.
  it("sin external_id y sin un cargo idéntico reciente, el envío lleva un identificador propio", async () => {
    await POST(peticion({ amount: "4,20", merchant: "Café", card: "1234" }));
    const payload = llamadasA("ingest_transaction")[0].args.p_payload as Record<string, unknown>;
    expect(payload.external_id).toMatch(/^atajo_[0-9a-f-]{36}$/);
    // Busca un cargo idéntico: mismo dispositivo, importe, comercio y tarjeta.
    expect(filtrosTx).toEqual(
      expect.arrayContaining([
        ["eq", "device_id", "dev-1"],
        ["eq", "amount_cents", 420],
        ["eq", "merchant_raw", "Café"],
        ["eq", "card_last4", "1234"],
      ]),
    );
  });

  it("sin external_id, un cargo idéntico en los últimos 90 s es el reintento: reutiliza su id", async () => {
    previos = { data: [{ external_id: "syn_abc" }], error: null };
    await POST(peticion({ amount: "4,20", merchant: "Café" }));
    const payload = llamadasA("ingest_transaction")[0].args.p_payload as Record<string, unknown>;
    expect(payload.external_id).toBe("syn_abc");
    expect(filtrosTx).toEqual(expect.arrayContaining([["is", "card_last4", null]]));
  });

  it("si la consulta de la ventana falla, deja que la base sintetice el de siempre", async () => {
    dispositivo = { data: null, error: { message: "caída" } };
    await POST(peticion({ amount: "4,20", merchant: "Café" }));
    const payload = llamadasA("ingest_transaction")[0].args.p_payload as Record<string, unknown>;
    expect(payload.external_id).toBeUndefined();
  });

  it("si el aviso push falla, el pago ya está guardado y la respuesta es 200", async () => {
    enviarAviso.mockRejectedValueOnce(new Error("push caído"));
    const r = await POST(peticion({ amount: "4,20", external_id: "atajo-10" }));
    expect(r.status).toBe(200);
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    await Promise.all(tareasAfter.map((t) => t()));
    expect(consola).toHaveBeenCalled();
    consola.mockRestore();
  });
});
