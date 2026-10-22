// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La ruta de actualización de precios con la base y las fuentes simuladas:
 * el secreto, que un símbolo que falla no tumba a los demás, que no se inventa
 * nada, y que el resumen no lleva datos personales.
 */

const upserts: Array<{ tabla: string; filas: unknown[] }> = [];
let instrumentos: Array<{ instrument_id: string; yahoo_symbol: string; currency: string; last_price_date: string | null; desde: string }> = [];

function adminFalso() {
  return {
    rpc: vi.fn(async (nombre: string) => {
      expect(nombre).toBe("instruments_to_refresh");
      return { data: instrumentos, error: null };
    }),
    from: (tabla: string) => {
      const cadena = {
        select: () => cadena,
        eq: () => cadena,
        order: () => cadena,
        limit: () => cadena,
        maybeSingle: async () => ({ data: tabla === "fx_rate" ? { date: "2026-10-01" } : null, error: null }),
        upsert: async (filas: unknown[]) => {
          upserts.push({ tabla, filas });
          return { error: null };
        },
      };
      return cadena;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFalso() }));

const descargarHistorico = vi.fn();
const descargarTiposDeCambio = vi.fn();
vi.mock("@/lib/precios/fuentes", async (original) => {
  const real = await original<typeof import("@/lib/precios/fuentes")>();
  return {
    ...real,
    descargarHistorico: (...a: unknown[]) => descargarHistorico(...a),
    descargarTiposDeCambio: (...a: unknown[]) => descargarTiposDeCambio(...a),
  };
});

const { POST } = await import("./route");
const { ErrorPrecios } = await import("@/lib/precios/fuentes");

const peticion = (secreto?: string) =>
  new Request("http://localhost/api/precios", {
    method: "POST",
    headers: secreto ? { Authorization: `Bearer ${secreto}` } : {},
  });

beforeEach(() => {
  process.env.NOTIFY_SECRET = "secreto-de-las-tareas";
  upserts.length = 0;
  descargarHistorico.mockReset();
  descargarTiposDeCambio.mockReset();
  instrumentos = [
    { instrument_id: "i-fondo", yahoo_symbol: "0P0001CLDK.F", currency: "EUR", last_price_date: "2026-10-02", desde: "2026-09-01" },
    { instrument_id: "i-dws", yahoo_symbol: "0P00008T3U.F", currency: "EUR", last_price_date: null, desde: "2026-09-15" },
    { instrument_id: "i-googl", yahoo_symbol: "GOOGL", currency: "USD", last_price_date: "2026-10-05", desde: "2026-08-01" },
  ];
});

