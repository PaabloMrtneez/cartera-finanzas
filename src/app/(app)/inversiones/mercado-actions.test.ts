// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las server actions de seguir un instrumento con Supabase y Yahoo simulados.
 * Lo que se comprueba es el ORDEN que sostiene la seguridad y la coherencia:
 * todo lo de fuera se valida antes de escribir nada; lo compartido va con
 * service_role; lo del usuario, con su sesión; y las participaciones viajan
 * como texto exacto.
 */

const revalidados: string[] = [];
vi.mock("next/cache", () => ({ revalidatePath: (r: string) => revalidados.push(r) }));

type Insercion = { tabla: string; fila: Record<string, unknown> };
const insertadas: Insercion[] = [];
let posicionVisible: { id: string; archived: boolean } | null = { id: "pos-1", archived: false };
let errorAlta: { message: string } | null = null;

function clienteSesion() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc: vi.fn(async (nombre: string, args: unknown) => {
      insertadas.push({ tabla: `rpc:${nombre}`, fila: args as Record<string, unknown> });
      return { data: 101000, error: null };
    }),
    from: (tabla: string) => {
      const cadena = {
        select: () => cadena,
        eq: () => cadena,
        maybeSingle: async () => ({ data: posicionVisible, error: null }),
        single: async () => ({ data: { id: "pos-nueva" }, error: null }),
        insert: (fila: Record<string, unknown>) => {
          insertadas.push({ tabla, fila });
          if (tabla === "position_unit_event") return Promise.resolve({ error: errorAlta });
          return cadena;
        },
        update: (fila: Record<string, unknown>) => {
          insertadas.push({ tabla: `${tabla}:update`, fila });
          return { eq: () => ({ select: async () => ({ data: [{ id: "tx" }], error: null }) }) };
        },
      };
      return cadena;
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteSesion() }));

const admin = { soyAdmin: true };
const usosAdmin: string[] = [];
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/precios/guardar", () => ({
  asegurarInstrumento: async (cliente: unknown, cot: { simbolo: string; divisa: string }) => {
    expect(cliente).toBe(admin);
    usosAdmin.push(`instrumento:${cot.simbolo}`);
    return { id: "inst-1", currency: cot.divisa, yahoo_symbol: cot.simbolo };
  },
  guardarPrecios: async (cliente: unknown, id: string, precios: unknown[]) => {
    expect(cliente).toBe(admin);
    usosAdmin.push(`precios:${id}:${precios.length}`);
    return precios.length;
  },
  guardarCambios: async (cliente: unknown, divisa: string, cambios: unknown[]) => {
    expect(cliente).toBe(admin);
    usosAdmin.push(`cambios:${divisa}:${cambios.length}`);
    return cambios.length;
  },
}));

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

const acciones = await import("./mercado-actions");
const { ErrorPrecios } = await import("@/lib/precios/fuentes");

const fondo = {
  simbolo: "0P0001CLDK.F",
  nombre: "Fidelity MSCI World Index EUR P Acc",
  tipo: "FONDO",
  divisa: "EUR",
  mercado: "Frankfurt",
  precios: [
    { fecha: "2026-09-29", cierre: "14.3601" },
    { fecha: "2026-10-01", cierre: "14.49" },
  ],
};

const alta = {
  position_id: "6f9619ff-8b86-4011-b42d-00cf4fc964ff",
  simbolo: "0P0001CLDK.F",
  participaciones: "1.234,5678",
  aportado: "15.000,00",
  fecha: "2026-10-01",
};

beforeEach(() => {
  revalidados.length = 0;
  insertadas.length = 0;
  usosAdmin.length = 0;
  posicionVisible = { id: "pos-1", archived: false };
  errorAlta = null;
  descargarHistorico.mockReset();
  descargarTiposDeCambio.mockReset();
});

