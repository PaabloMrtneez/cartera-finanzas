import { formatCents } from "./money";

/**
 * Eliminar una cuenta: el tipo del preview que devuelve
 * `account_delete_preview` y las frases que lo cuentan en la confirmación.
 *
 * Vive en un módulo NEUTRAL (ni servidor ni cliente) porque lo usan los dos: la
 * acción del servidor valida y tipa el JSON de la base, y la hoja del cliente
 * lo convierte en frases. Ver `client-boundary.test.ts`.
 *
 * Todos los importes son céntimos enteros (invariante 1); la validación lo
 * exige y rechaza el preview entero si llega un decimal.
 */

export type ExternalTransfer = {
  account_id: string;
  name: string;
  archived: boolean;
  transfers: number;
  /** Cuánto cambia el saldo de ESA cuenta al borrar los traspasos (negativo = baja). */
  balance_delta_cents: number;
};

export type AccountDeletePreview = {
  account_id: string;
  name: string;
  type: "BANCO" | "EFECTIVO" | "AHORRO" | "INVERSION" | "PRESTAMO";
  archived: boolean;
  balance_cents: number;
  /** Lo que aporta al patrimonio: en una cuenta de inversión, caja + posiciones. */
  worth_cents: number;
  transactions: {
    total: number;
    expenses: number;
    incomes: number;
    transfers: number;
  };
  external_transfers: ExternalTransfer[];
  cards: number;
  positions: number;
  valuations: number;
  subscriptions: number;
  recurring_incomes: number;
  goals: number;
  cross_reimbursements: {
    /** Ingresos de otras cuentas que reembolsaban gastos de esta. */
    incomes_elsewhere: { count: number; cents: number };
    /** Gastos de otras cuentas reembolsados por ingresos de esta. */
    expenses_elsewhere: { count: number; cents: number };
  };
  shortcut_default: boolean;
  active_devices: number;
  /**
   * Préstamos que usan la cuenta (B1): como cuenta de pago o como su
   * cuenta-pasivo. Con alguno, la base NO deja borrarla. Vacío si la base
   * todavía no lo manda (antes de 20261020090900).
   */
  loans: PrestamoDeLaCuenta[];
};

export type PrestamoDeLaCuenta = {
  loan_id: string;
  name: string;
  status: string;
  /** PAGO: las cuotas salen de esta cuenta. PASIVO: es la deuda del préstamo. */
  role: "PAGO" | "PASIVO";
};

const TIPOS = new Set(["BANCO", "EFECTIVO", "AHORRO", "INVERSION", "PRESTAMO"]);

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
 * Valida el JSON de `account_delete_preview`. Devuelve null si no tiene la
 * forma esperada: mejor no enseñar nada que enseñar recuentos inventados.
 */
export function parseAccountDeletePreview(raw: unknown): AccountDeletePreview | null {
  try {
    const p = objeto(raw);
    const t = objeto(p.transactions);
    const cr = objeto(p.cross_reimbursements);
    const ie = objeto(cr.incomes_elsewhere);
    const ee = objeto(cr.expenses_elsewhere);
    const tipo = texto(p.type);
    if (!TIPOS.has(tipo)) return null;
    if (!Array.isArray(p.external_transfers)) return null;
    return {
      account_id: texto(p.account_id),
      name: texto(p.name),
      type: tipo as AccountDeletePreview["type"],
      archived: booleano(p.archived),
      balance_cents: entero(p.balance_cents),
      worth_cents: entero(p.worth_cents),
      transactions: {
        total: entero(t.total),
        expenses: entero(t.expenses),
        incomes: entero(t.incomes),
        transfers: entero(t.transfers),
      },
      external_transfers: p.external_transfers.map((x) => {
        const o = objeto(x);
        return {
          account_id: texto(o.account_id),
          name: texto(o.name),
          archived: booleano(o.archived),
          transfers: entero(o.transfers),
          balance_delta_cents: entero(o.balance_delta_cents),
        };
      }),
      cards: entero(p.cards),
      positions: entero(p.positions),
      valuations: entero(p.valuations),
      subscriptions: entero(p.subscriptions),
      recurring_incomes: entero(p.recurring_incomes),
      goals: entero(p.goals),
      cross_reimbursements: {
        incomes_elsewhere: { count: entero(ie.count), cents: entero(ie.cents) },
        expenses_elsewhere: {
          count: entero(ee.count),
          cents: entero(ee.cents),
        },
      },
      shortcut_default: booleano(p.shortcut_default),
      active_devices: entero(p.active_devices),
      // Antes de 20261020090900 la base no lo manda: sin préstamos.
      loans: p.loans === undefined ? [] : prestamos(p.loans),
    };
  } catch {
    return null;
  }
}

