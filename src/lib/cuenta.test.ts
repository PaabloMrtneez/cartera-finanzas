import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bienvenidaPendiente,
  borrarBienvenida,
  borrarRegistroReciente,
  dejarRegistroReciente,
  duracionCuenta,
  easeOutExpo,
  evaluarRegistro,
  FRESCURA_MS,
  marcarBienvenidaVista,
} from "./cuenta";

afterEach(() => {
  vi.useRealTimers();
  borrarRegistroReciente();
  borrarBienvenida();
});

describe("easeOutExpo", () => {
  it("toca los extremos exactos, sin salto al final", () => {
    expect(easeOutExpo(0)).toBe(0);
    expect(easeOutExpo(1)).toBe(1);
    // Fuera de rango no se desmadra.
    expect(easeOutExpo(-0.5)).toBe(0);
    expect(easeOutExpo(2)).toBe(1);
  });

  it("va por delante de la recta: rápido al principio (ease-out)", () => {
    // A mitad de tiempo ya ha recorrido mucho más de la mitad del camino.
    expect(easeOutExpo(0.5)).toBeGreaterThan(0.9);
    // Creciente en todo el tramo.
    expect(easeOutExpo(0.25)).toBeLessThan(easeOutExpo(0.75));
  });
});

describe("duracionCuenta", () => {
  it("respeta el suelo y el techo", () => {
    expect(duracionCuenta(0)).toBe(1200);
    // Un importe enorme se queda en el techo, no lo supera.
    expect(duracionCuenta(999_999_999)).toBe(9000);
  });

  it("crece con la cantidad, sin salirse del rango", () => {
    const cafe = duracionCuenta(250); // 2,50 €
    const cena = duracionCuenta(4_500); // 45 €
    const alquiler = duracionCuenta(120_000); // 1200 €
    expect(cafe).toBeLessThan(cena);
    expect(cena).toBeLessThan(alquiler);
    for (const d of [cafe, cena, alquiler]) {
      expect(d).toBeGreaterThanOrEqual(1200);
      expect(d).toBeLessThanOrEqual(9000);
    }
    // Un pago pequeño no se acerca al techo.
    expect(cafe).toBeLessThan(1800);
  });

  it("no depende del signo del delta", () => {
    expect(duracionCuenta(-4_500)).toBe(duracionCuenta(4_500));
  });
});

describe("la señal de registro reciente", () => {
  it("una señal fresca y del mes que se ve, anima y se consume", () => {
    dejarRegistroReciente({ tipo: "EXPENSE", delta: 1234, mes: "2026-09-01" });
    const ev = evaluarRegistro("2026-09-01");
    expect(ev.animar).toMatchObject({ tipo: "EXPENSE", delta: 1234, mes: "2026-09-01" });
    expect(ev.limpiar).toBe(true);
  });

  it("una señal de OTRO mes no anima ni se limpia (espera a su mes)", () => {
    dejarRegistroReciente({ tipo: "INCOME", delta: 5000, mes: "2026-08-01" });
    const ev = evaluarRegistro("2026-09-01");
    expect(ev.animar).toBeNull();
    expect(ev.limpiar).toBe(false);
  });

  it("una señal caduca no anima y se limpia", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T10:00:00"));
    dejarRegistroReciente({ tipo: "EXPENSE", delta: 1234, mes: "2026-09-01" });
    // Pasado el margen de frescura.
    vi.setSystemTime(new Date(Date.now() + FRESCURA_MS + 1));
    const ev = evaluarRegistro("2026-09-01");
    expect(ev.animar).toBeNull();
    expect(ev.limpiar).toBe(true);
  });

  it("sin señal, ni anima ni pide limpiar", () => {
    const ev = evaluarRegistro("2026-09-01");
    expect(ev.animar).toBeNull();
    expect(ev.limpiar).toBe(false);
  });
});

describe("la marca de bienvenida", () => {
  it("está pendiente la primera vez y deja de estarlo al marcarla", () => {
    // Sin marca todavía: primera carga de la sesión.
    expect(bienvenidaPendiente()).toBe(true);
    marcarBienvenidaVista();
    // Ya vista: las visitas siguientes no vuelven a contar.
    expect(bienvenidaPendiente()).toBe(false);
  });

  it("marcarla es idempotente (el doble montaje de StrictMode no molesta)", () => {
    marcarBienvenidaVista();
    marcarBienvenidaVista();
    expect(bienvenidaPendiente()).toBe(false);
  });

  it("no toca la señal de registro: son marcas independientes", () => {
    dejarRegistroReciente({ tipo: "EXPENSE", delta: 1234, mes: "2026-09-01" });
    marcarBienvenidaVista();
    // La bienvenida ya se vio, pero el registro sigue disponible para animar.
    expect(bienvenidaPendiente()).toBe(false);
    expect(evaluarRegistro("2026-09-01").animar).toMatchObject({ delta: 1234 });
  });
});
