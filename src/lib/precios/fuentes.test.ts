// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorPrecios,
  aDecimal,
  buscarCandidatos,
  descargarHistorico,
  descargarTiposDeCambio,
  fechaEnZona,
} from "./fuentes";

/**
 * El cliente de precios con `fetch` simulado: lo que Yahoo y el BCE devuelven
 * de verdad (copiado de respuestas reales, recortado), y lo que devuelven
 * cuando algo va mal. La prueba contra los servicios reales vive aparte, en
 * scripts/probar-precios-reales.mjs, porque depende de la red.
 */

// 2026-09-24 … 2026-10-07 a las 08:00 de Fráncfort, como las da Yahoo para un
// fondo. Los dos últimos cierres a null: el fondo aún no ha publicado.
const TIEMPOS_FONDO = [1790229600, 1790316000, 1790575200, 1790661600, 1791180000, 1791266400, 1791352800];
const CIERRES_FONDO = [14.369999885559082, 14.418899536132812, 14.363900184631348, 14.360099792480469, 14.659199714660645, null, null];

function chart({
  currency = "EUR",
  symbol = "0P0001CLDK.F",
  instrumentType = "MUTUALFUND",
  tiempos = TIEMPOS_FONDO,
  cierres = CIERRES_FONDO as (number | null)[],
  zona = "Europe/Berlin",
}: Partial<{
  currency: string | null;
  symbol: string;
  instrumentType: string;
  tiempos: number[] | undefined;
  cierres: (number | null)[];
  zona: string;
}> = {}) {
  return {
    chart: {
      result: [
        {
          meta: {
            currency,
            symbol,
            exchangeName: "FRA",
            fullExchangeName: "Frankfurt",
            instrumentType,
            longName: "Fidelity MSCI World Index EUR P Acc",
            shortName: symbol,
            exchangeTimezoneName: zona,
            gmtoffset: 7200,
          },
          ...(tiempos ? { timestamp: tiempos } : {}),
          indicators: { quote: [tiempos ? { close: cierres } : {}] },
        },
      ],
      error: null,
    },
  };
}

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { "Content-Type": "application/json" } });