function prestamos(v: unknown): PrestamoDeLaCuenta[] {
  if (!Array.isArray(v)) throw new Error("no lista");
  return v.map((x) => {
    const o = objeto(x);
    const role = texto(o.role);
    if (role !== "PAGO" && role !== "PASIVO") throw new Error("papel desconocido");
    return { loan_id: texto(o.loan_id), name: texto(o.name), status: texto(o.status), role };
  });
}

/**
 * ¿Lo escrito confirma el borrado? La misma regla que `delete_account` en la
 * base: igual EXACTAMENTE tras quitar espacios de los extremos. Mayúsculas y
 * tildes cuentan. La base vuelve a comprobarlo: esto solo activa el botón.
 */
export function nombreConfirma(escrito: string, nombre: string): boolean {
  return escrito.trim().length > 0 && escrito.trim() === nombre.trim();
}

/** «1 movimiento», «124 movimientos». */
function contar(n: number, singular: string, plural: string): string {
  return `${n.toLocaleString("es-ES")} ${n === 1 ? singular : plural}`;
}

/** «a», «a y b», «a, b y c». */
export function enumerar(partes: string[]): string {
  if (partes.length <= 1) return partes[0] ?? "";
  return `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}`;
}

/**
 * La frase principal: qué se borra. «Se borrarán 124 movimientos, 2 tarjetas
 * y 1 meta.» Sin nada colgado, lo dice: solo se borra la cuenta.
 */
export function fraseBorrado(p: AccountDeletePreview): string {
  const partes: string[] = [];
  const t = p.transactions;
  if (t.total > 0) partes.push(contar(t.total, "movimiento", "movimientos"));
  if (p.cards > 0) partes.push(contar(p.cards, "tarjeta", "tarjetas"));
  if (p.positions > 0) {
    const pos = contar(p.positions, "posición", "posiciones");
    partes.push(p.valuations > 0 ? `${pos} con ${contar(p.valuations, "valoración", "valoraciones")}` : pos);
  }
  if (p.subscriptions > 0) partes.push(contar(p.subscriptions, "gasto fijo", "gastos fijos"));
  if (p.recurring_incomes > 0)
    partes.push(contar(p.recurring_incomes, "ingreso fijo", "ingresos fijos"));
  if (p.goals > 0) partes.push(contar(p.goals, "meta", "metas"));

  if (partes.length === 0)
    return "La cuenta no tiene movimientos ni nada colgado: solo se borrará la cuenta.";
  return `Se borrarán ${enumerar(partes)}.`;
}

/** El desglose de los movimientos: «80 gastos, 40 ingresos y 4 traspasos». */
export function desgloseMovimientos(p: AccountDeletePreview): string | null {
  const t = p.transactions;
  if (t.total === 0) return null;
  const partes: string[] = [];
  if (t.expenses > 0) partes.push(contar(t.expenses, "gasto", "gastos"));
  if (t.incomes > 0) partes.push(contar(t.incomes, "ingreso", "ingresos"));
  if (t.transfers > 0) partes.push(contar(t.transfers, "traspaso", "traspasos"));
  return `Entre los movimientos: ${enumerar(partes)}. El gasto y el ingreso de los meses pasados dejarán de contarlos.`;
}

/**
 * Lo que cambia FUERA de la cuenta: los traspasos con otras, una frase por
 * cuenta. «El saldo de Revolut bajará 300,00 € (3 traspasos).»
 */
