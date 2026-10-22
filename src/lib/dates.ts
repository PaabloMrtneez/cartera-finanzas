import type { Periodicity } from "./types";
/**
 * Fechas en español, con los formatos exactos del prototipo.
 *
 * Todo se trabaja sobre fechas locales en formato `YYYY-MM-DD`, que es como se
 * guardan. Nunca se convierte a `Date` con zona horaria para agrupar o comparar:
 * un cargo de las 00:30 del día 1 acabaría contando en el mes anterior.
 */

const MONTHS_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const MONTHS_SHORT = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** Descompone `YYYY-MM-DD` sin pasar por Date, para no arrastrar zona horaria. */
export function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

/** Día de la semana de una fecha local, con el algoritmo de Sakamoto. */
function weekdayIndex(year: number, month: number, day: number): number {
  const table = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = month < 3 ? year - 1 : year;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + table[month - 1] + day) % 7;
}

/** La zona de la app: los cuatro usuarios viven en la España peninsular. */
export const ZONA_HORARIA = "Europe/Madrid";

const formatoDiaMadrid = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA_HORARIA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * HOY en Madrid, `YYYY-MM-DD`. Es el ÚNICO reloj de la app.
 *
 * El servidor (Vercel) corre en UTC: con la hora local del proceso, entre las
 * 00:00 y las 01:00/02:00 de Madrid creería que es ayer (el día 1 enseñaría el
 * mes anterior como «mes actual» e Inversiones rechazaría la fecha de hoy por
 * «futura»). La base usa la misma zona (`now() at time zone 'Europe/Madrid'`).
 */
export function hoyMadrid(ahora: Date = new Date()): string {
  return formatoDiaMadrid.format(ahora);
}

/** Primer día del mes en curso en Madrid: `2026-11-01`. */
export function mesMadrid(ahora: Date = new Date()): string {
  return monthStart(hoyMadrid(ahora));
}

/**
 * Fecha de hoy en `YYYY-MM-DD`. Es `hoyMadrid()`: en el servidor y en el
 * navegador «hoy» es siempre el de Madrid, para que los dos lados no discrepen.
 */
export function todayIso(): string {
  return hoyMadrid();
}

/**
 * ¿Es `YYYY-MM-DD` un día que EXISTE? «2026-02-30», «2026-13-45» o
 * «0000-00-00» tienen el formato pero no están en el calendario.
 */
export function esFechaIso(iso: unknown): iso is string {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const { year, month, day } = parseIsoDate(iso);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(toIso(year, month, 1));
}

export function toIso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Primer día del mes al que pertenece una fecha: `2026-08-15` → `2026-08-01`. */
export function monthStart(iso: string): string {
  const { year, month } = parseIsoDate(iso);
  return toIso(year, month, 1);
}

/** Desplaza un mes: `2026-08-01`, −1 → `2026-07-01`. */
export function shiftMonth(iso: string, delta: number): string {
  const { year, month } = parseIsoDate(iso);
  const total = year * 12 + (month - 1) + delta;
  return toIso(Math.floor(total / 12), (total % 12) + 1, 1);
}

/** «agosto», para el selector de mes. Con el año si no es el actual. */
export function monthLabel(iso: string, currentYear = parseIsoDate(hoyMadrid()).year): string {
  const { year, month } = parseIsoDate(iso);
  const name = MONTHS_LONG[month - 1];
  return year === currentYear ? name : `${name} ${year}`;
}

/** «ago 2026», para ejes de gráficos y columnas estrechas. */
export function monthShortLabel(iso: string): string {
  const { year, month } = parseIsoDate(iso);
  return `${MONTHS_SHORT[month - 1]} ${year}`;
}

/** «3 ago», el formato de fila de tabla. */
export function shortDate(iso: string): string {
  const { month, day } = parseIsoDate(iso);
  return `${day} ${MONTHS_SHORT[month - 1]}`;
}

/** «domingo, 2 de agosto», el de la pantalla de detalle. Un día que no existe se devuelve tal cual. */
export function longDate(iso: string): string {
  if (!esFechaIso(iso)) return iso;
  const { year, month, day } = parseIsoDate(iso);
  return `${WEEKDAYS[weekdayIndex(year, month, day)]}, ${day} de ${MONTHS_LONG[month - 1]}`;
}

/**
 * Cabecera de grupo de la lista de movimientos. Los dos días recientes se
 * nombran, que es más rápido de leer que una fecha.
 */
export function groupHeading(iso: string, today = todayIso()): string {
  if (iso === today) return "Hoy";
  if (iso === addDays(today, -1)) return "Ayer";
  const { year, month, day } = parseIsoDate(iso);
  return `${WEEKDAYS[weekdayIndex(year, month, day)]}, ${day} de ${MONTHS_LONG[month - 1]}`;
}

/** «Hoy, 13:24» o «28 jul, 20:11», para la fila de movimiento. */
export function whenLabel(iso: string, time: string, today = todayIso()): string {
  const hhmm = time.slice(0, 5);
  if (iso === today) return `Hoy, ${hhmm}`;
  if (iso === addDays(today, -1)) return `Ayer, ${hhmm}`;
  return `${shortDate(iso)}, ${hhmm}`;
}

