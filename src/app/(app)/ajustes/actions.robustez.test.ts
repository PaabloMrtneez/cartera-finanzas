// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las acciones de Ajustes (dispositivos del Atajo) con Supabase simulado (fase
 * 1: robustez). Reciben argumentos sueltos, no un FormData, y TypeScript no
 * protege en tiempo de ejecución: una server action se puede llamar con
 * cualquier cosa.
 */

const rpcs: Array<{ nombre: string; args: unknown }> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    rpc: async (nombre: string, args: unknown) => {
      rpcs.push({ nombre, args });
      return { data: { token: "cart_secreto" }, error: null };
    },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createIngestDevice, revokeIngestDevice } = await import("./actions");

beforeEach(() => {
  rpcs.length = 0;
});

describe("createIngestDevice", () => {
  it("nombre vacío o de más de 40 caracteres: error en español, sin tocar la base", async () => {
    for (const nombre of ["", "   ", "x".repeat(41), "x".repeat(10_000)]) {
      expect(await createIngestDevice(nombre)).toEqual({ ok: false, error: "Ponle un nombre de entre 1 y 40 caracteres." });
    }
    expect(rpcs).toHaveLength(0);
  });

  // H-18: `name.trim()` sobre algo que no es texto lanza un TypeError: la
  // acción revienta (error 500 genérico de Next) en lugar de responder.
  it("con un argumento que no es texto responde con un error, no lanza", async () => {
    await expect(createIngestDevice(123 as unknown as string)).resolves.toMatchObject({ ok: false });
    await expect(createIngestDevice(null as unknown as string)).resolves.toMatchObject({ ok: false });
  });
});

describe("revokeIngestDevice", () => {
  // H-16: el id no se valida como uuid antes de llamar a la base.
  it("valida el id antes de llamar a la base", async () => {
    const r = await revokeIngestDevice("no-es-uuid");
    expect(r.ok).toBe(false);
    expect(rpcs).toHaveLength(0);
  });
});
