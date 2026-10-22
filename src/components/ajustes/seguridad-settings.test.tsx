import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SeguridadSettings } from "./seguridad-settings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// La sonda de Face ID no corre en jsdom: sin lector, nunca se ofrece.
vi.mock("@/components/auth/llave", () => ({
  llavesDisponibles: async () => false,
  dispositivoActual: () => "iPhone",
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

afterEach(cleanup);

const totp = { id: "t1", factor_type: "totp", status: "verified", created_at: "2026-08-01T10:00:00Z" };

describe("Ajustes → Seguridad", () => {
  it("sin factor: desactivada, con «Activar» y el porqué", () => {
    render(<SeguridadSettings factores={[]} />);
    expect(screen.getByText("Verificación en dos pasos")).toBeTruthy();
    expect(screen.getByText("Desactivada")).toBeTruthy();
    const activar = screen.getByRole("link", { name: "Activar" });
    expect(activar.getAttribute("href")).toBe("/2fa/alta?desde=ajustes");
    expect(screen.getByText(/aunque alguien averigüe tu contraseña/)).toBeTruthy();
  });

  it("un factor sin verificar no cuenta como activada", () => {
    render(<SeguridadSettings factores={[{ ...totp, status: "unverified" }]} />);
    expect(screen.getByText("Desactivada")).toBeTruthy();
  });

  it("con factor: lo lista, y no ofrece quitarlo ni Face ID si no está disponible", () => {
    render(<SeguridadSettings factores={[totp]} />);
    expect(screen.getByText("Código de 6 dígitos")).toBeTruthy();
    expect(screen.queryByText("Desactivada")).toBeNull();
    expect(screen.queryByRole("link", { name: "Activar" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Añadir|Quitar|Eliminar/ })).toBeNull();
  });
});
