import { describe, expect, it } from "vitest";
import {
  OPCIONES_CREAR_LLAVE,
  biometriaDe,
  dispositivoDe,
  mensajeFalloLlave,
  motivoFalloLlave,
  nombreDeLlave,
  planDeVerificacion,
  type FactorResumen,
} from "./segundo-factor";

const totp = (id = "t1", status = "verified", created_at = "2026-08-01T10:00:00Z"): FactorResumen => ({
  id,
  factor_type: "totp",
  status,
  created_at,
});
const llave = (
  id: string,
  friendly_name: string,
  created_at = "2026-10-01T10:00:00Z",
  status = "verified",
): FactorResumen => ({ id, factor_type: "webauthn", status, friendly_name, created_at });

describe("qué se ofrece al entrar", () => {
  it("solo código: el formulario de siempre", () => {
    expect(planDeVerificacion([totp()], true)).toEqual({
      modo: "codigo",
      totp: totp(),
      llaveSinSoporte: false,
    });
  });

  it("llave y código, con navegador capaz: la llave delante y el código como alternativa", () => {
    const plan = planDeVerificacion([totp(), llave("w1", "iPhone · 19/10/2026")], true);
    expect(plan.modo).toBe("llave");
    if (plan.modo !== "llave") return;
    expect(plan.llaves.map((l) => l.id)).toEqual(["w1"]);
    expect(plan.totp?.id).toBe("t1");
  });

  it("solo llave: sin alternativa de código", () => {
    const plan = planDeVerificacion([llave("w1", "iPhone")], true);
    expect(plan).toMatchObject({ modo: "llave", totp: null });
  });

  it("llave en un navegador que no puede: al código, avisando", () => {
    expect(planDeVerificacion([totp(), llave("w1", "iPhone")], false)).toEqual({
      modo: "codigo",
      totp: totp(),
      llaveSinSoporte: true,
    });
  });

  it("solo llave en un navegador que no puede: no hay forma de seguir aquí", () => {
    expect(planDeVerificacion([llave("w1", "iPhone")], false)).toEqual({ modo: "sin-soporte" });
  });

  it("los factores sin verificar no cuentan", () => {
    expect(planDeVerificacion([totp("t9", "unverified"), llave("w9", "x", undefined, "unverified")], true)).toEqual({
      modo: "ninguno",
    });
  });

  it("varias llaves: primero la de un dispositivo como este, luego la más reciente", () => {
    const factores = [
      llave("viejo-iphone", "iPhone · 01/09/2026", "2026-09-01T10:00:00Z"),
      llave("android", "Android · 15/10/2026", "2026-10-15T10:00:00Z"),
      llave("nuevo-iphone", "iPhone · 10/10/2026", "2026-10-10T10:00:00Z"),
    ];
    const enIphone = planDeVerificacion(factores, true, "iPhone");
    const enAndroid = planDeVerificacion(factores, true, "Android");
    const sinSaber = planDeVerificacion(factores, true, null);
    if (enIphone.modo !== "llave" || enAndroid.modo !== "llave" || sinSaber.modo !== "llave") {
      throw new Error("debería ofrecer la llave");
    }
    expect(enIphone.llaves.map((l) => l.id)).toEqual(["nuevo-iphone", "viejo-iphone", "android"]);
    expect(enAndroid.llaves[0].id).toBe("android");
    expect(sinSaber.llaves[0].id).toBe("android");
  });

  it("con varios códigos, el más reciente", () => {
    const plan = planDeVerificacion(
      [totp("viejo", "verified", "2026-01-01T00:00:00Z"), totp("nuevo", "verified", "2026-06-01T00:00:00Z")],
      true,
    );
    expect(plan).toMatchObject({ modo: "codigo", totp: { id: "nuevo" } });
  });
});

