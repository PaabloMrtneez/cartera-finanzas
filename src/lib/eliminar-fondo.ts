import { enumerar, nombreConfirma } from "./eliminar-cuenta";
import { formatCents } from "./money";

/**
 * Eliminar un fondo (una posición de inversión): el tipo del preview que
 * devuelve `position_delete_preview` y las frases que lo cuentan en la
 * confirmación.
 *
 * Vive en un módulo NEUTRAL (ni servidor ni cliente) porque lo usan los dos: la
 * acción del servidor valida y tipa el JSON de la base, y el paso del cliente
 * lo convierte en frases. Ver `client-boundary.test.ts`.
 *
 * Todos los importes son céntimos enteros (invariante 1); la validación lo
 * exige y rechaza el preview entero si llega un decimal.
 */

/** La misma regla que `delete_position` en la base (y que al eliminar una cuenta). */
export { nombreConfirma };

export type EfectoSaldo = {
  account_id: string;
  name: string;
  archived: boolean;
  /** Aportaciones (que movían saldo) que tocan esta cuenta. */
  transfers: number;
  /** Cuánto cambia el saldo de ESA cuenta al borrarlas (positivo = sube). */
  balance_delta_cents: number;
};

export type PositionDeletePreview = {
  position_id: string;
  name: string;
  archived: boolean;
  /** Sigue la cotización de un instrumento (fondo, ETF o acción). */
  follows_instrument: boolean;
  account_id: string;
  account_name: string;
  /** Lo que vale hoy (v_position_value). */
  value_cents: number;
  valuations: number;
  /** Eventos del libro de participaciones (ALTA, AJUSTE, BAJA). */
  unit_events: number;
  contributions: {
    /** Aportaciones que movían saldo. */
    count: number;
    /** Su importe total. */
    cents: number;
    /** Aportaciones descartadas: también se borran, pero no movían nada. */
    discarded: number;
  };
  balance_effects: EfectoSaldo[];
  /** Cuánto cambia el patrimonio neto (aportado − valor, si no estaba archivada). */
  net_worth_delta_cents: number;
};

function entero(v: unknown): number {
  // Postgres devuelve count(*) y bigint dentro de jsonb como número JSON.
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error("no entero");
  return v;
}
function texto(v: unknown): string {
  if (typeof v !== "string") throw new Error("no texto");
  return v;
}
function booleano(v: unknown): boolean {
  if (typeof v !== "boolean") throw new Error("no booleano");
  return v;
}
function objeto(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("no objeto");
  return v as Record<string, unknown>;
}

/**
 * Valida el JSON de `position_delete_preview`. Devuelve null si no tiene la
 * forma esperada: mejor no enseñar nada que enseñar cifras inventadas.
 */
export function parsePositionDeletePreview(raw: unknown): PositionDeletePreview | null {
  try {
    const p = objeto(raw);
    const c = objeto(p.contributions);
    if (!Array.isArray(p.balance_effects)) return null;
    return {
      position_id: texto(p.position_id),
      name: texto(p.name),
      archived: booleano(p.archived),
      follows_instrument: booleano(p.follows_instrument),
      account_id: texto(p.account_id),
      account_name: texto(p.account_name),
      value_cents: entero(p.value_cents),
      valuations: entero(p.valuations),
      unit_events: entero(p.unit_events),
      contributions: {
        count: entero(c.count),
        cents: entero(c.cents),
        discarded: entero(c.discarded),
      },
      balance_effects: p.balance_effects.map((x) => {
        const o = objeto(x);
        return {
          account_id: texto(o.account_id),
          name: texto(o.name),
          archived: booleano(o.archived),
          transfers: entero(o.transfers),
          balance_delta_cents: entero(o.balance_delta_cents),
        };
      }),
      net_worth_delta_cents: entero(p.net_worth_delta_cents),
    };
  } catch {
    return null;
  }
}

/** «1 valoración», «12 valoraciones». */
function contar(n: number, singular: string, plural: string): string {
  return `${n.toLocaleString("es-ES")} ${n === 1 ? singular : plural}`;
}

/**
 * La frase principal: qué se borra. «Se borrarán 12 valoraciones, 3 registros
 * de participaciones y 4 aportaciones (3.500,00 €).» Sin nada colgado, lo dice.
 */
export function fraseBorradoFondo(p: PositionDeletePreview): string {
  const partes: string[] = [];
  if (p.valuations > 0) partes.push(contar(p.valuations, "valoración", "valoraciones"));
  if (p.unit_events > 0)
    partes.push(contar(p.unit_events, "registro de participaciones", "registros de participaciones"));
  const { count, cents, discarded } = p.contributions;
  if (count > 0) partes.push(`${contar(count, "aportación", "aportaciones")} (${formatCents(cents)})`);
  if (discarded > 0) partes.push(contar(discarded, "aportación descartada", "aportaciones descartadas"));

  if (partes.length === 0) return "El fondo no tiene valoraciones ni aportaciones: solo se borrará el fondo.";
  return `Se borrarán ${enumerar(partes)}.`;
}

/**
 * Lo que cambia en las cuentas: una frase por cuenta. «El saldo de BBVA Nómina
 * subirá 3.000,00 €.» Las cuentas de origen suben (el dinero vuelve) y la de
 * inversión baja lo mismo.
 */
export function frasesSaldos(p: PositionDeletePreview): string[] {
  return p.balance_effects
    .filter((x) => x.balance_delta_cents !== 0)
    .map((x) =>
      x.balance_delta_cents > 0
        ? `El saldo de ${x.name} subirá ${formatCents(x.balance_delta_cents)}.`
        : `El saldo de ${x.name} bajará ${formatCents(-x.balance_delta_cents)}.`,
    );
}

/** Qué le pasa al patrimonio. */
export function frasePatrimonio(p: PositionDeletePreview): string {
  const d = p.net_worth_delta_cents;
  if (p.archived)
    return d === 0
      ? "Tu patrimonio no cambia: el fondo está archivado y no tenía aportaciones."
      : `Tu patrimonio subirá ${formatCents(d)}: el fondo archivado ya no contaba y lo aportado vuelve a sus cuentas.`;
  if (d === 0) return "Tu patrimonio no cambia: lo aportado vuelve a sus cuentas y el fondo valía eso mismo.";
  if (d < 0)
    return `Tu patrimonio bajará ${formatCents(-d)}: el fondo vale más de lo que vuelve a tus cuentas.`;
  return `Tu patrimonio subirá ${formatCents(d)}: vuelve a tus cuentas más de lo que el fondo vale hoy.`;
}

/** Lo que vale y deja de contar. */
export function fraseValorFondo(p: PositionDeletePreview): string {
  if (p.archived) return "Está archivado: su valor ya no contaba en tu patrimonio.";
  return `Vale ${formatCents(p.value_cents)}, que dejarán de contar en tu patrimonio.`;
}
