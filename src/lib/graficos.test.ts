import { describe, expect, it } from "vitest";
import {
  EJE_SEPARACION,
  agruparFranjas,
  anchoEstimadoRotulo,
  apilar,
  cambiosCompromiso,
  cascada,
  diferenciasDiarias,
  listaNombres,
  nivelCalor,
  proyeccionLineal,
  tasaAgregada,
  tasaAhorro,
  cerrarArea,
  contraMedia,
  escalaBonita,
  extremos,
  indiceColumna,
  indiceLinea,
  lecturasNivel,
  mediaEntera,
  rotuloEje,
  rotulosEjeVisibles,
  rutaRecta,
  sectorEnAngulo,
  sectoresAnillo,
  tramos,
  ultimoConDato,
  variacionImporte,
} from "./graficos";
import { MINUS, NBSP } from "./money";

describe("tramos", () => {
  it("parte la serie por los huecos y no baja a cero", () => {
    expect(tramos([1, 2, null, 4, null, null, 7, 8])).toEqual([[0, 1], [3], [6, 7]]);
  });
  it("una serie vacía no tiene tramos", () => {
    expect(tramos([null, null])).toEqual([]);
  });
});

describe("ultimoConDato y extremos", () => {
  it("encuentra el último índice con dato", () => {
    expect(ultimoConDato([1, 2, null])).toBe(1);
    expect(ultimoConDato([null])).toBeNull();
  });
  it("ante un empate, el extremo más reciente", () => {
    expect(extremos([5, 9, 3, 9, 3, null])).toEqual({ iMax: 3, iMin: 4 });
  });
  it("sin datos no hay extremos", () => {
    expect(extremos([null, null])).toBeNull();
  });
});

describe("mediaEntera", () => {
  it("devuelve céntimos enteros", () => {
    expect(mediaEntera([100, 101])).toBe(101);
    expect(Number.isInteger(mediaEntera([1, 2, 2]))).toBe(true);
  });
  it("sin valores no hay media", () => {
    expect(mediaEntera([])).toBeNull();
  });
});

describe("escalaBonita", () => {
  it("reparte en pasos de 1, 2 o 5 × 10^k y cubre el rango", () => {
    const e = escalaBonita(3_533_488, 3_868_155, 4);
    expect(e.paso).toBe(100_000);
    expect(e.desde).toBeLessThanOrEqual(3_533_488);
    expect(e.hasta).toBeGreaterThanOrEqual(3_868_155);
    expect(e.ticks.every((t) => Number.isInteger(t))).toBe(true);
  });
  it("una serie plana sigue teniendo altura", () => {
    const e = escalaBonita(500, 500, 3);
    expect(e.hasta).toBeGreaterThan(e.desde);
  });
  it("con céntimos, el paso mínimo es un euro: nunca «0, 0»", () => {
    const e = escalaBonita(0, 0, 2, 100);
    expect(e.ticks).toEqual([0, 100]);
  });
});

describe("rotuloEje", () => {
  it("euros sin céntimos ni símbolo, con el millar de es-ES", () => {
    expect(rotuloEje(3_868_155)).toBe("38.682");
    expect(rotuloEje(980_000)).toBe("9800");
  });
  it("porcentajes sin el más pero con el menos tipográfico", () => {
    expect(rotuloEje(12, "porcentaje")).toBe(`12${NBSP}%`);
    expect(rotuloEje(-3, "porcentaje")).toBe(`${MINUS}3${NBSP}%`);
  });
});

describe("índices de lectura", () => {
  it("línea: el punto más cercano, acotado a la serie", () => {
    expect(indiceLinea(0, 100, 11, 0, 0)).toBe(0);
    expect(indiceLinea(54, 100, 11, 0, 0)).toBe(5);
    expect(indiceLinea(500, 100, 11, 0, 0)).toBe(10);
    expect(indiceLinea(-20, 100, 11, 0, 0)).toBe(0);
  });
  it("columna: la barra en la que cae", () => {
    expect(indiceColumna(0, 120, 6)).toBe(0);
    expect(indiceColumna(119, 120, 6)).toBe(5);
    expect(indiceColumna(240, 120, 6)).toBe(5);
  });
});

