// @vitest-environment node
// La guía la llama `unstable_doesProxyMatch`, pero esta versión de Next aún la
// exporta con el nombre de antes del cambio de middleware a proxy.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { config } from "./proxy";

/*
 * Qué pasa por el proxy y qué no. Lo que se salta el proxy se salta también la
 * redirección a /entrar y la CSP, así que la lista de excepciones tiene que ser
 * exactamente la que se pretende y ni una ruta más.
 *
 * El fallo que motivó esto: la exclusión de imágenes miraba solo la extensión,
 * así que `/movimientos/x.png` (una ruta dinámica con id «x.png») montaba la
 * app sin pasar por aquí. La RLS no dejaba ver nada, pero la respuesta salía
 * sin CSP y sin el encaminamiento de acceso.
 */
function pasa(url: string): boolean {
  return unstable_doesMiddlewareMatch({ config, nextConfig, url });
}

describe("rutas que se saltan el proxy", () => {
  it.each([
    "/_next/static/chunks/app.js",
    "/_next/image",
    "/favicon.ico",
    "/manifest.webmanifest",
    "/sw.js",
    "/sin-conexion",
    "/api/ingest",
    "/api/notificar",
    "/api/precios",
    "/icono-192.png",
    "/apple-touch-icon.png",
  ])("%s", (url) => {
    expect(pasa(url)).toBe(false);
  });
});

describe("rutas que pasan por el proxy", () => {
  it.each([
    "/",
    "/resumen",
    "/entrar",
    "/invitacion",
    "/disenio",
    "/api/exportar",
    "/api/informe",
    // Una ruta dinámica cuyo parámetro termina como un fichero estático.
    "/movimientos/x.png",
    "/movimientos/ab12.svg",
    "/cuentas/foo.ico",
    // Un prefijo de una excepción no es la excepción.
    "/api/ingestion",
    "/api/ingest/otra",
    "/api/precios-viejos",
    "/sin-conexionx",
    "/sw.jsx",
  ])("%s", (url) => {
    expect(pasa(url)).toBe(true);
  });
});