describe("seguirInstrumento", () => {
  it("valida contra Yahoo, guarda lo compartido con service_role y el ALTA con la sesión", async () => {
    descargarHistorico.mockResolvedValue(fondo);
    const r = await acciones.seguirInstrumento(alta);

    expect(r).toEqual({
      ok: true,
      position_id: alta.position_id,
      instrument_id: "inst-1",
      divisa: "EUR",
      ultimoPrecio: "14.49",
      fechaUltimoPrecio: "2026-10-01",
    });
    // Histórico desde 10 días antes del alta.
    expect(descargarHistorico).toHaveBeenCalledWith("0P0001CLDK.F", "2026-09-21");
    expect(descargarTiposDeCambio).not.toHaveBeenCalled();
    expect(usosAdmin).toEqual(["instrumento:0P0001CLDK.F", "precios:inst-1:2"]);
    expect(insertadas).toEqual([
      {
        tabla: "position_unit_event",
        fila: {
          user_id: "user-1",
          position_id: alta.position_id,
          kind: "ALTA",
          date: "2026-10-01",
          instrument_id: "inst-1",
          units: "1234.5678", // texto exacto, no un número
          contributed_cents: 1500000,
        },
      },
    ]);
    expect(revalidados).toEqual(["/inversiones", "/patrimonio", "/resumen", "/cuentas", "/metas"]);
  });

  it("si Yahoo no conoce el símbolo, no escribe NADA", async () => {
    descargarHistorico.mockRejectedValue(new ErrorPrecios("NO_ENCONTRADO", "no"));
    const r = await acciones.seguirInstrumento(alta);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no encuentra/);
    expect(usosAdmin).toEqual([]);
    expect(insertadas).toEqual([]);
  });

  it("sin precios desde esa fecha, tampoco", async () => {
    descargarHistorico.mockResolvedValue({ ...fondo, precios: [] });
    expect((await acciones.seguirInstrumento(alta)).ok).toBe(false);
    expect(usosAdmin).toEqual([]);
    expect(insertadas).toEqual([]);
  });

  it("un índice no se puede seguir", async () => {
    descargarHistorico.mockResolvedValue({ ...fondo, tipo: null });
    const r = await acciones.seguirInstrumento(alta);
    expect(r.ok).toBe(false);
    expect(insertadas).toEqual([]);
  });

  it("en dólares: pide el cambio del BCE y, si no lo hay, no escribe nada", async () => {
    descargarHistorico.mockResolvedValue({ ...fondo, simbolo: "GOOGL", tipo: "ACCION", divisa: "USD" });
    descargarTiposDeCambio.mockResolvedValue([]);
    const r = await acciones.seguirInstrumento({ ...alta, simbolo: "GOOGL" });
    expect(r.ok).toBe(false);
    expect(descargarTiposDeCambio).toHaveBeenCalledWith("USD", "2026-09-21");
    expect(usosAdmin).toEqual([]);

    descargarTiposDeCambio.mockResolvedValue([{ fecha: "2026-09-30", tasa: "1.13" }]);
    const ok = await acciones.seguirInstrumento({ ...alta, simbolo: "GOOGL" });
    expect(ok.ok).toBe(true);
    expect(usosAdmin).toEqual(["instrumento:GOOGL", "precios:inst-1:2", "cambios:USD:1"]);
  });

  it("una posición que no es tuya (la RLS no la deja ver) no se toca", async () => {
    posicionVisible = null;
    const r = await acciones.seguirInstrumento(alta);
    expect(r.ok).toBe(false);
    expect(descargarHistorico).not.toHaveBeenCalled();
    expect(insertadas).toEqual([]);
  });

  it("con datos de alta crea la posición (con la sesión) y luego el ALTA", async () => {
    descargarHistorico.mockResolvedValue(fondo);
    const r = await acciones.seguirInstrumento({
      ...alta,
      position_id: null,
      nueva: { name: "MSCI World", account_id: "6f9619ff-8b86-4011-b42d-00cf4fc964ff", color: "#336699" },
    });
    expect(r.ok && r.position_id).toBe("pos-nueva");
    expect(insertadas.map((i) => i.tabla)).toEqual(["investment_position", "position_unit_event"]);
    expect(insertadas[0].fila).toMatchObject({ name: "MSCI World", since: "2026-10-01", user_id: "user-1" });
  });

  it("una fecha futura se rechaza antes de preguntar a nadie", async () => {
    const r = await acciones.seguirInstrumento({ ...alta, fecha: "2999-01-01" });
    expect(r.ok).toBe(false);
    expect(descargarHistorico).not.toHaveBeenCalled();
  });

  it("participaciones ambiguas o con coma flotante disfrazada: no pasa la validación", async () => {
    expect((await acciones.seguirInstrumento({ ...alta, participaciones: "1.234" })).ok).toBe(false);
    expect((await acciones.seguirInstrumento({ ...alta, participaciones: "1e3" })).ok).toBe(false);
    expect(descargarHistorico).not.toHaveBeenCalled();
  });
});

describe("ajustarParticipaciones, dejarDeSeguir, participacionesDeAportacion", () => {
  it("el ajuste se anota como AJUSTE con las participaciones en texto", async () => {
    const r = await acciones.ajustarParticipaciones({ position_id: alta.position_id, participaciones: "1.240,1", fecha: "2026-10-03" });
    expect(r.ok).toBe(true);
    expect(insertadas[0]).toEqual({
      tabla: "position_unit_event",
      fila: { user_id: "user-1", position_id: alta.position_id, kind: "AJUSTE", date: "2026-10-03", units: "1240.1", note: null },
    });
  });

  it("si la base dice que no sigue nada, se explica", async () => {
    errorAlta = { message: "Esa posición no sigue ningún instrumento en esa fecha" };
    const r = await acciones.ajustarParticipaciones({ position_id: alta.position_id, participaciones: "1", fecha: "2026-10-03" });
    expect(r).toEqual({ ok: false, error: "Esa posición no sigue ningún instrumento en esa fecha." });
  });

  it("dejar de seguir llama a unfollow_instrument y devuelve el valor", async () => {
    const r = await acciones.dejarDeSeguir({ position_id: alta.position_id, fecha: "2026-10-03" });
    expect(r).toEqual({ ok: true, value_cents: 101000 });
    expect(insertadas[0]).toEqual({ tabla: "rpc:unfollow_instrument", fila: { p_position_id: alta.position_id, p_date: "2026-10-03" } });
  });

  it("las participaciones de una aportación se anotan en texto, o se borran con vacío", async () => {
    const id = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";
    expect((await acciones.participacionesDeAportacion({ transaction_id: id, participaciones: "20,5" })).ok).toBe(true);
    expect((await acciones.participacionesDeAportacion({ transaction_id: id, participaciones: "" })).ok).toBe(true);
    expect(insertadas.map((i) => i.fila.position_units)).toEqual(["20.5", null]);
  });
});