describe("rotulosEjeVisibles", () => {
  // Lo que miden de verdad los meses de `es-ES` a 11 px en Inter (medido en el
  // navegador): de los 15 px de «Jul» a los 24 de «Sept».
  const meses = [21, 17, 20, 19, 20, 19, 22, 19, 15, 21, 24, 18];
  const indices = (v: boolean[]) => v.flatMap((x, i) => (x ? [i] : []));

  it("con sitio de sobra, todos", () => {
    expect(rotulosEjeVisibles(meses, 960).every(Boolean)).toBe(true);
    // Lo que sumas, en la columna de 420 px de Patrimonio: 335 px para doce
    // meses (28 px por columna) con «sep» (20 px). Caben todos, como antes.
    const conSep = meses.map((w, i) => (i === 10 ? 20 : w));
    expect(rotulosEjeVisibles(conSep, 335).every(Boolean)).toBe(true);
    // Seis meses de Resumen en móvil: 340 / 6 ≈ 57 px por columna.
    expect(rotulosEjeVisibles(meses.slice(-6), 340).every(Boolean)).toBe(true);
  });

  it("en una celda estrecha, uno de cada N contando desde el último", () => {
    // La tendencia por categoría en escritorio: 289 px para doce meses (24 px
    // por columna): «ago» y «sept» se pisarían → uno de cada dos.
    expect(indices(rotulosEjeVisibles(meses, 289))).toEqual([1, 3, 5, 7, 9, 11]);
    // Más estrecho aún (10 px por columna) → uno de cada tres.
    expect(indices(rotulosEjeVisibles(meses, 120))).toEqual([2, 5, 8, 11]);
  });

  it("el último siempre se rotula", () => {
    for (const ancho of [30, 60, 120, 200, 300, 500]) {
      expect(rotulosEjeVisibles(meses, ancho)[11]).toBe(true);
    }
  });

  it("los vecinos que se escriben nunca se pisan", () => {
    for (const ancho of [60, 90, 150, 210, 260, 289, 300, 340, 420]) {
      const col = ancho / meses.length;
      const v = indices(rotulosEjeVisibles(meses, ancho));
      for (let k = 1; k < v.length; k++) {
        const [a, b] = [v[k - 1], v[k]];
        expect((b - a) * col - (meses[a] + meses[b]) / 2).toBeGreaterThanOrEqual(EJE_SEPARACION);
      }
    }
  });

  it("la fija se rotula aunque no le toque, y calla a los que la pisarían", () => {
    // Paso 2 desde el último: tocan 1, 3, 5… La fija es la 4.
    const v = rotulosEjeVisibles(meses, 289, 4);
    expect(v[4]).toBe(true);
    expect(v[3]).toBe(false);
    expect(v[5]).toBe(false);
    expect(v[1]).toBe(true);
    expect(v[11]).toBe(true);
  });

  it("sin medida o sin barras, no inventa", () => {
    expect(rotulosEjeVisibles([], 300)).toEqual([]);
    expect(rotulosEjeVisibles(meses, 0).every(Boolean)).toBe(true);
  });

  it("la estimación previa a medir va por arriba de lo real", () => {
    expect(anchoEstimadoRotulo("may")).toBeGreaterThanOrEqual(23);
    expect(anchoEstimadoRotulo("sept")).toBeGreaterThanOrEqual(24);
    expect(anchoEstimadoRotulo("2026")).toBeGreaterThanOrEqual(28);
  });
});

describe("rutas", () => {
  it("traza recta y área cerrada contra el suelo", () => {
    const pts = [
      { x: 0, y: 10 },
      { x: 5, y: 2 },
    ];
    const d = rutaRecta(pts);
    expect(d).toBe("M0.00,10.00L5.00,2.00");
    expect(cerrarArea(d, pts, 20)).toBe(`${d}L5.00,20.00L0.00,20.00Z`);
  });
});

