/**
 * Cuánto hay en cada cuenta, para Cuentas y para «Dónde está» de Patrimonio.
 *
 * El SALDO de una cuenta (`v_account_balance.balance_cents`) es el efectivo que
 * dicen sus movimientos. Para una cuenta corriente, una tarjeta o la hucha, eso
 * es todo lo que hay. Para una cuenta de inversión no: su dinero está en los
 * fondos, y el saldo solo cuenta lo que queda sin invertir. Quien da de alta un
 * fondo declarando lo que ya llevaba aportado fuera de la app tiene saldo 0 y,
 * sin embargo, mil euros en esa cuenta.
 *
 * Por eso la pantalla pinta el VALOR (`v_account_worth.worth_cents`): el saldo
 * para las cuentas de dinero y, para las de inversión, el efectivo sin invertir
 * más lo que valen hoy sus fondos. Es la misma fórmula con la que `v_net_worth`
 * suma el patrimonio: la suma de `worth_cents` de TODAS las cuentas (también
 * las archivadas) es la cifra héroe de Patrimonio, céntimo a céntimo. Aquí no se
 * recalcula nada —la regla de qué se descuenta vive solo en la vista—: se elige
 * qué columna leer y se cuenta cuántos fondos hay detrás para explicarlo.
 *
 * El formulario de movimientos sigue con el saldo: lo que se puede mover de una
 * cuenta es su efectivo, no sus participaciones.
 */

import { formatCents } from "./money";

/** Lo que se pinta de cada cuenta: su valor y, si tiene fondos, de qué se compone. */
export type ValorCuenta = {
  /** La cifra de la fila: el valor de la cuenta (para las de dinero, su saldo). */
  valorCents: number;
  /** Fondos activos que cuelgan de la cuenta. */
  fondos: number;
  /** Valor de esos fondos hoy. */
  enFondosCents: number;
  /** Lo que queda en la cuenta fuera de los fondos: valor − valor de los fondos. */
  sinInvertirCents: number;
};

type Saldo = { account_id: string; balance_cents: number };
type Valor = { account_id: string; worth_cents: number };
type Posicion = { account_id: string; value_cents: number };

/**
 * Solo el valor de cada cuenta, sin desglose: lo que pinta «Dónde está» y lo
 * que suma la cifra héroe de Patrimonio. Una cuenta que no aparezca en
 * `valores` —no debería pasar: la vista sale de la de saldos— se queda con su
 * saldo.
 */
export function valorDeCadaCuenta(
  saldos: readonly Saldo[],
  valores: readonly Valor[],
): Map<string, number> {
  const valorDe = new Map(valores.map((v) => [v.account_id, v.worth_cents]));
  return new Map(saldos.map((s) => [s.account_id, valorDe.get(s.account_id) ?? s.balance_cents]));
}

/**
 * El valor de cada cuenta, con sus fondos. `posiciones` son las ACTIVAS (las
 * mismas que suma `v_account_worth`); una cuenta que no aparezca en `valores`
 * —no debería pasar: la vista sale de la de saldos— se queda con su saldo.
 */
export function valoresPorCuenta(
  saldos: readonly Saldo[],
  valores: readonly Valor[],
  posiciones: readonly Posicion[],
): Map<string, ValorCuenta> {
  const valorDe = valorDeCadaCuenta(saldos, valores);
  const fondosDe = new Map<string, { n: number; cents: number }>();
  for (const p of posiciones) {
    const f = fondosDe.get(p.account_id) ?? { n: 0, cents: 0 };
    f.n += 1;
    f.cents += p.value_cents;
    fondosDe.set(p.account_id, f);
  }

  const resultado = new Map<string, ValorCuenta>();
  for (const s of saldos) {
    const valorCents = valorDe.get(s.account_id) ?? s.balance_cents;
    const f = fondosDe.get(s.account_id) ?? { n: 0, cents: 0 };
    resultado.set(s.account_id, {
      valorCents,
      fondos: f.n,
      enFondosCents: f.cents,
      sinInvertirCents: valorCents - f.cents,
    });
  }
  return resultado;
}

/**
 * El subtítulo de una cuenta con fondos, en dos piezas: qué es la cifra y, si
 * además hay efectivo fuera de los fondos, cuánto. `null` si no tiene fondos
 * (su cifra es su saldo y el subtítulo de siempre basta).
 */
export function explicacionValor(
  v: ValorCuenta,
): { que: string; sinInvertir: string | null } | null {
  if (v.fondos === 0) return null;
  const que = v.fondos === 1 ? "Valor de su fondo" : `Valor de ${v.fondos} fondos`;
  if (v.sinInvertirCents === 0) return { que, sinInvertir: null };
  // Negativo solo si la cuenta ha traspasado a sus fondos más de lo que tenía:
  // no es «sin invertir», es un descubierto, y se dice así.
  const sinInvertir =
    v.sinInvertirCents > 0
      ? `Incluye ${formatCents(v.sinInvertirCents)} sin invertir`
      : `Incluye un saldo de ${formatCents(v.sinInvertirCents)}`;
  return { que, sinInvertir };
}

/** Una fila de `account_balance_monthly`: el valor de una cuenta al cierre de un mes. */
type ValorMes = { archived: boolean; period_month: string; worth_cents: number };

/**
 * El total de las cuentas ACTIVAS al cierre de cada mes, de más antiguo a más
 * reciente, quedándose con los `meses` últimos. Es la curva del total de la
 * cabecera: suma lo mismo que ella (el valor, no el saldo), así que su último
 * punto y la cifra grande hablan de lo mismo.
 */
export function totalPorMes(
  filas: readonly ValorMes[],
  meses: number,
): { period_month: string; cents: number }[] {
  const porMes = new Map<string, number>();
  for (const f of filas) {
    if (f.archived) continue;
    porMes.set(f.period_month, (porMes.get(f.period_month) ?? 0) + f.worth_cents);
  }
  return [...porMes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-meses)
    .map(([period_month, cents]) => ({ period_month, cents }));
}