/** Suma días a una fecha ISO, pasando por UTC para no tropezar con el horario de verano. */
export function addDays(iso: string, days: number): string {
  const { year, month, day } = parseIsoDate(iso);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Último día del mes de una fecha ISO. */
export function monthEnd(iso: string): string {
  return addDays(shiftMonth(monthStart(iso), 1), -1);
}

/** Cuántos días tiene el mes de una fecha ISO. */
export function daysInMonth(iso: string): number {
  return parseIsoDate(monthEnd(iso)).day;
}

/**
 * La siguiente fecha de cargo de una suscripción.
 *
 * Reproduce exactamente lo que hace `private.next_charge` en la base, que suma
 * un intervalo de PostgreSQL. Y PostgreSQL RECORTA al final del mes: el 31 de
 * enero más un mes es el 28 de febrero, no el 3 de marzo, que es lo que daría
 * `setUTCMonth` al desbordar.
 *
 * Existe solo para poder decir en pantalla cuándo llegará el próximo cargo. Si
 * no coincidiera con la base, la app prometería una fecha y guardaría otra.
 *
 * `diaAncla` (H-09) es el día del mes en que se cobra de verdad (el del alta).
 * Sin él, un fijo del día 31 se quedaría en el 28 para siempre después de
 * febrero (31 ene → 28 feb → 28 mar…). Con él, cada paso cae en
 * `min(diaAncla, días del mes)`: 31 ene → 28 feb → 31 mar → 30 abr. Si no se
 * da, el ancla es el día de `iso`, que es lo correcto para el primer paso.
 */
export function nextCharge(iso: string, periodicity: Periodicity, diaAncla?: number): string {
  if (periodicity === "SEMANAL") return addDays(iso, 7);
  const meses = periodicity === "MENSUAL" ? 1 : periodicity === "TRIMESTRAL" ? 3 : 12;
  const siguiente = shiftDateMonths(iso, meses);
  if (diaAncla === undefined || !Number.isInteger(diaAncla) || diaAncla < 1 || diaAncla > 31) return siguiente;
  const { year, month } = parseIsoDate(siguiente);
  return toIso(year, month, Math.min(diaAncla, daysInMonth(siguiente)));
}

/**
 * Una fecha COMPLETA desplazada N meses, recortando al final del mes.
 *
 * `shiftMonth` solo sirve para primeros de mes. Esta vale para «hace tres
 * meses» desde cualquier día, y recorta igual que PostgreSQL: el 31 de marzo
 * menos un mes es el 28 de febrero, no el 3 de marzo, que es lo que daría
 * `setUTCMonth` al desbordar.
 */
export function shiftDateMonths(iso: string, delta: number): string {
  const { year, month, day } = parseIsoDate(iso);

  const total = year * 12 + (month - 1) + delta;
  const anio = Math.floor(total / 12);
  // El resto de un negativo es negativo en JavaScript, y un mes 0 o −3 no
  // existe. Con fechas de este siglo no llega a pasar, pero el ajuste es
  // gratis y evita que un dato raro produzca una fecha inventada.
  const mes = (((total % 12) + 12) % 12) + 1;

  // El recorte: si el día no existe en el mes destino, se queda en el último.
  return toIso(anio, mes, Math.min(day, daysInMonth(toIso(anio, mes, 1))));
}

/**
 * Cuántos cargos de una suscripción han vencido ya entre una fecha y hoy.
 *
 * El generador arranca en `next_charge_date` y avanza mientras no pase de hoy,
 * así que si alguien apunta un gasto de hace meses y lo marca como recurrente,
 * no aparecerá «el siguiente cargo»: aparecerán todos los atrasados de golpe.
 * Esto sirve para avisarlo antes de guardar, no para descubrirlo después.
 *
 * El tope de 400 es el mismo que lleva el generador en la base: con una fecha
 * disparatada, mejor un número grande que un bucle eterno.
 *
 * `diaAncla`: el `anchor_day` de la fila si se calcula desde datos de la base
 * (subscription, recurring_income); por defecto, el día de `iso`, que es lo
 * que hace `create_expense_with_subscription` con un gasto nuevo.
 */
export function cargosVencidos(
  iso: string,
  periodicity: Periodicity,
  hoy = todayIso(),
  diaAncla: number = parseIsoDate(iso).day,
): number {
  const ancla = diaAncla;
  let fecha = nextCharge(iso, periodicity, ancla);
  let cuantos = 0;
  while (fecha <= hoy && cuantos < 400) {
    cuantos++;
    fecha = nextCharge(fecha, periodicity, ancla);
  }
  return cuantos;
}

/**
 * El cobro siguiente al próximo de una fila de la base (subscription o
 * recurring_income), con su `anchor_day`: lo mismo que `private.next_charge`
 * de tres argumentos (20261020090500_cobros_vuelven_a_su_dia.sql). Sin ancla
 * (una fila anterior a la columna), el día de la propia fecha.
 */
export function cobroSiguiente(fila: {
  proxima: string;
  periodicity: Periodicity;
  anchor_day?: number | null;
}): string {
  return nextCharge(fila.proxima, fila.periodicity, fila.anchor_day ?? undefined);
}

/**
 * «19 ago, 14:32». Para sellos de tiempo en diagnósticos.
 *
 * Con hora, al contrario que `shortDate`: cuando un envío del Atajo se rechaza,
 * saber que fue hace diez minutos y no ayer es la mitad de la pista.
 */
export function shortDateTime(iso: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