describe("variaciones", () => {
  it("el tono depende de si subir es bueno", () => {
    expect(variacionImporte(100_00, 110_00).tono).toBe("bien");
    expect(variacionImporte(100_00, 110_00, false).tono).toBe("mal");
    expect(variacionImporte(100_00, 100_00).tono).toBe("neutro");
  });
  it("contra la media, en céntimos exactos", () => {
    expect(contraMedia(2_412_75, 2_013_95).texto).toBe(`398,80${NBSP}€ sobre la media`);
    expect(contraMedia(2_412_75, 2_013_95).tono).toBe("mal");
  });
  it("lecturas de nivel: el primer punto es el inicio", () => {
    const l = lecturasNivel([1000, 1500], ["ene", "feb"], {
      desdeRotulo: "enero",
    });
    expect(l[0].detalle).toBe("Inicio del periodo");
    expect(l[1].detalle).toContain("desde enero");
    expect(l[1].tono).toBe("bien");
  });
});

describe("anillo", () => {
  it("reparte la vuelta y descuenta hueco y remate entre sectores", () => {
    const s = sectoresAnillo([50, 50], { hueco: 2, remate: 4 });
    expect(s[0].desde).toBe(3);
    expect(s[0].largo).toBe(44);
    expect(s[1].desde).toBe(53);
    expect(s.map((x) => x.fraccion)).toEqual([0.5, 0.5]);
  });
  it("un solo sector es el anillo entero", () => {
    expect(sectoresAnillo([7], { hueco: 2, remate: 4 })[0]).toEqual({ desde: 0, largo: 100, fraccion: 1 });
  });
  it("un sector diminuto queda como un punto, no desaparece", () => {
    expect(sectoresAnillo([1, 999], { hueco: 2, remate: 4 })[0].largo).toBeGreaterThan(0);
  });
  it("encuentra el sector de un ángulo", () => {
    expect(sectorEnAngulo([0.25, 0.75], 10)).toBe(0);
    expect(sectorEnAngulo([0.25, 0.75], 30)).toBe(1);
    expect(sectorEnAngulo([0.25, 0.75], 100)).toBe(1);
  });
});

describe("diferenciasDiarias", () => {
  it("saca el gasto de cada día del acumulado, en enteros", () => {
    expect(diferenciasDiarias([1250, 1250, 4000, 3500, null, null])).toEqual([
      1250,
      0,
      2750,
      -500,
      null,
      null,
    ]);
  });
  it("la suma de los días es el acumulado del último", () => {
    const acumulado = [999, 1999, 1999, 30001];
    const dias = diferenciasDiarias(acumulado) as number[];
    expect(dias.reduce((s, v) => s + v, 0)).toBe(30001);
    expect(dias.every(Number.isInteger)).toBe(true);
  });
});

describe("proyeccionLineal", () => {
  it("va de un extremo al otro con enteros y los extremos exactos", () => {
    const p = proyeccionLineal(1000, 2001, 3);
    expect(p).toEqual([1000, 1334, 1667, 2001]);
    expect(p.every(Number.isInteger)).toBe(true);
  });
  it("sin pasos, el punto final", () => {
    expect(proyeccionLineal(5, 9, 0)).toEqual([9]);
  });
});

describe("cascada", () => {
  it("del ingreso a lo que queda, con las barras flotando", () => {
    const c = cascada(250000, [-90000, -45050, 1200, -30000]);
    expect(c.final).toBe(86150);
    expect(c.pasos[0]).toEqual({ desde: 0, hasta: 250000, delta: 250000 });
    expect(c.pasos[1]).toEqual({ desde: 250000, hasta: 160000, delta: -90000 });
    expect(c.pasos[3]).toEqual({ desde: 114950, hasta: 116150, delta: 1200 });
    expect(c.min).toBe(0);
    expect(c.max).toBe(250000);
  });
  it("si se gasta más de lo que entra, cruza el cero", () => {
    const c = cascada(1000, [-800, -700]);
    expect(c.final).toBe(-500);
    expect(c.min).toBe(-500);
  });
});

describe("tasa de ahorro", () => {
  it("es ahorro entre ingreso, y sin ingreso no hay tasa", () => {
    expect(tasaAhorro(50000, 200000)).toBe(25);
    expect(tasaAhorro(-10000, 100000)).toBe(-10);
    expect(tasaAhorro(5000, 0)).toBeNull();
  });
  it("la del periodo pondera por ingreso, no promedia tasas", () => {
    const meses = [
      { saved_cents: 100000, income_cents: 300000 },
      { saved_cents: 0, income_cents: 10000 },
      { saved_cents: -2000, income_cents: 0 },
    ];
    // (100000 + 0) / (300000 + 10000); el mes sin ingreso no entra.
    expect(tasaAgregada(meses)).toBeCloseTo(32.258, 2);
    expect(tasaAgregada([])).toBeNull();
  });
});

