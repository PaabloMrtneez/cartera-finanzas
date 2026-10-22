// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La tarea programada /api/notificar con la base y web-push simulados (fase 1:
 * robustez). Lo que se mira: que el fallo de un usuario no deja sin aviso a
 * los demás, qué pasa si se ejecuta dos veces, y con qué mes trabaja.
 *
 * Se usa el `enviarAviso` REAL (src/lib/push.ts): lo simulado es web-push.
 */

type Fila = Record<string, unknown>;
let datosRpc: Record<string, { data: unknown; error: { message: string } | null }> = {};
const llamadasRpc: Array<{ nombre: string; args?: Record<string, unknown> }> = [];
let destinosPorUsuario: Record<string, Fila[]> = {};
const actualizaciones: Array<{ id: string; valores: Fila; tabla?: string }> = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (nombre: string, args?: Record<string, unknown>) => {
      llamadasRpc.push({ nombre, args });
      return datosRpc[nombre] ?? { data: [], error: null };
    },
    from: (tabla: string) => ({
      select: () => ({
        eq: (_c: string, userId: string) => ({
          is: async () => ({ data: destinosPorUsuario[userId] ?? [], error: null }),
        }),
      }),
      update: (valores: Fila) => ({
        // Encadenable (`.eq().eq()`) y esperable en cualquier punto.
        eq: (_c: string, id: string) => {
          actualizaciones.push({ id, valores, tabla });
          const resultado = { error: null };
          const cadena = {
            eq: () => cadena,
            then: (ok: (r: typeof resultado) => unknown) => Promise.resolve(resultado).then(ok),
          };
          return cadena;
        },
      }),
    }),
  }),
}));

const sendNotification = vi.fn();
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: (...a: unknown[]) => sendNotification(...a) } }));

const { POST } = await import("./route");

const peticion = (consulta = "?forzar=1", secreto = "secreto-tareas") =>
  new Request(`http://localhost/api/notificar${consulta}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secreto}` },
  });

const destino = (id: string) => ({ id, endpoint: `https://push.local/${id}`, p256dh: "k", auth: "a" });