/** Un fetch simulado que responde según la URL. */
function simulado(rutas: Array<[RegExp, () => Response | Promise<Response>]>) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    for (const [patron, responder] of rutas) if (patron.test(u)) return responder();
    return new Response("no simulado", { status: 599 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

async function error(promesa: Promise<unknown>): Promise<ErrorPrecios> {
  try {
    await promesa;
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorPrecios);
    return e as ErrorPrecios;
  }
  throw new Error("se esperaba un error");
}

describe("aDecimal: del float de Yahoo a decimal exacto en texto", () => {
  it("normaliza a 6 decimales y quita los ceros sobrantes", () => {
    expect(aDecimal(14.659199714660645)).toBe("14.6592");
    expect(aDecimal(306.64)).toBe("306.64");
    expect(aDecimal(100)).toBe("100");
    expect(aDecimal(0.1 + 0.2)).toBe("0.3");
  });

  it("quita el ruido del float32 de Yahoo: recupera la cifra publicada", () => {
    // Respuestas reales: el DWS Gold LC publicado a 306,64 y Alphabet a 347,68.
    expect(aDecimal(306.6400146484375)).toBe("306.64");
    expect(aDecimal(347.67999267578125)).toBe("347.68");
    expect(aDecimal(123456.78125)).toBe("123456.78");
    expect(aDecimal(1200000)).toBe("1200000");
  });

  it("entre 100 (peniques) moviendo la coma, sin dividir floats", () => {
    expect(aDecimal(1234.56005859375, 100)).toBe("12.3456");
    expect(aDecimal(5, 100)).toBe("0.05");
    expect(aDecimal(0.5, 100)).toBe("0.005");
  });

  it("redondea a 6 decimales con el empate hacia arriba", () => {
    expect(aDecimal(0.0000005)).toBe("0.000001");
    expect(aDecimal(0.1234564)).toBe("0.123456");
    expect(aDecimal(0.12345651)).toBe("0.123457");
    expect(aDecimal(9.9999996)).toBe("10");
  });

  it("no inventa precios: null, NaN, cero, negativos o gigantes son null", () => {
    for (const malo of [null, undefined, Number.NaN, Infinity, 0, -1, 1e15, "14.6", 0.0000001]) {
      expect(aDecimal(malo)).toBeNull();
    }
  });
});

describe("fechaEnZona: el día de mercado, en la zona de la bolsa", () => {
  it("una vela de Fráncfort a las 00:30 locales es de ese día, aunque en UTC sea la víspera", () => {
    const t = Date.UTC(2026, 9, 6, 22, 30) / 1000; // 6 oct 22:30 UTC = 7 oct 00:30 CEST
    expect(fechaEnZona(t, "Europe/Berlin", 7200)).toBe("2026-10-07");
    expect(new Date(t * 1000).toISOString().slice(0, 10)).toBe("2026-10-06");
  });

  it("una vela de Nueva York a la apertura es de ese día", () => {
    expect(fechaEnZona(1791293400, "America/New_York", -14400)).toBe("2026-10-06");
  });

  it("con una zona desconocida usa el desfase que da Yahoo", () => {
    const t = Date.UTC(2026, 9, 6, 23, 0) / 1000;
    expect(fechaEnZona(t, "Marte/Olympus", 7200)).toBe("2026-10-07");
  });
});

describe("descargarHistorico (Yahoo)", () => {
  it("devuelve los cierres en decimal exacto, por fecha de mercado, ignorando los null", async () => {
    const f = simulado([[/v8\/finance\/chart\/0P0001CLDK\.F/, () => json(chart())]]);
    const c = await descargarHistorico("0P0001CLDK.F", "2026-09-20", { fetch: f });

    expect(c).toMatchObject({
      simbolo: "0P0001CLDK.F",
      nombre: "Fidelity MSCI World Index EUR P Acc",
      tipo: "FONDO",
      divisa: "EUR",
      mercado: "Frankfurt",
    });
    expect(c.precios).toEqual([
      { fecha: "2026-09-24", cierre: "14.37" },
      { fecha: "2026-09-25", cierre: "14.4189" },
      { fecha: "2026-09-28", cierre: "14.3639" },
      { fecha: "2026-09-29", cierre: "14.3601" },
      { fecha: "2026-10-05", cierre: "14.6592" },
    ]);
    // Ningún precio es un número: todos texto.
    expect(c.precios.every((p) => typeof p.cierre === "string")).toBe(true);

    // Pide con User-Agent de navegador y un día de margen antes de `desde`.
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain(`period1=${Date.UTC(2026, 8, 19) / 1000}`);
    expect(String(url)).toContain("interval=1d");
    expect((init as RequestInit).headers).toMatchObject({ "User-Agent": expect.stringContaining("Mozilla") });
  });

  it("filtra lo anterior a `desde` y lo posterior a `hasta`", async () => {
    const f = simulado([[/chart/, () => json(chart())]]);
    const c = await descargarHistorico("0P0001CLDK.F", "2026-09-25", { fetch: f, hasta: "2026-09-29" });
    expect(c.precios.map((p) => p.fecha)).toEqual(["2026-09-25", "2026-09-28", "2026-09-29"]);
  });

  it("con dos velas del mismo día se queda con la última (el precio del momento)", async () => {
    const f = simulado([
      [
        /chart/,
        () =>
          json(
            chart({
              currency: "USD",
              symbol: "GOOGL",
              instrumentType: "EQUITY",
              zona: "America/New_York",
              tiempos: [1791293400, 1791316801],
              cierres: [347.67999267578125, 346.035],
            }),
          ),
      ],
    ]);
    const c = await descargarHistorico("GOOGL", "2026-10-01", { fetch: f });
    expect(c.tipo).toBe("ACCION");
    expect(c.divisa).toBe("USD");
    expect(c.precios).toEqual([{ fecha: "2026-10-06", cierre: "346.035" }]);
  });

  it("los peniques de Londres pasan a libras: GBp 1234,5 → GBP 12,345", async () => {
    const f = simulado([[/chart/, () => json(chart({ currency: "GBp", cierres: [1234.5, null, null, null, null, null, null] }))]]);
    const c = await descargarHistorico("VUSA.L", "2026-09-20", { fetch: f });
    expect(c.divisa).toBe("GBP");
    expect(c.precios).toEqual([{ fecha: "2026-09-24", cierre: "12.345" }]);
  });

  it("un rango sin cotizaciones no es un error: lista vacía", async () => {
    const f = simulado([[/chart/, () => json(chart({ tiempos: undefined }))]]);
    const c = await descargarHistorico("0P0001CLDK.F", "2026-10-10", { fetch: f });
    expect(c.precios).toEqual([]);
    expect(c.divisa).toBe("EUR");
  });

  it("todos los cierres a null: lista vacía", async () => {
    const f = simulado([[/chart/, () => json(chart({ tiempos: [1791266400, 1791352800], cierres: [null, null] }))]]);
    expect((await descargarHistorico("0P0001CLDK.F", "2026-10-01", { fetch: f })).precios).toEqual([]);
  });

  it("símbolo inexistente (404 de Yahoo): NO_ENCONTRADO", async () => {
    const f = simulado([
      [/chart/, () => json({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }, 404)],
    ]);
    expect((await error(descargarHistorico("NOEXISTE123", "2026-10-01", { fetch: f }))).codigo).toBe("NO_ENCONTRADO");
  });

  it("el mismo error con un 200: NO_ENCONTRADO", async () => {
    const f = simulado([[/chart/, () => json({ chart: { result: null, error: { code: "Not Found" } } })]]);
    expect((await error(descargarHistorico("NOEXISTE123", "2026-10-01", { fetch: f }))).codigo).toBe("NO_ENCONTRADO");
  });

  it("resultado vacío: NO_ENCONTRADO", async () => {
    const f = simulado([[/chart/, () => json({ chart: { result: [], error: null } })]]);
    expect((await error(descargarHistorico("X", "2026-10-01", { fetch: f }))).codigo).toBe("NO_ENCONTRADO");
  });

  it("error HTTP (429, 500): HTTP", async () => {
    for (const status of [429, 500]) {
      const f = simulado([[/chart/, () => new Response("Too Many Requests", { status })]]);
      expect((await error(descargarHistorico("GOOGL", "2026-10-01", { fetch: f }))).codigo).toBe("HTTP");
    }
  });

  it("cuerpo que no es JSON o sin gráfico: FORMATO", async () => {
    const f1 = simulado([[/chart/, () => new Response("<html>", { status: 200 })]]);
    expect((await error(descargarHistorico("GOOGL", "2026-10-01", { fetch: f1 }))).codigo).toBe("FORMATO");
    const f2 = simulado([[/chart/, () => json({ algo: 1 })]]);
    expect((await error(descargarHistorico("GOOGL", "2026-10-01", { fetch: f2 }))).codigo).toBe("FORMATO");
  });

  it("sin divisa: FORMATO (no se puede saber en qué moneda está el precio)", async () => {
    const f = simulado([[/chart/, () => json(chart({ currency: null }))]]);
    expect((await error(descargarHistorico("GOOGL", "2026-10-01", { fetch: f }))).codigo).toBe("FORMATO");
  });

  it("tiempo agotado: TIEMPO; red caída: RED", async () => {
    const lento = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    expect((await error(descargarHistorico("GOOGL", "2026-10-01", { fetch: lento }))).codigo).toBe("TIEMPO");
    const caido = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await error(descargarHistorico("GOOGL", "2026-10-01", { fetch: caido }))).codigo).toBe("RED");
  });

  it("símbolo con caracteres raros: ni siquiera se pide", async () => {
    const f = simulado([]);
    expect((await error(descargarHistorico("GOOGL/../x", "2026-10-01", { fetch: f }))).codigo).toBe("SIMBOLO_NO_VALIDO");
    expect(f).not.toHaveBeenCalled();
  });

  it("un índice o una divisa no es un instrumento que se pueda seguir (tipo null)", async () => {
    const f = simulado([[/chart/, () => json(chart({ instrumentType: "INDEX" }))]]);
    expect((await descargarHistorico("^GSPC", "2026-09-20", { fetch: f })).tipo).toBeNull();
  });
});