describe("apilar", () => {
  it("apila lo positivo hacia arriba y lo negativo hacia abajo", () => {
    const [caja, invertido] = apilar([
      [1000, -200],
      [500, 700],
    ]);
    expect(caja).toEqual([
      { base: 0, techo: 1000 },
      { base: 0, techo: -200 },
    ]);
    expect(invertido).toEqual([
      { base: 1000, techo: 1500 },
      { base: 0, techo: 700 },
    ]);
  });
});

describe("mapa de calor", () => {
  const celdas = [
    { dia_semana: 1, hora: 0, net_cents: 100, cargos: 1 },
    { dia_semana: 1, hora: 2, net_cents: 250, cargos: 2 },
    { dia_semana: 1, hora: 3, net_cents: 40, cargos: 1 },
    { dia_semana: 7, hora: 23, net_cents: 999, cargos: 3 },
    { dia_semana: 7, hora: null, net_cents: -50, cargos: 0 },
  ];
  it("agrupa las horas en franjas y deja «sin hora» al final", () => {
    const r = agruparFranjas(celdas, 3);
    expect(r).toHaveLength(7);
    expect(r[0]).toHaveLength(9);
    expect(r[0][0]).toEqual({ net_cents: 350, cargos: 3 });
    expect(r[0][1]).toEqual({ net_cents: 40, cargos: 1 });
    expect(r[6][7]).toEqual({ net_cents: 999, cargos: 3 });
    expect(r[6][8]).toEqual({ net_cents: -50, cargos: 0 });
  });
  it("con franjas de una hora es la rejilla de 24, y la suma no cambia", () => {
    const r = agruparFranjas(celdas, 1);
    expect(r[0]).toHaveLength(25);
    const suma = (g: { net_cents: number }[][]) => g.flat().reduce((s, c) => s + c.net_cents, 0);
    expect(suma(r)).toBe(suma(agruparFranjas(celdas, 3)));
    expect(suma(r)).toBe(1339);
  });
  it("el nivel: nada para cero o devoluciones, y cualquier gasto se ve", () => {
    expect(nivelCalor(0, 1000)).toBe(0);
    expect(nivelCalor(-50, 1000)).toBe(0);
    expect(nivelCalor(1, 1000)).toBe(1);
    expect(nivelCalor(500, 1000)).toBe(2);
    expect(nivelCalor(1000, 1000)).toBe(4);
  });
});

describe("cambiosCompromiso", () => {
  const fila = (period_month: string, id: string, cuenta: boolean, alta = false) => ({
    period_month,
    subscription_id: id,
    description: id,
    monthly_cents: id === "Netflix" ? 1299 : 999,
    cuenta,
    alta,
  });
  it("dice qué entra y qué sale en cada escalón", () => {
    const c = cambiosCompromiso([
      fila("2026-08-01", "Spotify", true, true),
      fila("2026-08-01", "Netflix", false),
      fila("2026-09-01", "Spotify", true),
      fila("2026-09-01", "Netflix", true, true),
      fila("2026-10-01", "Spotify", false),
      fila("2026-10-01", "Netflix", true),
    ]);
    expect(c.get("2026-08-01")).toEqual({
      entran: [{ nombre: "Spotify", cents: 999 }],
      salen: [],
    });
    expect(c.get("2026-09-01")).toEqual({
      entran: [{ nombre: "Netflix", cents: 1299 }],
      salen: [],
    });
    expect(c.get("2026-10-01")).toEqual({
      entran: [],
      salen: [{ nombre: "Spotify", cents: 999 }],
    });
  });
});

describe("listaNombres", () => {
  it("cabe en una línea", () => {
    expect(listaNombres(["A"])).toBe("A");
    expect(listaNombres(["A", "B"])).toBe("A y B");
    expect(listaNombres(["A", "B", "C", "D"])).toBe("A, B y 2 más");
  });
});
