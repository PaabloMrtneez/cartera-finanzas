import { describe, expect, it } from "vitest";
import { direccionNavegacion as dir } from "./transicion";

/**
 * La dirección de la transición de pantalla. Un deslizamiento en el sentido
 * equivocado desorienta más que no animar, así que cada caso dudoso tiene que
 * caer en `ninguna`.
 */
describe("direccionNavegacion", () => {
  it("cambiar de pestaña no anima", () => {
    expect(dir("/resumen", "/movimientos")).toBe("ninguna");
    expect(dir("/cuentas", "/ajustes")).toBe("ninguna");
    // Tocar otra pestaña estando dentro de una: también es cambio de pestaña.
    expect(dir("/patrimonio", "/resumen")).toBe("ninguna");
    expect(dir("/movimientos/abc", "/ajustes")).toBe("ninguna");
  });

  it("bajar un nivel es push y subirlo es pop", () => {
    expect(dir("/cuentas", "/patrimonio")).toBe("push");
    expect(dir("/patrimonio", "/cuentas")).toBe("pop");
    expect(dir("/ajustes", "/categorias")).toBe("push");
    expect(dir("/categorias", "/ajustes")).toBe("pop");
    expect(dir("/movimientos", "/movimientos/abc")).toBe("push");
    expect(dir("/movimientos/abc", "/movimientos")).toBe("pop");
    expect(dir("/ajustes", "/importar")).toBe("push");
  });

  it("entrar en un detalle desde otra pestaña sigue siendo push", () => {
    expect(dir("/resumen", "/movimientos/abc")).toBe("push");
  });

  it("volver con el historial a otra pestaña es pop", () => {
    expect(dir("/movimientos/abc", "/resumen", { historial: true })).toBe("pop");
    expect(dir("/resumen", "/movimientos/abc", { historial: true })).toBe("push");
  });

  it("dos pantallas del mismo nivel no animan", () => {
    expect(dir("/patrimonio", "/inversiones")).toBe("ninguna");
    expect(dir("/analisis", "/movimientos/abc")).toBe("ninguna");
    expect(dir("/resumen", "/resumen")).toBe("ninguna");
  });

  it("la hoja sube al abrirse y baja al cerrarse, vaya a donde vaya", () => {
    expect(dir("/resumen", "/movimientos/nuevo")).toBe("hoja-sube");
    expect(dir("/movimientos/abc", "/movimientos/nuevo")).toBe("hoja-sube");
    expect(dir("/movimientos/nuevo", "/movimientos")).toBe("hoja-baja");
    expect(dir("/movimientos/nuevo", "/resumen", { historial: true })).toBe("hoja-baja");
  });
});
