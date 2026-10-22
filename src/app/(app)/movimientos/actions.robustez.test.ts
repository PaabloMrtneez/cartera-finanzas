// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las server actions de movimientos con Supabase simulado (fase 1: robustez).
 * Una server action es un endpoint público: cualquiera con sesión puede
 * llamarla con los argumentos que quiera, no solo los que manda el formulario.
 * Lo que se mira: qué se valida antes de ir a la base, qué ve la persona
 * cuando algo falla, y qué protege contra el doble envío.
 */

type Op = { tabla: string; op: string; valores?: unknown; filtros: Array<[string, unknown]> };
const ops: Op[] = [];
let usuario: { id: string } | null = { id: "u-1" };
let errorBase: { message: string } | null = null;
/** La fila es de otro usuario: la RLS la filtra sin error. */
let ajena = false;

function consulta(tabla: string, op: string, valores?: unknown) {
  const registro: Op = { tabla, op, valores, filtros: [] };
  ops.push(registro);
  // Con `.select("id")` detrás de un UPDATE o DELETE, la base devuelve las
  // filas tocadas: con la RLS filtrando (sesión caducada, id ajeno), ninguna.
  let conSelect = false;
  const q = {
    eq: (col: string, v: unknown) => {
      registro.filtros.push([col, v]);
      return q;
    },
    select: () => {
      conSelect = true;
      return q;
    },
    then: (resolver: (r: { error: { message: string } | null; data: unknown[] | null }) => unknown) =>
      Promise.resolve({
        error: errorBase,
        data: errorBase ? null : conSelect ? (usuario && !ajena ? [{ id: "fila" }] : []) : null,
      }).then(resolver),
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: usuario } }) },
    from: (tabla: string) => ({
      insert: (valores: unknown) => consulta(tabla, "insert", valores),
      update: (valores: unknown) => consulta(tabla, "update", valores),
      delete: () => consulta(tabla, "delete"),
    }),
    rpc: async () => ({ data: null, error: errorBase }),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createTransaction, updateTransaction, deleteTransaction } = await import("./actions");

const UUID = "6f1c1b7e-4a7a-4c1e-9b1a-1a2b3c4d5e6f";

function formulario(campos: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return fd;
}
const gasto = (extra: Record<string, string> = {}) =>
  formulario({ type: "EXPENSE", amount: "12,40", occurred_on: "2026-10-19", account_id: UUID, ...extra });

beforeEach(() => {
  ops.length = 0;
  usuario = { id: "u-1" };
  errorBase = null;
  ajena = false;
});

describe("createTransaction", () => {
  it("guarda céntimos enteros con el user_id de la SESIÓN, aunque el formulario traiga otro", async () => {
    const r = await createTransaction(gasto({ user_id: "u-ajeno", source: "SHORTCUT", status: "PENDING" }));
    expect(r).toEqual({ ok: true });
    const fila = ops[0].valores as Record<string, unknown>;
    expect(fila).toMatchObject({ user_id: "u-1", amount_cents: 1240, source: "MANUAL", status: "CONFIRMED" });
  });

  it("sin sesión no escribe y lo dice en español", async () => {
    usuario = null;
    expect(await createTransaction(gasto())).toEqual({ ok: false, error: "Sesión caducada. Vuelve a entrar." });
    expect(ops).toHaveLength(0);
  });

  it("un importe imposible se para en el esquema, con mensaje en español", async () => {
    for (const amount of ["", "abc", "-5", "0", "NaN", "Infinity", "9".repeat(10_000)]) {
      const r = await createTransaction(gasto({ amount }));
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/importe/i);
    }
    expect(ops).toHaveLength(0);
  });

  it("los CHECK conocidos de la base se traducen a un mensaje en español", async () => {
    errorBase = { message: 'new row for relation "transaction" violates check constraint "tx_date_sane"' };
    expect(await createTransaction(gasto())).toEqual({ ok: false, error: "Esa fecha está fuera de lo razonable." });
  });

  // H-11: un formulario sin tipo (cliente viejo, petición a mano) recibe el
  // inglés por defecto de Zod: «Invalid option: expected one of …».
  it("un formulario vacío recibe un mensaje en español", async () => {
    const r = await createTransaction(new FormData());
    expect((r as { error: string }).error).not.toMatch(/Invalid|expected/);
  });

  // H-01: cualquier error que `friendly` no reconoce llega TAL CUAL a la
  // pantalla: en inglés y con nombres internos de la base.
  it("un error desconocido de Postgres no se enseña crudo (p. ej. fecha 30 de febrero)", async () => {
    errorBase = { message: 'date/time field value out of range: "2026-02-30"' };
    const r = await createTransaction(gasto({ occurred_on: "2026-02-30" }));
    expect((r as { error: string }).error).not.toMatch(/out of range|date\/time/);
  });

  // H-13: el CHECK `tx_amount_positive` también pone el TOPE (≤ 1.000 M€), y la
  // traducción dice «mayor que cero» a quien ha escrito un importe enorme.
  it("un importe por encima del tope no se explica como «tiene que ser mayor que cero»", async () => {
    errorBase = { message: 'violates check constraint "tx_amount_positive"' };
    const r = await createTransaction(gasto({ amount: "2.000.000.000" }));
    expect((r as { error: string }).error).not.toBe("El importe tiene que ser mayor que cero.");
  });

  // H-22: la deduplicación la hace la base (`tx_client_id_uq`); aquí se mira
  // que la clave viaja y que el choque se toma por «ya estaba guardado».
  it("el client_id del formulario viaja con el alta; uno que no es uuid se ignora", async () => {
    await createTransaction(gasto({ client_id: UUID }));
    await createTransaction(gasto({ client_id: "no-es-uuid" }));
    await createTransaction(gasto());
    expect(ops.map((o) => (o.valores as { client_id: unknown }).client_id)).toEqual([UUID, null, null]);
  });

  it("un reenvío del mismo formulario choca con tx_client_id_uq y responde ok (ya estaba guardado)", async () => {
    errorBase = { message: 'duplicate key value violates unique constraint "tx_client_id_uq"' };
    expect(await createTransaction(gasto({ client_id: UUID }))).toEqual({ ok: true });
  });

  it("sin client_id, otro choque de clave única sigue siendo un error", async () => {
    errorBase = { message: 'duplicate key value violates unique constraint "tx_client_id_uq"' };
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await createTransaction(gasto());
    consola.mockRestore();
    expect(r.ok).toBe(false);
  });
});

