import { describe, expect, it } from "vitest";
import {
  addDays,
  cargosVencidos,
  daysInMonth,
  groupHeading,
  longDate,
  monthEnd,
  monthLabel,
  monthStart,
  nextCharge,
  shiftDateMonths,
  shiftMonth,
  shortDate,
  whenLabel,
} from "./dates";
import { desdeRango, leerRangoInversion } from "./rangos-inversion";

describe("monthStart y shiftMonth", () => {
  it("lleva cualquier día al primero de su mes", () => {
    expect(monthStart("2026-08-15")).toBe("2026-08-01");
    expect(monthStart("2026-08-01")).toBe("2026-08-01");
  });

  it("cruza el cambio de año en los dos sentidos", () => {
    expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(shiftMonth("2025-12-01", 1)).toBe("2026-01-01");
    expect(shiftMonth("2026-08-01", -12)).toBe("2025-08-01");
  });
});

describe("addDays", () => {
  it("cruza fin de mes y fin de año", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("acierta con los años bisiestos", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("no se descuadra en el cambio de hora", () => {
    // En España el horario de verano entra el último domingo de marzo. Sumar un
    // día no puede saltarse ni repetir una fecha.
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
  });
});

describe("monthEnd y daysInMonth", () => {
  it("da el último día de cada mes", () => {
    expect(monthEnd("2026-08-15")).toBe("2026-08-31");
    expect(monthEnd("2026-02-10")).toBe("2026-02-28");
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
  });

  it("cuenta los días del mes", () => {
    expect(daysInMonth("2026-08-01")).toBe(31);
    expect(daysInMonth("2026-04-01")).toBe(30);
    expect(daysInMonth("2028-02-01")).toBe(29);
  });
});

describe("formatos en español", () => {
  it("nombra el mes, y añade el año solo si no es el actual", () => {
    expect(monthLabel("2026-08-01", 2026)).toBe("agosto");
    expect(monthLabel("2025-12-01", 2026)).toBe("diciembre 2025");
  });

  it("abrevia la fecha de una fila", () => {
    expect(shortDate("2026-08-03")).toBe("3 ago");
    expect(shortDate("2026-07-28")).toBe("28 jul");
  });

  it("escribe la fecha larga con su día de la semana", () => {
    // El 2 de agosto de 2026 cae en domingo.
    expect(longDate("2026-08-02")).toBe("domingo, 2 de agosto");
    // El 31 de julio de 2026, en viernes.
    expect(longDate("2026-07-31")).toBe("viernes, 31 de julio");
  });
});

describe("groupHeading", () => {
  const hoy = "2026-08-15";

  it("nombra los dos días recientes en vez de fecharlos", () => {
    expect(groupHeading("2026-08-15", hoy)).toBe("Hoy");
    expect(groupHeading("2026-08-14", hoy)).toBe("Ayer");
  });

  it("fecha el resto", () => {
    expect(groupHeading("2026-08-02", hoy)).toBe("domingo, 2 de agosto");
  });
});

describe("whenLabel", () => {
  const hoy = "2026-08-15";

  it("junta el día y la hora", () => {
    expect(whenLabel("2026-08-15", "13:24:00", hoy)).toBe("Hoy, 13:24");
    expect(whenLabel("2026-08-14", "20:11:00", hoy)).toBe("Ayer, 20:11");
    expect(whenLabel("2026-07-28", "09:41:00", hoy)).toBe("28 jul, 09:41");
  });
});

describe("nextCharge", () => {
  it("avanza según la periodicidad", () => {
    expect(nextCharge("2026-08-19", "SEMANAL")).toBe("2026-08-26");
    expect(nextCharge("2026-08-19", "MENSUAL")).toBe("2026-09-19");
    expect(nextCharge("2026-08-19", "TRIMESTRAL")).toBe("2026-11-19");
    expect(nextCharge("2026-08-19", "ANUAL")).toBe("2027-08-19");
  });

  /**
   * El caso que separa esto de un `setUTCMonth`: PostgreSQL RECORTA al último
   * día del mes destino. JavaScript desbordaría al 3 de marzo, y la pantalla
   * prometería una fecha que la base no va a guardar.
   */
  it("recorta al último día del mes, como PostgreSQL", () => {
    expect(nextCharge("2026-01-31", "MENSUAL")).toBe("2026-02-28");
    expect(nextCharge("2024-01-31", "MENSUAL")).toBe("2024-02-29");
    expect(nextCharge("2026-03-31", "MENSUAL")).toBe("2026-04-30");
    expect(nextCharge("2026-05-31", "TRIMESTRAL")).toBe("2026-08-31");
    expect(nextCharge("2026-11-30", "TRIMESTRAL")).toBe("2027-02-28");
  });

  it("cruza el fin de año sin perderse", () => {
    expect(nextCharge("2026-12-15", "MENSUAL")).toBe("2027-01-15");
    expect(nextCharge("2026-12-31", "MENSUAL")).toBe("2027-01-31");
    expect(nextCharge("2026-10-31", "TRIMESTRAL")).toBe("2027-01-31");
    expect(nextCharge("2024-02-29", "ANUAL")).toBe("2025-02-28");
  });

  it("la semana no recorta: son siete días justos", () => {
    expect(nextCharge("2026-01-29", "SEMANAL")).toBe("2026-02-05");
    expect(nextCharge("2026-12-28", "SEMANAL")).toBe("2027-01-04");
  });
});

describe("cargosVencidos", () => {
  const hoy = "2026-08-19";

  it("no hay atrasados si el siguiente cargo aún no ha llegado", () => {
    expect(cargosVencidos("2026-08-19", "MENSUAL", hoy)).toBe(0);
    expect(cargosVencidos("2026-08-01", "MENSUAL", hoy)).toBe(0);
    expect(cargosVencidos("2026-08-15", "SEMANAL", hoy)).toBe(0);
  });

  /**
   * Lo que justifica el aviso: apuntar en agosto un gasto de enero y marcarlo
   * recurrente no crea «el siguiente cargo», crea seis de golpe.
   */
  it("cuenta los que ya han vencido al fechar el gasto atrás", () => {
    expect(cargosVencidos("2026-01-31", "MENSUAL", hoy)).toBe(6);
    expect(cargosVencidos("2026-07-19", "MENSUAL", hoy)).toBe(1);
    expect(cargosVencidos("2025-08-19", "TRIMESTRAL", hoy)).toBe(4);
    expect(cargosVencidos("2024-08-19", "ANUAL", hoy)).toBe(2);
  });

  it("cuenta bien las semanas", () => {
    expect(cargosVencidos("2026-08-12", "SEMANAL", hoy)).toBe(1);
    expect(cargosVencidos("2026-07-15", "SEMANAL", hoy)).toBe(5);
  });

  it("una fecha disparatada no cuelga la pantalla", () => {
    expect(cargosVencidos("2000-01-01", "SEMANAL", hoy)).toBe(400);
  });
});

describe("shiftDateMonths", () => {
  it("resta meses desde cualquier día", () => {
    expect(shiftDateMonths("2026-08-28", -1)).toBe("2026-07-28");
    expect(shiftDateMonths("2026-08-28", -3)).toBe("2026-05-28");
    expect(shiftDateMonths("2026-08-28", -6)).toBe("2026-02-28");
  });

  it("cruza el año", () => {
    expect(shiftDateMonths("2026-02-15", -3)).toBe("2025-11-15");
    expect(shiftDateMonths("2025-11-15", 3)).toBe("2026-02-15");
  });

  it("RECORTA al último día del mes en vez de desbordar", () => {
    // Lo que daría `setUTCMonth` es el 3 de marzo, que es un mes distinto del
    // que se ha pedido. PostgreSQL recorta, y aquí se recorta igual.
    expect(shiftDateMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftDateMonths("2026-05-31", -3)).toBe("2026-02-28");
    expect(shiftDateMonths("2024-03-31", -1)).toBe("2024-02-29");
    expect(shiftDateMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
});

describe("rangos de inversión", () => {
  const hoy = "2026-08-28";

  it("traduce cada rango a su fecha de inicio", () => {
    expect(desdeRango("1m", null, hoy)).toBe("2026-07-28");
    expect(desdeRango("3m", null, hoy)).toBe("2026-05-28");
    expect(desdeRango("6m", null, hoy)).toBe("2026-02-28");
    expect(desdeRango("ytd", null, hoy)).toBe("2026-01-01");
  });

  it("«Todo» arranca en el primer día que hay algo, no en una fecha remota", () => {
    // Con una fecha de hace décadas, la ponderación de `position_return`
    // divide por medio siglo y el porcentaje se dispara a miles.
    expect(desdeRango("todo", "2025-12-17", hoy)).toBe("2025-12-17");
  });

  it("sin ninguna posición, «Todo» cae en el año en curso", () => {
    expect(desdeRango("todo", null, hoy)).toBe("2026-01-01");
  });

  it("un rango inventado cae en el año en curso", () => {
    expect(leerRangoInversion("bandera")).toBe("ytd");
    expect(leerRangoInversion(undefined)).toBe("ytd");
    expect(leerRangoInversion("6m")).toBe("6m");
  });
});
