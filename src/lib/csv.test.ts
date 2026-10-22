import { describe, expect, it } from "vitest";
import {
  detectarFormatoFecha,
  detectarSeparador,
  leerFilas,
  parseCsv,
  parseFecha,
  prepararTabla,
  proponerColumnas,
} from "./csv";

describe("parseCsv", () => {
  it("parte por el separador y respeta las comillas", () => {
    const filas = parseCsv('a;b;c\n1;"dos;con;puntos";3', ";");
    expect(filas).toEqual([
      ["a", "b", "c"],
      ["1", "dos;con;puntos", "3"],
    ]);
  });

  it("no se rompe con un concepto que lleva una coma dentro", () => {
    const filas = parseCsv('Fecha,Concepto,Importe\n18/08/2026,"BAR PEPE, S.L.",-12,40', ",");
    expect(filas[1][1]).toBe("BAR PEPE, S.L.");
  });

  it("entiende las comillas escapadas duplicándolas", () => {
    expect(parseCsv('a\n"dijo ""hola"""', ";")[1][0]).toBe('dijo "hola"');
  });

  it("admite saltos de línea dentro de un campo entrecomillado", () => {
    const filas = parseCsv('a;b\n"dos\nlíneas";x', ";");
    expect(filas).toHaveLength(2);
    expect(filas[1][0]).toBe("dos\nlíneas");
  });

  it("trata \\r\\n como un único final de línea", () => {
    expect(parseCsv("a;b\r\n1;2\r\n", ";")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("quita la marca de orden de bytes del primer título", () => {
    expect(parseCsv("﻿Fecha;Importe\n18/08/2026;-1,00", ";")[0][0]).toBe("Fecha");
  });

  it("descarta las líneas en blanco del final", () => {
    expect(parseCsv("a;b\n1;2\n\n\n", ";")).toHaveLength(2);
  });
});

describe("detectarSeparador", () => {
  it("acierta con punto y coma", () => {
    expect(detectarSeparador("Fecha;Concepto;Importe\n18/08/2026;BAR;-12,40")).toBe(";");
  });

  it("acierta con coma", () => {
    expect(detectarSeparador("Fecha,Concepto,Importe\n2026-08-18,BAR,-12.40")).toBe(",");
  });

  it("acierta con tabulador", () => {
    expect(detectarSeparador("Fecha\tConcepto\tImporte\n18/08/2026\tBAR\t-12,40")).toBe("\t");
  });

  /**
   * El caso que hunde a quien cuenta caracteres: hay más comas que puntos y
   * coma, porque las llevan los decimales y los conceptos. Pero solo el punto
   * y coma produce una tabla coherente.
   */
  it("no se deja engañar por las comas de los decimales y los conceptos", () => {
    const texto = [
      "Fecha;Concepto;Importe",
      "18/08/2026;MERCADONA, S.A.;-23,45",
      "17/08/2026;BAR PEPE, S.L.;-12,40",
      "16/08/2026;NOMINA AGOSTO;1.850,00",
    ].join("\n");
    expect(detectarSeparador(texto)).toBe(";");
  });
});

describe("detectarFormatoFecha", () => {
  it("reconoce el año por delante", () => {
    expect(detectarFormatoFecha(["2026-08-18", "2026-08-17"])).toEqual({
      formato: "ymd",
      ambiguo: false,
    });
  });

  it("deduce día-mes en cuanto un día pasa de 12", () => {
    expect(detectarFormatoFecha(["05/02/2026", "18/02/2026"])).toEqual({
      formato: "dmy",
      ambiguo: false,
    });
  });

  it("deduce mes-día cuando es la segunda posición la que pasa de 12", () => {
    expect(detectarFormatoFecha(["02/05/2026", "02/18/2026"])).toEqual({
      formato: "mdy",
      ambiguo: false,
    });
  });

  it("elige día-mes cuando no hay forma de saberlo, pero lo confiesa", () => {
    expect(detectarFormatoFecha(["01/02/2026", "03/04/2026"])).toEqual({
      formato: "dmy",
      ambiguo: true,
    });
  });

  it("devuelve null si no cuadra de ninguna manera", () => {
    expect(detectarFormatoFecha(["18/25/2026"])).toBeNull();
    expect(detectarFormatoFecha(["no es una fecha"])).toBeNull();
  });
});

describe("parseFecha", () => {
  it("normaliza a año-mes-día", () => {
    expect(parseFecha("18/08/2026", "dmy")).toBe("2026-08-18");
    expect(parseFecha("8/8/2026", "dmy")).toBe("2026-08-08");
    expect(parseFecha("18-08-2026", "dmy")).toBe("2026-08-18");
    expect(parseFecha("18.08.2026", "dmy")).toBe("2026-08-18");
    expect(parseFecha("2026-08-18", "ymd")).toBe("2026-08-18");
    expect(parseFecha("08/18/2026", "mdy")).toBe("2026-08-18");
  });

  it("resuelve los años de dos cifras", () => {
    expect(parseFecha("18/08/26", "dmy")).toBe("2026-08-18");
    expect(parseFecha("18/08/99", "dmy")).toBe("1999-08-18");
  });

  it("rechaza fechas que no existen en el calendario", () => {
    expect(parseFecha("31/02/2026", "dmy")).toBeNull();
    expect(parseFecha("32/01/2026", "dmy")).toBeNull();
    expect(parseFecha("18/13/2026", "dmy")).toBeNull();
  });

  it("acepta el 29 de febrero solo en año bisiesto", () => {
    expect(parseFecha("29/02/2024", "dmy")).toBe("2024-02-29");
    expect(parseFecha("29/02/2026", "dmy")).toBeNull();
  });
});

describe("proponerColumnas", () => {
  it("empareja por el nombre de la cabecera", () => {
    const cabecera = ["Fecha", "Concepto", "Importe", "Saldo"];
    const filas = [cabecera, ["18/08/2026", "MERCADONA", "-23,45", "1.234,56"]];
    expect(proponerColumnas(cabecera, filas)).toEqual({ fecha: 0, concepto: 1, importe: 2 });
  });

  /**
   * El error que arruinaría la importación: el saldo es una columna de importes
   * impecable que no es ningún movimiento. Elegirla mete el saldo de la cuenta
   * como si fueran gastos.
   */
  it("nunca confunde el saldo con el importe", () => {
    const cabecera = ["Fecha operación", "Descripción", "Saldo", "Importe EUR"];
    const filas = [cabecera, ["18/08/2026", "MERCADONA", "1.234,56", "-23,45"]];
    expect(proponerColumnas(cabecera, filas).importe).toBe(3);
  });

  it("sin cabeceras reconocibles, deduce por el contenido", () => {
    const cabecera = ["col1", "col2", "col3"];
    const filas = [
      cabecera,
      ["18/08/2026", "MERCADONA SUPERMERCADO", "-23,45"],
      ["17/08/2026", "BAR PEPE CENTRO", "-12,40"],
      ["16/08/2026", "NOMINA DE AGOSTO", "1.850,00"],
    ];
    expect(proponerColumnas(cabecera, filas)).toEqual({ fecha: 0, concepto: 1, importe: 2 });
  });

  it("prefiere como importe la columna que trae negativos, no el saldo", () => {
    const cabecera = ["a", "b", "c", "d"];
    const filas = [
      cabecera,
      ["18/08/2026", "MERCADONA", "1.000,00", "-23,45"],
      ["17/08/2026", "BAR", "987,60", "-12,40"],
      ["16/08/2026", "OTRO", "975,20", "-5,00"],
    ];
    expect(proponerColumnas(cabecera, filas).importe).toBe(3);
  });
});

describe("leerFilas", () => {
  const columnas = { fecha: 0, concepto: 1, importe: 2 };

  it("convierte a céntimos enteros y conserva el signo", () => {
    const filas = [
      ["Fecha", "Concepto", "Importe"],
      ["18/08/2026", "MERCADONA", "-23,45"],
      ["16/08/2026", "NOMINA", "1.850,00"],
    ];
    const { filas: leidas } = leerFilas(filas, columnas, {
      conCabecera: true,
      todoGasto: false,
    });
    expect(leidas).toHaveLength(2);
    expect(leidas[0]).toMatchObject({
      occurred_on: "2026-08-18",
      description: "MERCADONA",
      amount_cents: -2345,
    });
    expect(leidas[1].amount_cents).toBe(185000);
  });

  it("no pierde céntimos donde la coma flotante los perdería", () => {
    const filas = [
      ["Fecha", "Concepto", "Importe"],
      ["18/08/2026", "A", "-0,29"],
      ["18/08/2026", "B", "-0,70"],
      ["18/08/2026", "C", "-13.374,55"],
    ];
    const { filas: leidas } = leerFilas(filas, columnas, {
      conCabecera: true,
      todoGasto: false,
    });
    expect(leidas.map((f) => f.amount_cents)).toEqual([-29, -70, -1337455]);
  });

  it("descarta y explica las líneas que no son movimientos", () => {
    const filas = [
      ["Fecha", "Concepto", "Importe"],
      ["SALDO INICIAL", "", ""],
      ["18/08/2026", "MERCADONA", "-23,45"],
      ["", "TOTAL", "-23,45"],
      ["17/08/2026", "AJUSTE", "0,00"],
    ];
    const lectura = leerFilas(filas, columnas, { conCabecera: true, todoGasto: false });
    expect(lectura.filas).toHaveLength(1);
    expect(lectura.descartadas).toHaveLength(3);
    expect(lectura.descartadas.map((d) => d.motivo)).toEqual([
      "La fecha no se entiende",
      "La fecha no se entiende",
      "Importe de cero",
    ]);
  });

  it("con «todo son gastos» fuerza el signo negativo", () => {
    const filas = [
      ["Fecha", "Concepto", "Importe"],
      ["18/08/2026", "MERCADONA", "23,45"],
    ];
    const { filas: leidas } = leerFilas(filas, columnas, {
      conCabecera: true,
      todoGasto: true,
    });
    expect(leidas[0].amount_cents).toBe(-2345);
  });

  it("señala la línea original, para poder ir a mirarla", () => {
    const filas = [
      ["Fecha", "Concepto", "Importe"],
      ["mal", "", ""],
      ["18/08/2026", "OK", "-1,00"],
    ];
    const lectura = leerFilas(filas, columnas, { conCabecera: true, todoGasto: false });
    expect(lectura.descartadas[0].linea).toBe(2);
    expect(lectura.filas[0].linea).toBe(3);
  });

  it("avisa de que la fecha era ambigua", () => {
    const filas = [
      ["Fecha", "Concepto", "Importe"],
      ["01/02/2026", "A", "-1,00"],
    ];
    expect(
      leerFilas(filas, columnas, { conCabecera: true, todoGasto: false }).ambiguedadDeFecha,
    ).toBe(true);
  });
});

describe("leerFilas y los límites de fecha de la base", () => {
  const columnas = { fecha: 0, concepto: 1, importe: 2 };

  it("descarta lo anterior a 2000, que la base rechaza", () => {
    const filas = [
      ["Fecha", "Concepto", "Importe"],
      ["31/12/1999", "ANTIGUO", "-1,00"],
      ["01/01/2000", "JUSTO", "-1,00"],
    ];
    const lectura = leerFilas(filas, columnas, { conCabecera: true, todoGasto: false });
    expect(lectura.filas.map((f) => f.description)).toEqual(["JUSTO"]);
    expect(lectura.descartadas[0].motivo).toContain("fuera de rango");
  });

  it("descarta lo que caiga demasiado lejos en el futuro", () => {
    const dentroDeDosAnios = new Date();
    dentroDeDosAnios.setUTCFullYear(dentroDeDosAnios.getUTCFullYear() + 2);
    const d = dentroDeDosAnios.toISOString().slice(0, 10);
    const filas = [
      ["Fecha", "Concepto", "Importe"],
      [d, "FUTURO", "-1,00"],
    ];
    const lectura = leerFilas(filas, columnas, { conCabecera: true, todoGasto: false });
    expect(lectura.filas).toHaveLength(0);
    expect(lectura.descartadas[0].motivo).toContain("fuera de rango");
  });

  /**
   * Sin este filtro, una restricción de la base tumbaría el fichero completo
   * por un solo apunte viejo, y quien importa no sabría cuál era.
   */
  it("una fila mala no se lleva por delante las buenas", () => {
    const filas = [
      ["Fecha", "Concepto", "Importe"],
      ["18/08/2026", "BUENA 1", "-1,00"],
      ["15/06/1995", "MALA", "-1,00"],
      ["17/08/2026", "BUENA 2", "-2,00"],
    ];
    const lectura = leerFilas(filas, columnas, { conCabecera: true, todoGasto: false });
    expect(lectura.filas.map((f) => f.description)).toEqual(["BUENA 1", "BUENA 2"]);
    expect(lectura.descartadas).toHaveLength(1);
    expect(lectura.descartadas[0].linea).toBe(3);
  });
});

describe("prepararTabla", () => {
  /** Un extracto de verdad, con el preámbulo que ponen todos los bancos. */
  const extracto = [
    "Cuenta;ES91 2100 0418 4502 0005 1332",
    "Fecha de extracto;18/08/2026",
    "",
    "Fecha operación;Fecha valor;Concepto;Importe EUR;Saldo EUR",
    "18/08/2026;18/08/2026;COMPRA MERCADONA 4021 MADRID;-23,45;1.234,56",
    '17/08/2026;17/08/2026;"BAR PEPE, S.L.";-12,40;1.258,01',
    "01/08/2026;01/08/2026;NOMINA AGOSTO 2026;1.850,00;1.349,31",
    "TOTAL;-1.735,85",
  ].join("\n");

  it("acierta el separador aunque el preámbulo tenga otro ancho", () => {
    expect(detectarSeparador(extracto)).toBe(";");
  });

  it("empieza la tabla en la cabecera de verdad, no en la primera línea", () => {
    const { filas, preambulo } = prepararTabla(extracto, ";");
    // Dos filas de preámbulo, no tres: la línea en blanco ya se descarta al
    // analizar, así que esto cuenta filas con contenido, no líneas del fichero.
    expect(preambulo).toBe(2);
    expect(filas[0][0]).toBe("Fecha operación");
  });

  it("deja fuera el pie de totales, que tiene menos columnas", () => {
    const { filas } = prepararTabla(extracto, ";");
    expect(filas).toHaveLength(4); // cabecera + 3 movimientos
    expect(filas.some((f) => f[0] === "TOTAL")).toBe(false);
  });

  it("y con eso el emparejamiento ve las 5 columnas y evita el saldo", () => {
    const { filas } = prepararTabla(extracto, ";");
    expect(proponerColumnas(filas[0], filas)).toEqual({ fecha: 0, concepto: 2, importe: 3 });
  });

  it("de punta a punta: tres movimientos con sus céntimos exactos", () => {
    const { filas } = prepararTabla(extracto, ";");
    const columnas = proponerColumnas(filas[0], filas);
    const lectura = leerFilas(filas, columnas, { conCabecera: true, todoGasto: false });
    expect(lectura.descartadas).toHaveLength(0);
    expect(lectura.filas.map((f) => [f.description, f.amount_cents])).toEqual([
      ["COMPRA MERCADONA 4021 MADRID", -2345],
      ["BAR PEPE, S.L.", -1240],
      ["NOMINA AGOSTO 2026", 185000],
    ]);
  });

  it("un fichero sin preámbulo no se toca", () => {
    const limpio = "Fecha;Concepto;Importe\n18/08/2026;A;-1,00";
    expect(prepararTabla(limpio, ";")).toEqual({
      filas: [
        ["Fecha", "Concepto", "Importe"],
        ["18/08/2026", "A", "-1,00"],
      ],
      preambulo: 0,
    });
  });
});
