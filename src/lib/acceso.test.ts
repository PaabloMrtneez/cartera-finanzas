import { describe, expect, it } from "vitest";
import { destinoConSesion, destinoSinSesion, estaDentro, tieneSegundoFactor } from "./acceso";

/*
 * El segundo factor es OPCIONAL (migración 20261019090000): sin factor se
 * entra con la contraseña; con factor, solo tras superarlo. `nextLevel` dice si
 * hay factor (aal2) o no (aal1), sea código o llave: el encaminamiento no
 * distingue entre ellos.
 */
const AAL1_CON_FACTOR = { currentLevel: "aal1", nextLevel: "aal2" };
const AAL1_SIN_FACTOR = { currentLevel: "aal1", nextLevel: "aal1" };
const AAL2 = { currentLevel: "aal2", nextLevel: "aal2" };

describe("sin sesión", () => {
  it.each(["/entrar", "/invitacion"])("%s se abre", (path) => {
    expect(destinoSinSesion(path)).toBeNull();
  });

  it.each(["/2fa", "/2fa/alta", "/resumen", "/movimientos/nuevo", "/api/exportar", "/"])(
    "%s manda a /entrar",
    (path) => {
      expect(destinoSinSesion(path)).toBe("/entrar");
    },
  );

  it("no confunde un prefijo con la ruta", () => {
    expect(destinoSinSesion("/entrarx")).toBe("/entrar");
    expect(destinoSinSesion("/2fax")).toBe("/entrar");
  });
});

describe("¿dentro?", () => {
  it("con factor, solo tras superarlo", () => {
    expect(tieneSegundoFactor(AAL1_CON_FACTOR)).toBe(true);
    expect(estaDentro(AAL1_CON_FACTOR)).toBe(false);
    expect(estaDentro(AAL2)).toBe(true);
  });

  it("sin factor, con la contraseña basta", () => {
    expect(tieneSegundoFactor(AAL1_SIN_FACTOR)).toBe(false);
    expect(estaDentro(AAL1_SIN_FACTOR)).toBe(true);
  });

  it("sin poder leer el nivel, nunca", () => {
    expect(estaDentro(null)).toBe(false);
  });
});

describe("con un factor dado de alta y solo la contraseña (aal1): como siempre", () => {
  it("/2fa se abre", () => {
    expect(destinoConSesion("/2fa", AAL1_CON_FACTOR)).toBeNull();
  });

  it.each(["/2fa/alta", "/entrar", "/resumen", "/ajustes", "/api/exportar"])(
    "%s manda a /2fa",
    (path) => {
      expect(destinoConSesion(path, AAL1_CON_FACTOR)).toBe("/2fa");
    },
  );
});

describe("sin factor y solo la contraseña (aal1): dentro", () => {
  it.each(["/resumen", "/movimientos", "/ajustes", "/api/exportar"])("%s se abre", (path) => {
    expect(destinoConSesion(path, AAL1_SIN_FACTOR)).toBeNull();
  });

  it("ya NO se le obliga a dar de alta el segundo factor", () => {
    expect(destinoConSesion("/resumen", AAL1_SIN_FACTOR)).not.toBe("/2fa/alta");
  });

  it("/2fa/alta sigue abierto: activarlo es opcional y se llega desde Ajustes o la bienvenida", () => {
    expect(destinoConSesion("/2fa/alta", AAL1_SIN_FACTOR)).toBeNull();
  });

  it.each(["/entrar", "/2fa"])("%s lleva a la app: no hay nada que verificar", (path) => {
    expect(destinoConSesion(path, AAL1_SIN_FACTOR)).toBe("/resumen");
  });
});

describe("con factor superado (aal2)", () => {
  it.each(["/entrar", "/2fa", "/2fa/alta"])("%s lleva a la app", (path) => {
    expect(destinoConSesion(path, AAL2)).toBe("/resumen");
  });

  it.each(["/resumen", "/movimientos", "/ajustes", "/api/exportar"])("%s se abre", (path) => {
    expect(destinoConSesion(path, AAL2)).toBeNull();
  });
});

describe("si no se pudo leer el nivel", () => {
  it("a /2fa, que lo vuelve a mirar; nunca dentro", () => {
    expect(destinoConSesion("/resumen", null)).toBe("/2fa");
    expect(destinoConSesion("/2fa", null)).toBeNull();
  });
});

describe("la invitación", () => {
  it("se abre con cualquier nivel: va antes que todo lo demás", () => {
    expect(destinoConSesion("/invitacion", AAL1_SIN_FACTOR)).toBeNull();
    expect(destinoConSesion("/invitacion", AAL1_CON_FACTOR)).toBeNull();
    expect(destinoConSesion("/invitacion", AAL2)).toBeNull();
  });

  it("se abre sin sesión: el enlace llega por WhatsApp y aún no se ha canjeado", () => {
    expect(destinoSinSesion("/invitacion")).toBeNull();
  });
});

describe("con una llave (Face ID) en vez del código, lo mismo", () => {
  const AAL1_CON_LLAVE = { currentLevel: "aal1", nextLevel: "aal2" };
  const AAL2_CON_LLAVE = { currentLevel: "aal2", nextLevel: "aal2" };

  it("tras la contraseña va a /2fa", () => {
    expect(destinoConSesion("/resumen", AAL1_CON_LLAVE)).toBe("/2fa");
    expect(destinoConSesion("/2fa", AAL1_CON_LLAVE)).toBeNull();
  });

  it("tras superarla, dentro", () => {
    expect(destinoConSesion("/resumen", AAL2_CON_LLAVE)).toBeNull();
    expect(destinoConSesion("/2fa", AAL2_CON_LLAVE)).toBe("/resumen");
  });
});
