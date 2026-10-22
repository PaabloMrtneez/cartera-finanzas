import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ErrorPrecios, aDecimal, descargarHistorico, descargarTiposDeCambio } from "./fuentes";

/**
 * Fuentes de precios ante datos y redes hostiles (fase 1: robustez). Complementa
 * fuentes.test.ts: aquí, propiedades de `aDecimal` y respuestas raras de Yahoo
 * y del BCE. Todo con fetch simulado; nada sale a la red.
 */

const SEMILLA = { seed: 20261019, numRuns: 5000 };

function fetchQueDevuelve(cuerpo: unknown, status = 200, tipo = "application/json"): typeof fetch {
  return (async () =>
    new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), {
      status,
      headers: { "content-type": tipo },
    })) as unknown as typeof fetch;
}

const grafico = (cierres: unknown[], meta: Record<string, unknown> = {}) => ({
  chart: {
    result: [
      {
        meta: { currency: "EUR", symbol: "X", instrumentType: "MUTUALFUND", exchangeTimezoneName: "Europe/Berlin", ...meta },
        timestamp: cierres.map((_, i) => Date.UTC(2026, 9, 5 + i, 12) / 1000),
        indicators: { quote: [{ close: cierres }] },
      },
    ],
    error: null,
  },
});

describe("aDecimal · cualquier doble", () => {
  it("devuelve null o un decimal limpio, positivo, ≤ 6 decimales, a menos de 1e-6 del dato", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (x) => {
        const r = aDecimal(x);
        if (r === null) return;
        expect(r).toMatch(/^\d+(\.\d{1,6})?$/);
        expect(Number(r)).toBeGreaterThan(0);
        expect(Math.abs(Number(r) - x)).toBeLessThanOrEqual(5e-7 + Math.abs(x) * 1e-7);
      }),
      SEMILLA,
    );
  });

  it("nunca acepta lo que no es un precio", () => {
    for (const x of [null, undefined, "12.3", Number.NaN, 0, -0, -1, Infinity, -Infinity, 1e14, 1e-9, {}, []]) {
      expect(aDecimal(x)).toBeNull();
    }
  });
});

describe("Yahoo · respuestas raras", () => {
  it("cierres a 0, negativos, texto o NaN se ignoran; los buenos se quedan", async () => {
    const c = await descargarHistorico("X", "2026-10-01", {
      fetch: fetchQueDevuelve(grafico([10.5, 0, -3, "11", null, 12.25])),
      hasta: "2026-10-31",
    });
    expect(c.precios.map((p) => p.cierre)).toEqual(["10.5", "12.25"]);
  });

  it("timestamps y cierres de distinta longitud: no revienta", async () => {
    const cuerpo = grafico([1, 2, 3]);
    (cuerpo.chart.result[0] as { timestamp: number[] }).timestamp.push(Date.UTC(2026, 9, 20) / 1000);
    const c = await descargarHistorico("X", "2026-10-01", { fetch: fetchQueDevuelve(cuerpo), hasta: "2026-10-31" });
    expect(c.precios).toHaveLength(3);
  });

  it("chart.result que no es una lista, o vacía: NO_ENCONTRADO (no un TypeError)", async () => {
    for (const result of [{}, "x", 5, []]) {
      await expect(
        descargarHistorico("X", "2026-10-01", { fetch: fetchQueDevuelve({ chart: { result, error: null } }) }),
      ).rejects.toMatchObject({ codigo: "NO_ENCONTRADO" });
    }
  });

  it("JSON truncado o HTML de una página de error: FORMATO", async () => {
    for (const cuerpo of ['{"chart": {"result": [', "<html>Too Many Requests</html>"]) {
      await expect(
        descargarHistorico("X", "2026-10-01", { fetch: fetchQueDevuelve(cuerpo) }),
      ).rejects.toMatchObject({ codigo: "FORMATO" });
    }
  });

  it("429 y 503: HTTP (no hay reintentos; el siguiente cron lo vuelve a intentar)", async () => {
    let llamadas = 0;
    const f = (async () => {
      llamadas++;
      return new Response("", { status: 429 });
    }) as unknown as typeof fetch;
    await expect(descargarHistorico("X", "2026-10-01", { fetch: f })).rejects.toBeInstanceOf(ErrorPrecios);
    expect(llamadas).toBe(1);
  });

  it("un fetch que se cuelga se corta con TIEMPO al vencer el plazo", async () => {
    const colgado = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, rechazar) => init.signal.addEventListener("abort", () => rechazar(init.signal.reason)))) as unknown as typeof fetch;
    await expect(descargarHistorico("X", "2026-10-01", { fetch: colgado, timeoutMs: 20 })).rejects.toMatchObject({ codigo: "TIEMPO" });
  });

  // H-19 (bajo): una divisa de tres letras que no existe («XYZ») se acepta.
  // El BCE responderá 404 → lista vacía de cambios, y la posición se quedará
  // sin poder valorarse en euros sin que nada lo explique.
  it("una divisa que no existe (XYZ) se rechaza al dar de alta", async () => {
    await expect(
      descargarHistorico("X", "2026-10-01", { fetch: fetchQueDevuelve(grafico([10], { currency: "XYZ" })) }),
    ).rejects.toMatchObject({ codigo: "FORMATO" });
  });
});

