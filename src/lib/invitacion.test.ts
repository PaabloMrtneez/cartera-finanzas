import { describe, expect, it } from "vitest";
import {
  construirEnlaceInvitacion,
  detalleDeEnlace,
  esAdministrador,
  horasDeCaducidad,
  idsDeAdministrador,
  textoCaducidad,
  yaTieneCuenta,
} from "./invitacion";
import { invitarSchema } from "./schemas";

const ADMIN = "0b6c1e2a-3f4d-4a5b-8c9d-0e1f2a3b4c5d";
const OTRO = "11111111-2222-4333-8444-555555555555";

describe("quién administra", () => {
  it("lee uuids separados por comas, con espacios y en cualquier caja", () => {
    const ids = idsDeAdministrador(` ${ADMIN.toUpperCase()} ,${OTRO}`);
    expect([...ids].sort()).toEqual([ADMIN, OTRO].sort());
  });

  it("descarta lo que no es un uuid", () => {
    expect(idsDeAdministrador("admin, 1234, ,*")).toEqual(new Set());
  });

  it("sin variable no hay nadie", () => {
    expect(idsDeAdministrador(undefined).size).toBe(0);
    expect(esAdministrador(ADMIN, undefined)).toBe(false);
    expect(esAdministrador(ADMIN, "")).toBe(false);
  });

  it("solo los de la lista", () => {
    expect(esAdministrador(ADMIN, `${ADMIN},${OTRO}`)).toBe(true);
    expect(esAdministrador(ADMIN.toUpperCase(), ADMIN)).toBe(true);
    expect(esAdministrador(OTRO, ADMIN)).toBe(false);
  });

  it("sin usuario, nunca", () => {
    expect(esAdministrador(null, ADMIN)).toBe(false);
    expect(esAdministrador(undefined, ADMIN)).toBe(false);
    expect(esAdministrador("", ADMIN)).toBe(false);
  });

  it("un prefijo o un comodín no cuelan", () => {
    expect(esAdministrador(ADMIN.slice(0, 8), ADMIN)).toBe(false);
    expect(esAdministrador(ADMIN, "*")).toBe(false);
  });
});

describe("el enlace", () => {
  it("va a NUESTRA página con el token sin canjear", () => {
    const enlace = new URL(construirEnlaceInvitacion("https://cartera.example", "abc123", "invite"));
    expect(enlace.origin).toBe("https://cartera.example");
    expect(enlace.pathname).toBe("/invitacion");
    expect(enlace.searchParams.get("token_hash")).toBe("abc123");
    expect(enlace.searchParams.get("type")).toBe("invite");
  });

  it("no lleva nada de Supabase (ni /auth/v1/verify ni redirect_to)", () => {
    const enlace = construirEnlaceInvitacion("https://cartera.example/", "abc", "recovery");
    expect(enlace).toBe("https://cartera.example/invitacion?token_hash=abc&type=recovery");
    expect(enlace).not.toMatch(/verify|redirect_to|supabase/);
  });

  it("codifica lo que haga falta", () => {
    const enlace = new URL(construirEnlaceInvitacion("http://localhost:3000", "a+b/c=", "invite"));
    expect(enlace.searchParams.get("token_hash")).toBe("a+b/c=");
  });
});

describe("la caducidad que se avisa", () => {
  it("1 hora por defecto, la de fábrica de Supabase", () => {
    expect(horasDeCaducidad(undefined)).toBe(1);
    expect(horasDeCaducidad("")).toBe(1);
    expect(horasDeCaducidad("mucho")).toBe(1);
  });

  it("acepta de 1 a 24, que es lo que permite el panel", () => {
    expect(horasDeCaducidad("24")).toBe(24);
    expect(horasDeCaducidad("0")).toBe(1);
    expect(horasDeCaducidad("48")).toBe(1);
  });

  it("se lee en singular y plural", () => {
    expect(textoCaducidad(1)).toBe("1 hora");
    expect(textoCaducidad(24)).toBe("24 horas");
  });
});

describe("¿ya tenía cuenta?", () => {
  it("por el código de Supabase", () => {
    expect(yaTieneCuenta({ code: "email_exists" })).toBe(true);
    expect(yaTieneCuenta({ code: "user_already_exists" })).toBe(true);
  });

  it("por el mensaje, en servidores que no mandan código", () => {
    expect(
      yaTieneCuenta({ message: "A user with this email address has already been registered" }),
    ).toBe(true);
  });

  it("otros errores no", () => {
    expect(yaTieneCuenta(null)).toBe(false);
    expect(yaTieneCuenta({ code: "over_email_send_rate_limit", message: "rate limit" })).toBe(false);
  });
});

describe("el correo a invitar", () => {
  it("se normaliza", () => {
    expect(invitarSchema.parse({ email: "  Ana@Correo.COM " }).email).toBe("ana@correo.com");
  });

  it.each(["", "ana", "ana@", "@correo.com", "ana correo@x.com"])("«%s» no vale", (email) => {
    expect(invitarSchema.safeParse({ email }).success).toBe(false);
  });

  it("no acepta algo que no sea texto", () => {
    expect(invitarSchema.safeParse({ email: 42 }).success).toBe(false);
    expect(invitarSchema.safeParse({}).success).toBe(false);
  });
});

describe("el detalle de un enlace que no vale", () => {
  it("los códigos conocidos dan un texto fijo", () => {
    expect(detalleDeEnlace("otp_expired")).toMatch(/caducado/);
    expect(detalleDeEnlace("flow_state_expired")).toMatch(/otro navegador/);
  });

  it("un código desconocido, o ninguno, no da detalle (nunca el texto de la URL)", () => {
    expect(detalleDeEnlace("tu_cuenta_esta_bloqueada_entra_en_otra_web")).toBeNull();
    expect(detalleDeEnlace(null)).toBeNull();
    expect(detalleDeEnlace(undefined)).toBeNull();
  });
});
