import { afterEach, describe, expect, it, vi } from "vitest";
import { esFalloDeRed, llamarAccion, mensajeSinConexion } from "./llamar-accion";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("llamarAccion", () => {
  it("devuelve tal cual lo que responde la acción", async () => {
    await expect(llamarAccion(async () => ({ ok: true as const }))).resolves.toEqual({ ok: true });
    await expect(
      llamarAccion(async () => ({ ok: false as const, error: "Falta la cuenta" })),
    ).resolves.toEqual({ ok: false, error: "Falta la cuenta" });
  });

  it("convierte «Failed to fetch» en un resultado sin conexión, sin lanzar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await llamarAccion(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(r).toEqual({ ok: false, error: mensajeSinConexion("guardado"), sinConexion: true });
  });

  it("sin red ni siquiera llama a la acción", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const accion = vi.fn(async () => ({ ok: true as const }));
    const r = await llamarAccion(accion, "borrado");
    expect(accion).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, sinConexion: true });
    expect((r as { error: string }).error).toContain("no se ha borrado");
  });

  it("un fallo del servidor no se presenta como falta de red", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await llamarAccion(async () => {
      throw new Error("An error occurred in the Server Components render");
    });
    expect(r).toMatchObject({ ok: false, sinConexion: false });
    expect((r as { error: string }).error).toMatch(/no se ha guardado/i);
  });

  it("deja pasar los errores de control de Next (redirect)", async () => {
    const redireccion = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/movimientos;307;",
    });
    await expect(
      llamarAccion(async () => {
        throw redireccion;
      }),
    ).rejects.toBe(redireccion);
  });
});

describe("esFalloDeRed", () => {
  it("reconoce los mensajes de red de cada navegador", () => {
    expect(esFalloDeRed(new TypeError("Failed to fetch"))).toBe(true);
    expect(esFalloDeRed(new TypeError("Load failed"))).toBe(true);
    expect(esFalloDeRed(new TypeError("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(esFalloDeRed(new TypeError("x is not a function"))).toBe(false);
    expect(esFalloDeRed(new Error("Failed to fetch"))).toBe(false);
  });
});