export function frasesTraspasos(p: AccountDeletePreview): string[] {
  return p.external_transfers.map((x) => {
    const n = contar(x.transfers, "traspaso", "traspasos");
    if (x.balance_delta_cents < 0)
      return `El saldo de ${x.name} bajará ${formatCents(-x.balance_delta_cents)} (${n}).`;
    if (x.balance_delta_cents > 0)
      return `El saldo de ${x.name} subirá ${formatCents(x.balance_delta_cents)} (${n}).`;
    return `Se borrarán ${n} con ${x.name}; su saldo no cambia.`;
  });
}

/** Los reembolsos que cruzan de una cuenta a otra, en frases. */
export function frasesReembolsos(p: AccountDeletePreview): string[] {
  const { incomes_elsewhere: ie, expenses_elsewhere: ee } = p.cross_reimbursements;
  const frases: string[] = [];
  if (ie.count > 0)
    frases.push(
      ie.count === 1
        ? `Un ingreso de otra cuenta (${formatCents(ie.cents)}) reembolsaba un gasto de esta: dejará de ser un reembolso y contará como ingreso.`
        : `${ie.count.toLocaleString("es-ES")} ingresos de otras cuentas (${formatCents(ie.cents)} en total) reembolsaban gastos de esta: dejarán de ser reembolsos y contarán como ingresos.`,
    );
  if (ee.count > 0)
    frases.push(
      ee.count === 1
        ? `Un gasto de otra cuenta tenía su reembolso en esta (${formatCents(ee.cents)}): su gasto neto subirá esa cantidad.`
        : `${ee.count.toLocaleString("es-ES")} gastos de otras cuentas tenían su reembolso en esta (${formatCents(ee.cents)} en total): su gasto neto subirá esa cantidad.`,
    );
  return frases;
}

/** El aviso del Atajo, si esta es su cuenta por defecto. */
export function fraseAtajo(p: AccountDeletePreview): string | null {
  if (!p.shortcut_default) return null;
  return p.active_devices > 0
    ? "Es la cuenta por defecto del Atajo: hasta que elijas otra en Ajustes, los pagos con una tarjeta que no reconozca se rechazarán."
    : "Es la cuenta por defecto del Atajo: tendrás que elegir otra en Ajustes.";
}

/** Lo que vale ahora y deja de contar en el patrimonio. */
export function fraseSaldo(p: AccountDeletePreview): string {
  const valor = p.type === "INVERSION" ? p.worth_cents : p.balance_cents;
  if (valor === 0) return `Su saldo es ${formatCents(0)}: tu patrimonio no lo notará.`;
  return `${p.type === "INVERSION" ? "Vale" : "Tiene"} ${formatCents(valor)}, que dejarán de contar en tu patrimonio.`;
}

/**
 * Si un préstamo usa la cuenta, no se puede borrar (las claves foráneas de la
 * base lo impiden): la frase lo dice ANTES de pedir el nombre. Null si no hay.
 */
export function frasePrestamos(p: AccountDeletePreview): string | null {
  if (p.loans.length === 0) return null;
  const uno = p.loans.length === 1;
  const nombres = enumerar(p.loans.map((l) => `«${l.name}»`));
  const sujeto = uno ? `El préstamo ${nombres}` : `Los préstamos ${nombres}`;
  // La cuenta-pasivo de un préstamo ES su deuda; la de pago, de donde salen las cuotas.
  const soloPasivo = p.loans.every((l) => l.role === "PASIVO");
  const verbo = soloPasivo
    ? uno
      ? "lleva su deuda en esta cuenta"
      : "llevan su deuda en esta cuenta"
    : uno
      ? "usa esta cuenta"
      : "usan esta cuenta";
  return `${sujeto} ${verbo}: no se puede eliminar mientras ${uno ? "exista" : "existan"}. Bórralo o cambia su cuenta de pago antes.`;
}

/** ¿La bloquea algún préstamo? (Entonces no tiene sentido pedir el nombre.) */
export function bloqueadaPorPrestamo(p: AccountDeletePreview): boolean {
  return p.loans.length > 0;
}