describe("POST /api/precios", () => {
  it("sin el secreto, o con otro, 401 y no toca nada", async () => {
    for (const r of [await POST(peticion()), await POST(peticion("otro"))]) {
      expect(r.status).toBe(401);
    }
    expect(descargarHistorico).not.toHaveBeenCalled();
  });

  it("sin NOTIFY_SECRET configurado, 401 (no se abre la puerta por olvido)", async () => {
    delete process.env.NOTIFY_SECRET;
    expect((await POST(peticion("cualquiera"))).status).toBe(401);
  });

  it("pide cada instrumento desde una semana antes de su último precio, guarda y resume", async () => {
    descargarHistorico.mockImplementation(async (simbolo: string) => ({
      simbolo,
      nombre: simbolo,
      tipo: "FONDO",
      divisa: simbolo === "GOOGL" ? "USD" : "EUR",
      mercado: null,
      precios:
        simbolo === "0P0001CLDK.F"
          ? [
              { fecha: "2026-10-02", cierre: "14.49" },
              { fecha: "2026-10-05", cierre: "14.6592" },
            ]
          : [{ fecha: "2026-10-06", cierre: "1" }],
    }));
    descargarTiposDeCambio.mockResolvedValue([{ fecha: "2026-10-06", tasa: "1.1269" }]);

    const r = await POST(peticion("secreto-de-las-tareas"));
    expect(r.status).toBe(200);
    const cuerpo = await r.json();

    expect(descargarHistorico.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["0P0001CLDK.F", "2026-09-25"], // último precio 2 oct − 7
      ["0P00008T3U.F", "2026-09-08"], // sin precios: alta 15 sep − 7
      ["GOOGL", "2026-09-28"],
    ]);
    // El cambio, desde lo más antiguo entre lo que piden los instrumentos y el
    // último guardado (1 oct − 7).
    expect(descargarTiposDeCambio.mock.calls.map((c) => [c[0], c[1]])).toEqual([["USD", "2026-09-24"]]);

    expect(cuerpo).toEqual({
      ok: true,
      instrumentos: 3,
      precios_nuevos: 3, // 5 oct del fondo, 6 oct del DWS (no tenía) y 6 oct de GOOGL
      precios_escritos: 4,
      divisas: 1,
      cambios_escritos: 1,
      fallos: [],
      fallos_cambio: [],
    });
    // Los precios viajan como texto decimal, nunca como número.
    const filas = upserts.filter((u) => u.tabla === "instrument_price").flatMap((u) => u.filas) as Array<{ close: unknown }>;
    expect(filas.every((f) => typeof f.close === "string")).toBe(true);
  });

  it("si Yahoo falla con un símbolo, lo apunta y sigue con los demás; no inventa nada", async () => {
    descargarHistorico.mockImplementation(async (simbolo: string) => {
      if (simbolo === "0P00008T3U.F") throw new ErrorPrecios("TIEMPO", "lento");
      return { simbolo, nombre: simbolo, tipo: "FONDO", divisa: simbolo === "GOOGL" ? "USD" : "EUR", mercado: null, precios: [{ fecha: "2026-10-06", cierre: "2" }] };
    });
    descargarTiposDeCambio.mockRejectedValue(new ErrorPrecios("HTTP", "500"));

    const cuerpo = await (await POST(peticion("secreto-de-las-tareas"))).json();
    expect(cuerpo.ok).toBe(false);
    expect(cuerpo.fallos).toEqual([{ simbolo: "0P00008T3U.F", error: "TIEMPO" }]);
    expect(cuerpo.fallos_cambio).toEqual([{ simbolo: "USD", error: "HTTP" }]);
    expect(cuerpo.precios_escritos).toBe(2);
    const guardados = upserts.filter((u) => u.tabla === "instrument_price").flatMap((u) => u.filas) as Array<{ instrument_id: string }>;
    expect(guardados.map((f) => f.instrument_id).sort()).toEqual(["i-fondo", "i-googl"]);
  });

  it("si Yahoo cambia la divisa de un símbolo, no guarda sus precios", async () => {
    descargarHistorico.mockImplementation(async (simbolo: string) => ({
      simbolo, nombre: simbolo, tipo: "FONDO", divisa: "USD", mercado: null, precios: [{ fecha: "2026-10-06", cierre: "2" }],
    }));
    descargarTiposDeCambio.mockResolvedValue([]);
    const cuerpo = await (await POST(peticion("secreto-de-las-tareas"))).json();
    expect(cuerpo.fallos).toEqual([
      { simbolo: "0P0001CLDK.F", error: "divisa_cambiada:USD" },
      { simbolo: "0P00008T3U.F", error: "divisa_cambiada:USD" },
    ]);
    const guardados = upserts.filter((u) => u.tabla === "instrument_price").flatMap((u) => u.filas) as Array<{ instrument_id: string }>;
    expect(guardados.map((f) => f.instrument_id)).toEqual(["i-googl"]);
  });

  // H-23: un 429 de Yahoo (todos los símbolos salen de la misma IP) se
  // reintenta una vez tras una espera, en vez de dar el día por perdido.
  it("un 429 se reintenta una vez tras una espera; un 404 no", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const intentos = new Map<string, number>();
      descargarHistorico.mockImplementation(async (simbolo: string) => {
        const n = (intentos.get(simbolo) ?? 0) + 1;
        intentos.set(simbolo, n);
        if (simbolo === "0P0001CLDK.F" && n === 1) throw new ErrorPrecios("HTTP", "429", 429);
        if (simbolo === "0P00008T3U.F") throw new ErrorPrecios("NO_ENCONTRADO", "no");
        return { simbolo, nombre: simbolo, tipo: "FONDO", divisa: simbolo === "GOOGL" ? "USD" : "EUR", mercado: null, precios: [{ fecha: "2026-10-06", cierre: "2" }] };
      });
      descargarTiposDeCambio.mockResolvedValue([]);
      const respuesta = POST(peticion("secreto-de-las-tareas"));
      await vi.advanceTimersByTimeAsync(2_000);
      const cuerpo = await (await respuesta).json();
      expect(intentos.get("0P0001CLDK.F")).toBe(2);
      expect(intentos.get("0P00008T3U.F")).toBe(1);
      expect(cuerpo.fallos).toEqual([{ simbolo: "0P00008T3U.F", error: "NO_ENCONTRADO" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("como mucho 3 peticiones a Yahoo a la vez, y el cambio va en paralelo a los precios", async () => {
    instrumentos = Array.from({ length: 8 }, (_, i) => ({
      instrument_id: `i-${i}`,
      yahoo_symbol: `S${i}`,
      currency: "EUR",
      last_price_date: "2026-10-01",
      desde: "2026-09-01",
    }));
    instrumentos.push({ instrument_id: "i-usd", yahoo_symbol: "GOOGL", currency: "USD", last_price_date: "2026-10-01", desde: "2026-09-01" });
    let enVuelo = 0;
    let maximo = 0;
    let cambioMientrasPrecios = false;
    descargarHistorico.mockImplementation(async (simbolo: string) => {
      enVuelo++;
      maximo = Math.max(maximo, enVuelo);
      await new Promise((r) => setTimeout(r, 5));
      enVuelo--;
      return { simbolo, nombre: simbolo, tipo: "FONDO", divisa: simbolo === "GOOGL" ? "USD" : "EUR", mercado: null, precios: [] };
    });
    descargarTiposDeCambio.mockImplementation(async () => {
      cambioMientrasPrecios = enVuelo > 0;
      return [];
    });
    const cuerpo = await (await POST(peticion("secreto-de-las-tareas"))).json();
    expect(cuerpo.ok).toBe(true);
    expect(maximo).toBe(3);
    expect(cambioMientrasPrecios).toBe(true);
    // Cada petición lleva el corte del presupuesto total.
    expect(descargarHistorico.mock.calls.every((c) => c[2]?.signal instanceof AbortSignal)).toBe(true);
  });

  it("sin instrumentos que seguir, no pregunta a nadie", async () => {
    instrumentos = [];
    const cuerpo = await (await POST(peticion("secreto-de-las-tareas"))).json();
    expect(cuerpo).toMatchObject({ ok: true, instrumentos: 0, precios_nuevos: 0, divisas: 0 });
    expect(descargarHistorico).not.toHaveBeenCalled();
    expect(descargarTiposDeCambio).not.toHaveBeenCalled();
  });
});
