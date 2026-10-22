import { describe, expect, it, vi } from "vitest";
import { FILAS_POR_PAGINA, leerTodo } from "./paginar";

/** Simula PostgREST: `total` filas numeradas y el tope silencioso de `tope` por respuesta. */
function servidor(total: number, tope = FILAS_POR_PAGINA) {
  const llamadas: Array<[number, number]> = [];
  const consulta = vi.fn(async (desde: number, hasta: number) => {
    llamadas.push([desde, hasta]);
    const fin = Math.min(hasta + 1, total, desde + tope);
    const data = Array.from({ length: Math.max(0, fin - desde) }, (_, i) => ({ n: desde + i }));
    return { data, error: null };
  });
  return { consulta, llamadas };
}

describe("leerTodo", () => {
  it("con menos de una página, una sola llamada", async () => {
    const { consulta, llamadas } = servidor(10);
    const r = await leerTodo(consulta);
    expect(r.data).toHaveLength(10);
    expect(llamadas).toEqual([[0, 999]]);
  });

  it("con 2.500 filas, las trae TODAS y en orden (tres páginas)", async () => {
    const { consulta, llamadas } = servidor(2500);
    const r = await leerTodo(consulta);
    expect(r.error).toBeNull();
    expect(r.data.map((f) => f.n)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
    expect(llamadas).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("justo 1.000 filas: pide una página más (vacía) para saber que no hay más", async () => {
    const { consulta, llamadas } = servidor(1000);
    const r = await leerTodo(consulta);
    expect(r.data).toHaveLength(1000);
    expect(llamadas).toHaveLength(2);
  });

  it("respeta el máximo y no pide de más", async () => {
    const { consulta, llamadas } = servidor(5000);
    const r = await leerTodo(consulta, { maximo: 1500 });
    expect(r.data).toHaveLength(1500);
    expect(llamadas).toEqual([
      [0, 999],
      [1000, 1499],
    ]);
  });

  it("un error corta y lo devuelve, con lo leído hasta entonces", async () => {
    let n = 0;
    const r = await leerTodo(async (desde) => {
      n++;
      if (n === 2) return { data: null, error: { message: "fallo" } };
      return { data: Array.from({ length: 1000 }, (_, i) => desde + i), error: null };
    });
    expect(r.error?.message).toBe("fallo");
    expect(r.data).toHaveLength(1000);
  });

  it("rechaza un tamaño de página absurdo", async () => {
    await expect(leerTodo(async () => ({ data: [], error: null }), { pagina: 0 })).rejects.toThrow(RangeError);
  });
});