describe("BCE · CSV raro, fines de semana y festivos", () => {
  const csv = (filas: string[]) => ["KEY,FREQ,TIME_PERIOD,OBS_VALUE,TITLE", ...filas].join("\r\n");

  it("valores vacíos, NaN, negativos, cero o con coma se ignoran; BOM y CRLF no molestan", async () => {
    const cuerpo =
      "﻿" +
      csv([
        'EXR.D.USD,D,2026-10-02,1.1269,"Dólar, EE. UU."',
        "EXR.D.USD,D,2026-10-03,,x",
        "EXR.D.USD,D,2026-10-04,NaN,x",
        "EXR.D.USD,D,2026-10-05,-1.2,x",
        "EXR.D.USD,D,2026-10-06,0.0000,x",
        'EXR.D.USD,D,2026-10-07,"1,13",x',
        "EXR.D.USD,D,2026-10-08,1.130000,x",
      ]);
    const r = await descargarTiposDeCambio("USD", "2026-10-01", { fetch: fetchQueDevuelve(cuerpo, 200, "text/csv") });
    expect(r).toEqual([
      { fecha: "2026-10-02", tasa: "1.1269" },
      { fecha: "2026-10-08", tasa: "1.13" },
    ]);
  });

  it("un fin de semana o un festivo (TARGET) sin observaciones: 404 → lista vacía, no error", async () => {
    const r = await descargarTiposDeCambio("USD", "2026-12-25", { fetch: fetchQueDevuelve("", 404, "text/csv") });
    expect(r).toEqual([]);
  });

  it("solo la cabecera, o un cuerpo vacío: lista vacía", async () => {
    expect(await descargarTiposDeCambio("USD", "2026-10-01", { fetch: fetchQueDevuelve(csv([]), 200, "text/csv") })).toEqual([]);
    expect(await descargarTiposDeCambio("USD", "2026-10-01", { fetch: fetchQueDevuelve("", 200, "text/csv") })).toEqual([]);
  });

  it("429 o 500 del BCE: HTTP; divisa con minúsculas o el euro: FORMATO sin llamar a la red", async () => {
    await expect(descargarTiposDeCambio("USD", "2026-10-01", { fetch: fetchQueDevuelve("", 429) })).rejects.toMatchObject({ codigo: "HTTP" });
    await expect(descargarTiposDeCambio("USD", "2026-10-01", { fetch: fetchQueDevuelve("", 500) })).rejects.toMatchObject({ codigo: "HTTP" });
    const nunca = (() => {
      throw new Error("no debería llamar");
    }) as unknown as typeof fetch;
    await expect(descargarTiposDeCambio("usd", "2026-10-01", { fetch: nunca })).rejects.toMatchObject({ codigo: "FORMATO" });
    await expect(descargarTiposDeCambio("EUR", "2026-10-01", { fetch: nunca })).rejects.toMatchObject({ codigo: "FORMATO" });
    await expect(descargarTiposDeCambio("USD", "1/10/2026", { fetch: nunca })).rejects.toMatchObject({ codigo: "FORMATO" });
  });
});
