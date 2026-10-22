// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La acción de invitar, con Supabase simulado. Lo que se comprueba es la
 * PUERTA: sin sesión, sin aal2 o sin estar en la lista de administradores, el
 * cliente de service_role ni se crea. Y que el enlace que sale es el nuestro
 * (token sin canjear hacia /invitacion), no el `action_link` de Supabase.
 */

const ADMIN = "0b6c1e2a-3f4d-4a5b-8c9d-0e1f2a3b4c5d";
const OTRO = "11111111-2222-4333-8444-555555555555";

let usuario: { id: string } | null = { id: ADMIN };
let nivel: { currentLevel: string; nextLevel: string } | null = {
  currentLevel: "aal2",
  nextLevel: "aal2",
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: usuario } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: nivel }) },
    },
  }),
}));

vi.mock("@/lib/base-url", () => ({ getBaseUrl: async () => "https://cartera.example" }));

type Pedido = { type: string; email: string; options?: { redirectTo?: string } };
const pedidos: Pedido[] = [];
let respuestas: Array<{ data: unknown; error: unknown }> = [];
const crearAdmin = vi.fn(() => ({
  auth: {
    admin: {
      generateLink: async (p: Pedido) => {
        pedidos.push(p);
        return respuestas.shift() ?? { data: null, error: { message: "sin respuesta" } };
      },
    },
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => crearAdmin() }));

const { generarInvitacion } = await import("./invitar-actions");

const conToken = (hashed_token: string) => ({
  data: {
    properties: {
      hashed_token,
      action_link: "https://xyz.supabase.co/auth/v1/verify?token=NO-USAR",
    },
    user: { id: "nuevo" },
  },
  error: null,
});

beforeEach(() => {
  usuario = { id: ADMIN };
  nivel = { currentLevel: "aal2", nextLevel: "aal2" };
  pedidos.length = 0;
  respuestas = [];
  crearAdmin.mockClear();
  vi.stubEnv("CARTERA_ADMIN_IDS", `${ADMIN}, ${OTRO}`);
  vi.stubEnv("CARTERA_ENLACE_CADUCA_HORAS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("la puerta", () => {
  it("sin sesión, nada", async () => {
    usuario = null;
    const r = await generarInvitacion("ana@correo.com");
    expect(r.ok).toBe(false);
    expect(crearAdmin).not.toHaveBeenCalled();
  });

  it("sin segundo factor superado (aal1), nada", async () => {
    nivel = { currentLevel: "aal1", nextLevel: "aal2" };
    const r = await generarInvitacion("ana@correo.com");
    expect(r).toEqual({ ok: false, error: "No tienes permiso para invitar." });
    expect(crearAdmin).not.toHaveBeenCalled();
  });

  it("quien no está en la lista, nada", async () => {
    usuario = { id: "99999999-2222-4333-8444-555555555555" };
    const r = await generarInvitacion("ana@correo.com");
    expect(r).toEqual({ ok: false, error: "No tienes permiso para invitar." });
    expect(crearAdmin).not.toHaveBeenCalled();
  });

  it("sin administradores configurados, nadie", async () => {
    vi.stubEnv("CARTERA_ADMIN_IDS", "");
    const r = await generarInvitacion("ana@correo.com");
    expect(r.ok).toBe(false);
    expect(crearAdmin).not.toHaveBeenCalled();
  });

  it("un correo no válido no llega a Supabase", async () => {
    const r = await generarInvitacion("esto no es un correo");
    expect(r.ok).toBe(false);
    expect(crearAdmin).not.toHaveBeenCalled();
  });

  it("ni algo que no sea texto", async () => {
    const r = await generarInvitacion({ email: "ana@correo.com" });
    expect(r.ok).toBe(false);
    expect(crearAdmin).not.toHaveBeenCalled();
  });
});

describe("el enlace", () => {
  it("invitación nueva: enlace a /invitacion con el token sin canjear", async () => {
    respuestas = [conToken("hash-nuevo")];
    const r = await generarInvitacion("  Ana@Correo.com ");
    expect(r).toEqual({
      ok: true,
      enlace: "https://cartera.example/invitacion?token_hash=hash-nuevo&type=invite",
      tipo: "invite",
      horas: 1,
      email: "ana@correo.com",
    });
    expect(pedidos).toEqual([
      {
        type: "invite",
        email: "ana@correo.com",
        options: { redirectTo: "https://cartera.example/invitacion" },
      },
    ]);
  });

  it("nunca devuelve el action_link de Supabase", async () => {
    respuestas = [conToken("h")];
    const r = await generarInvitacion("ana@correo.com");
    expect(JSON.stringify(r)).not.toMatch(/NO-USAR|supabase\.co/);
  });

  it("si ya tenía cuenta, un enlace de recuperación", async () => {
    respuestas = [
      { data: null, error: { code: "email_exists", status: 422, message: "already registered" } },
      conToken("hash-recuperar"),
    ];
    const r = await generarInvitacion("ana@correo.com");
    expect(r).toMatchObject({
      ok: true,
      tipo: "recovery",
      enlace: "https://cartera.example/invitacion?token_hash=hash-recuperar&type=recovery",
    });
    expect(pedidos.map((p) => p.type)).toEqual(["invite", "recovery"]);
  });

  it("avisa de la caducidad configurada", async () => {
    vi.stubEnv("CARTERA_ENLACE_CADUCA_HORAS", "24");
    respuestas = [conToken("h")];
    const r = await generarInvitacion("ana@correo.com");
    expect(r).toMatchObject({ ok: true, horas: 24 });
  });

  it("otro error de Supabase: mensaje genérico, sin enlace", async () => {
    respuestas = [{ data: null, error: { code: "over_request_rate_limit", status: 429 } }];
    const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await generarInvitacion("ana@correo.com");
    espia.mockRestore();
    expect(r.ok).toBe(false);
    expect(pedidos).toHaveLength(1);
  });

  it("si Supabase no trae token, no se inventa un enlace", async () => {
    respuestas = [{ data: { properties: {} }, error: null }];
    const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await generarInvitacion("ana@correo.com");
    espia.mockRestore();
    expect(r.ok).toBe(false);
  });
});