describe("por qué falla la llave", () => {
  it("WebAuthn sin activar en Supabase (alta y verificación)", () => {
    expect(motivoFalloLlave({ code: "mfa_webauthn_enroll_not_enabled", message: "x" })).toBe("no-habilitado");
    expect(motivoFalloLlave({ code: "mfa_webauthn_verify_not_enabled", message: "x" })).toBe("no-habilitado");
  });

  it("servidores que no conocen el tipo de factor", () => {
    expect(
      motivoFalloLlave({ code: "validation_failed", message: "Invalid factor_type: must be totp or phone" }),
    ).toBe("no-habilitado");
    expect(motivoFalloLlave({ message: "MFA enroll is disabled for WebAuthn" })).toBe("no-habilitado");
  });

  it("la persona cierra el aviso de Face ID", () => {
    const cancelado = { code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", cause: { name: "NotAllowedError" } };
    expect(motivoFalloLlave(cancelado)).toBe("cancelado");
    expect(motivoFalloLlave({ code: "ERROR_CEREMONY_ABORTED" })).toBe("cancelado");
    expect(motivoFalloLlave({ name: "NotAllowedError" })).toBe("cancelado");
  });

  it("navegador sin WebAuthn", () => {
    expect(motivoFalloLlave({ message: "Browser does not support WebAuthn" })).toBe("sin-soporte");
  });

  it("ya había una llave en este dispositivo", () => {
    expect(motivoFalloLlave({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" })).toBe("ya-registrada");
  });

  it("dominio que no cuadra", () => {
    expect(motivoFalloLlave({ code: "ERROR_INVALID_RP_ID" })).toBe("dominio");
    expect(motivoFalloLlave({ code: "ERROR_INVALID_DOMAIN" })).toBe("dominio");
  });

  it("lo demás", () => {
    expect(motivoFalloLlave(null)).toBe("otro");
    expect(motivoFalloLlave("texto")).toBe("otro");
    expect(motivoFalloLlave({ code: "mfa_verification_failed", message: "Invalid" })).toBe("otro");
  });

  it("cada motivo tiene un mensaje en castellano con el nombre de la biometría", () => {
    for (const motivo of ["no-habilitado", "cancelado", "sin-soporte", "dominio", "otro"] as const) {
      expect(mensajeFalloLlave(motivo, "Face ID")).toMatch(/Face ID/);
    }
    expect(mensajeFalloLlave("no-habilitado", "Face ID")).toMatch(/código de 6 dígitos/);
  });
});

describe("el dispositivo", () => {
  const UA = {
    iphone:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    android:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  };

  it("reconoce los habituales", () => {
    expect(dispositivoDe(UA.iphone)).toBe("iPhone");
    expect(dispositivoDe(UA.android)).toBe("Android");
    expect(dispositivoDe(UA.windows)).toBe("Windows");
    expect(dispositivoDe(UA.ipad, 0)).toBe("Mac");
  });

  it("el iPad que se hace pasar por Mac se delata por la pantalla táctil", () => {
    expect(dispositivoDe(UA.ipad, 5)).toBe("iPad");
  });

  it("y nombra su biometría", () => {
    expect(biometriaDe("iPhone")).toBe("Face ID");
    expect(biometriaDe("Mac")).toBe("Touch ID");
    expect(biometriaDe("Android")).toBe("la huella");
    expect(biometriaDe("Windows")).toBe("Windows Hello");
    expect(biometriaDe("Linux")).toBe("Face ID / huella");
  });

  it("el nombre de la llave lleva el dispositivo y fecha con hora (Supabase no admite repetidos)", () => {
    const nombre = nombreDeLlave("iPhone", new Date(2026, 9, 19, 14, 32));
    expect(nombre.startsWith("iPhone · ")).toBe(true);
    expect(nombre).toMatch(/19\/10\/2026/);
    expect(nombre).toMatch(/14:32/);
  });
});

describe("las opciones de creación", () => {
  it("piden el lector del propio dispositivo, no una llave USB", () => {
    // auth-js trae por defecto `cross-platform` y la pista `security-key`, que
    // en un iPhone abren el diálogo de llave de seguridad en vez de Face ID.
    expect(OPCIONES_CREAR_LLAVE.authenticatorSelection.authenticatorAttachment).toBe("platform");
    expect(OPCIONES_CREAR_LLAVE.authenticatorSelection.userVerification).toBe("required");
    expect(OPCIONES_CREAR_LLAVE.hints).not.toContain("security-key");
  });
});
