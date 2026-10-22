import { monthStart, shiftMonth } from "./dates";

/**
 * El ingreso de referencia para comparar un compromiso fijo («De tus ingresos
 * medios», en Fijos).
 *
 * POR QUÉ NO EL MES EN CURSO. El mes en curso va a medias: a día 5 la nómina
 * puede no haber entrado y el «% de lo que entra» se dispara al 300 %, y a día
 * 28 baja de golpe. Una suscripción no cambia de peso según el día del mes en
 * que la mires, así que la base tiene que ser estable.
 *
 * POR QUÉ LA MEDIA DE LOS TRES ÚLTIMOS MESES CERRADOS, y no solo el último: un
 * mes suelto puede traer una paga extra (junio, diciembre) o haberse quedado
 * sin nómina por un cambio de fecha de cobro, y el porcentaje saltaría con él.
 * Tres meses amortiguan eso sin arrastrar ingresos de hace un año que ya no
 * son los de ahora.
 *
 * Los meses que cuentan son los que tienen algún movimiento: un mes sin nada
 * es un mes en que todavía no usabas la app, no un mes sin ingresos. Uno con
 * gastos y sin ingresos, en cambio, SÍ cuenta como 0. Así, quien acaba de
 * empezar tiene la media de los meses cerrados que haya (uno o dos), y quien
 * no tiene ninguno cerrado no tiene base todavía.
 *
 * El ingreso de cada mes es `v_month_summary.income_cents`: sin traspasos y sin
 * reembolsos (un reembolso abarata un gasto, no es un ingreso).
 */
export const MESES_INGRESO_MEDIO = 3;

export type IngresoMes = { period_month: string; income_cents: number | null };

export type IngresoMedio = {
  /** Media en céntimos enteros, redondeada al céntimo con mitad hacia arriba. */
  mediaCents: number;
  /** Cuántos meses cerrados entran en la media (1..MESES_INGRESO_MEDIO). */
  meses: number;
};

export function ingresoMedio(
  filas: readonly IngresoMes[],
  hoy: string,
  meses = MESES_INGRESO_MEDIO,
): IngresoMedio | null {
  const hasta = monthStart(hoy); // excluido: el mes en curso no está cerrado
  const desde = shiftMonth(hasta, -meses);

  let suma = BigInt(0);
  let n = 0;
  for (const f of filas) {
    if (f.period_month >= desde && f.period_month < hasta) {
      suma += BigInt(f.income_cents ?? 0);
      n += 1;
    }
  }
  if (n === 0) return null;

  // Media entera con empate hacia arriba, en BigInt: floor((2·suma + n) / 2n).
  // Los ingresos no son negativos; si lo fueran, el floor de BigInt trunca
  // hacia cero y aquí da igual, porque una media <= 0 no sirve de base.
  const dos = BigInt(2);
  const total = BigInt(n);
  const media = Number((dos * suma + total) / (dos * total));
  return { mediaCents: media, meses: n };
}