describe("buscarCandidatos (Yahoo)", () => {
  // La búsqueda pide «los últimos 10 días»: se fija el reloj para que las
  // fechas de las respuestas simuladas caigan dentro siempre.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const busqueda = {
    quotes: [
      { symbol: "0P00008T3U.F", quoteType: "MUTUALFUND", longname: "DWS Invest Gold and Prec Mtl Eqs LC", exchDisp: "Frankfurt" },
      { symbol: "0P00008FNQ", quoteType: "MUTUALFUND", longname: "DWS Invest Gold and Prec Mtl Eqs USD LC", exchDisp: "OTC Markets" },
      { symbol: "SGOOG=F", quoteType: "FUTURE", shortname: "Futuro" },
      { symbol: "0P0000ROTO", quoteType: "MUTUALFUND", longname: "Sin gráfico" },
    ],
  };

  it("devuelve cada candidato con su divisa, último precio y la fecha de ese precio", async () => {
    const f = simulado([
      [/v1\/finance\/search/, () => json(busqueda)],
      [/chart\/0P00008T3U\.F/, () => json(chart({ symbol: "0P00008T3U.F", cierres: [300.1, 301.2, 302.3, 303.4, 306.64, null, null] }))],
      [/chart\/0P00008FNQ/, () => json(chart({ symbol: "0P00008FNQ", currency: "USD", cierres: [null, null, 350, 351, null, null, null] }))],
      [/chart\/0P0000ROTO/, () => new Response("{}", { status: 404 })],
    ]);
    const c = await buscarCandidatos("DWS Invest Gold", { fetch: f });
    expect(c).toEqual([
      {
        simbolo: "0P00008T3U.F",
        nombre: "DWS Invest Gold and Prec Mtl Eqs LC",
        tipo: "FONDO",
        divisa: "EUR",
        mercado: "Frankfurt",
        ultimoPrecio: "306.64",
        fechaUltimoPrecio: "2026-10-05",
      },
      {
        simbolo: "0P00008FNQ",
        nombre: "DWS Invest Gold and Prec Mtl Eqs USD LC",
        tipo: "FONDO",
        divisa: "USD",
        mercado: "OTC Markets",
        ultimoPrecio: "351",
        fechaUltimoPrecio: "2026-09-29",
      },
    ]);
    // El futuro no se pide; el fondo sin gráfico se descarta.
    expect(f.mock.calls.some(([u]) => String(u).includes("SGOOG"))).toBe(false);
  });

  it("si se escribe un símbolo exacto que la búsqueda no devuelve, se prueba tal cual", async () => {
    const f = simulado([
      [/v1\/finance\/search/, () => json({ quotes: [] })],
      [/chart\/0P0001CLDK\.F/, () => json(chart())],
    ]);
    const c = await buscarCandidatos("0P0001CLDK.F", { fetch: f });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ simbolo: "0P0001CLDK.F", divisa: "EUR", ultimoPrecio: "14.6592", fechaUltimoPrecio: "2026-10-05" });
  });

  it("sin resultados: lista vacía (un ISIN que Yahoo no conoce)", async () => {
    const f = simulado([
      [/v1\/finance\/search/, () => json({ quotes: [] })],
      [/chart/, () => json({ chart: { result: null, error: { code: "Not Found" } } }, 404)],
    ]);
    expect(await buscarCandidatos("LU0273159177", { fetch: f })).toEqual([]);
  });

  it("consulta demasiado corta: ni se pregunta", async () => {
    const f = simulado([]);
    expect(await buscarCandidatos(" a ", { fetch: f })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("si la búsqueda falla, es un error HTTP", async () => {
    const f = simulado([[/search/, () => new Response("", { status: 503 })]]);
    expect((await error(buscarCandidatos("Fidelity", { fetch: f }))).codigo).toBe("HTTP");
  });
});

describe("descargarTiposDeCambio (BCE)", () => {
  const CSV = [
    "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE_COMPL",
    'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-02,1.1225,A,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)"',
    'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-05,1.1204,A,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)"',
    'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-06,1.12690,A,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)"',
    "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-07,NaN,A,x",
    "",
  ].join("\r\n");

  it("lee fecha y tipo como texto decimal exacto, aunque los títulos lleven comas", async () => {
    const f = simulado([[/data-api\.ecb\.europa\.eu.*D\.USD\.EUR\.SP00\.A\?startPeriod=2026-10-01/, () => new Response(CSV)]]);
    expect(await descargarTiposDeCambio("USD", "2026-10-01", { fetch: f })).toEqual([
      { fecha: "2026-10-02", tasa: "1.1225" },
      { fecha: "2026-10-05", tasa: "1.1204" },
      { fecha: "2026-10-06", tasa: "1.1269" },
    ]);
  });

  it("404 (sin observaciones en el rango o divisa desconocida): lista vacía", async () => {
    const f = simulado([[/ecb/, () => new Response("No results found.", { status: 404 })]]);
    expect(await descargarTiposDeCambio("XXX", "2026-10-01", { fetch: f })).toEqual([]);
  });

  it("otro error HTTP: HTTP", async () => {
    const f = simulado([[/ecb/, () => new Response("", { status: 500 })]]);
    expect((await error(descargarTiposDeCambio("USD", "2026-10-01", { fetch: f }))).codigo).toBe("HTTP");
  });

  it("un CSV sin las columnas esperadas: FORMATO", async () => {
    const f = simulado([[/ecb/, () => new Response("A,B\n1,2\n")]]);
    expect((await error(descargarTiposDeCambio("USD", "2026-10-01", { fetch: f }))).codigo).toBe("FORMATO");
  });

  it("el euro no tiene tipo de cambio contra sí mismo", async () => {
    expect((await error(descargarTiposDeCambio("EUR", "2026-10-01", { fetch: simulado([]) }))).codigo).toBe("FORMATO");
  });
});