beforeEach(() => {
  process.env.NOTIFY_SECRET = "secreto-tareas";
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "publica";
  process.env.VAPID_PRIVATE_KEY = "privada";
  process.env.VAPID_SUBJECT = "mailto:prueba@ejemplo.es";
  llamadasRpc.length = 0;
  actualizaciones.length = 0;
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  destinosPorUsuario = { "u-a": [destino("d-a")], "u-b": [destino("d-b")] };
  datosRpc = {
    generate_loan_installments_all: { data: 0, error: null },
    claim_pending_reminder: {
      data: [
        { user_id: "u-a", cuantos: 2 },
        { user_id: "u-b", cuantos: 1 },
      ],
      error: null,
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/notificar", () => {
  it("sin el secreto, 401 y no genera cuotas ni reclama avisos", async () => {
    expect((await POST(peticion("?forzar=1", "otro"))).status).toBe(401);
    expect(llamadasRpc).toHaveLength(0);
  });

  it("si el push de un usuario falla (500 del servicio), los demás reciben el suyo", async () => {
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("d-a")) throw Object.assign(new Error("caído"), { statusCode: 500 });
      return { statusCode: 201 };
    });
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await POST(peticion());
    consola.mockRestore();
    const cuerpo = await r.json();
    expect(cuerpo).toMatchObject({ ok: true, usuarios_con_avisos: 2, enviados: 1 });
    // Un 500 no marca la suscripción como caducada (solo 404/410).
    expect(actualizaciones.some((a) => a.id === "d-a" && "failed_at" in a.valores)).toBe(false);
  });

  it("si el push de las cuotas cobradas falla, el aviso se devuelve para la siguiente pasada", async () => {
    datosRpc.claim_loan_installment_notices = {
      data: [
        { user_id: "u-a", loan_id: "l-a", loan_name: "Coche", from_period: 3, to_period: 4, term_months: 60, amount_cents: 40000 },
        { user_id: "u-b", loan_id: "l-b", loan_name: "Moto", from_period: 2, to_period: 2, term_months: 12, amount_cents: 20000 },
      ],
      error: null,
    };
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("d-a")) throw Object.assign(new Error("plazo agotado"), { statusCode: undefined });
      return { statusCode: 201 };
    });
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const cuerpo = await (await POST(peticion())).json();
    consola.mockRestore();
    expect(cuerpo).toMatchObject({ avisos_devueltos: 1 });
    const devueltas = actualizaciones.filter((a) => a.tabla === "loan");
    expect(devueltas).toEqual([{ id: "l-a", valores: { notified_period: 2 }, tabla: "loan" }]);
  });

  it("cada push lleva un plazo, para que un servicio colgado no se coma los 60 s", async () => {
    await POST(peticion());
    expect(sendNotification).toHaveBeenCalled();
    for (const llamada of sendNotification.mock.calls) {
      expect(llamada[2]).toMatchObject({ timeout: expect.any(Number) });
    }
  });

  it("un 410 (suscripción muerta) la marca como caducada y sigue con los demás", async () => {
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("d-a")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      return { statusCode: 201 };
    });
    const cuerpo = await (await POST(peticion())).json();
    expect(cuerpo).toMatchObject({ enviados: 1, caducados: 1 });
    expect(actualizaciones.some((a) => a.id === "d-a" && "failed_at" in a.valores)).toBe(true);
  });

  it("dos ejecuciones el mismo día: la ruta no deduplica, lo hace la base (claims y tx_loan_cuota_uq)", async () => {
    await POST(peticion());
    datosRpc.claim_pending_reminder = { data: [], error: null }; // la base ya los reclamó
    const segunda = await (await POST(peticion())).json();
    expect(llamadasRpc.filter((l) => l.nombre === "generate_loan_installments_all")).toHaveLength(2);
    expect(segunda).toMatchObject({ usuarios_con_avisos: 0, enviados: 0 });
  });

  it("en la ventana de silencio genera las cuotas igual, pero no reclama ni envía avisos", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T22:30:00Z")); // 00:30 en Madrid
    const cuerpo = await (await POST(peticion(""))).json();
    expect(cuerpo).toMatchObject({ ok: true, omitido: "ventana_de_silencio" });
    expect(llamadasRpc.map((l) => l.nombre)).toEqual(["generate_loan_installments_all"]);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("si generar las cuotas falla, lo dice en el resumen y sigue con los avisos", async () => {
    datosRpc.generate_loan_installments_all = { data: null, error: { message: "boom" } };
    const cuerpo = await (await POST(peticion())).json();
    expect(cuerpo).toMatchObject({ ok: true, error_cuotas: true, enviados: 2 });
  });

  // H-14: los errores de las consultas `claim_*` se ignoran sin dejar rastro:
  // si `claim_budget_alerts` falla, el resumen dice ok y nadie se entera de que
  // ese día no salió ningún aviso de límite.
  it("si una consulta de avisos falla, el resumen lo refleja", async () => {
    datosRpc.claim_budget_alerts = { data: null, error: { message: "timeout" } };
    const cuerpo = await (await POST(peticion())).json();
    expect(cuerpo.ok === false || "error_avisos" in cuerpo).toBe(true);
  });

  // H-07 (variante): el mes de los avisos de límite se calcula en UTC. El día 1
  // entre las 00:00 y las 01:00/02:00 de Madrid (con ?forzar=1, o si se mueve
  // la ventana de silencio) se reclaman los avisos del mes ANTERIOR.
  it("el día 1 a las 00:30 de Madrid, los avisos de límite son del mes que empieza", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T23:30:00Z")); // 00:30 CET del 1 de noviembre
    await POST(peticion());
    const claim = llamadasRpc.find((l) => l.nombre === "claim_budget_alerts");
    expect(claim?.args?.p_month).toBe("2026-11-01");
  });
});