describe("updateTransaction y deleteTransaction", () => {
  it("pasan por el mismo esquema que el alta: un importe roto no llega a la base", async () => {
    const r = await updateTransaction(UUID, gasto({ amount: "doce" }));
    expect(r.ok).toBe(false);
    expect(ops).toHaveLength(0);
  });

  it("clasificar un pendiente lo confirma, y solo si estaba PENDING", async () => {
    await updateTransaction(UUID, gasto({ category_id: "0b8f3a0e-2b1c-4d5e-8f9a-112233445566" }));
    const confirmar = ops.find((o) => o.op === "update" && (o.valores as { status?: string }).status === "CONFIRMED");
    expect(confirmar?.filtros).toEqual([
      ["id", UUID],
      ["status", "PENDING"],
    ]);
  });

  // H-16: el id de la URL no se valida. «no-es-uuid» viaja a PostgREST, que
  // responde «invalid input syntax for type uuid», y eso es lo que se enseña.
  it("updateTransaction valida el id antes de ir a la base", async () => {
    const r = await updateTransaction("no-es-uuid", gasto());
    expect(r.ok).toBe(false);
    expect(ops).toHaveLength(0);
  });

  it("deleteTransaction valida el id antes de ir a la base", async () => {
    const r = await deleteTransaction("'; drop table transaction; --");
    expect(r.ok).toBe(false);
    expect(ops).toHaveLength(0);
  });

  // H-16: ni la sesión ni las filas afectadas se comprueban. Con la sesión
  // caducada, o con el id de un movimiento ajeno, la RLS hace que el UPDATE no
  // toque ninguna fila y SIN error: la acción responde ok y la pantalla dice
  // «guardado» sin haber guardado nada.
  it("si no se ha actualizado ninguna fila, no responde ok", async () => {
    usuario = null; // sesión caducada: la RLS filtra todas las filas
    const r = await updateTransaction(UUID, gasto());
    expect(r.ok).toBe(false);
  });

  it("con sesión pero con el id de un movimiento ajeno (0 filas), «No se ha encontrado»", async () => {
    ajena = true;
    expect(await updateTransaction(UUID, gasto())).toEqual({ ok: false, error: "No se ha encontrado. Recarga la página." });
    expect(await deleteTransaction(UUID)).toEqual({ ok: false, error: "No se ha encontrado. Recarga la página." });
  });

  it("un error de Postgres sin traducción llega como mensaje genérico, sin nombres internos", async () => {
    errorBase = { message: 'column "foo_bar" of relation "transaction" does not exist' };
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await deleteTransaction(UUID);
    consola.mockRestore();
    expect(r).toEqual({ ok: false, error: "No se ha podido guardar. Inténtalo de nuevo." });
  });
});
