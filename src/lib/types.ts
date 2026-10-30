export const TRANSACTION_TYPES = ["EXPENSE", "INCOME", "TRANSFER"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  EXPENSE: "Gasto",
  INCOME: "Ingreso",
  TRANSFER: "Traspaso",
};

export const ACCOUNT_TYPES = ["BANCO", "EFECTIVO", "AHORRO", "INVERSION", "PRESTAMO"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Los tipos que se pueden ELEGIR al crear o editar una cuenta a mano. PRESTAMO
 * no: esa cuenta (el pasivo, con saldo negativo = lo que debes) la crea y la
 * gestiona el préstamo (`create_loan`), y su tipo no se puede cambiar mientras
 * el préstamo exista.
 */
export const ACCOUNT_TYPES_ELEGIBLES = ["BANCO", "EFECTIVO", "AHORRO", "INVERSION"] as const;
export type AccountTypeElegible = (typeof ACCOUNT_TYPES_ELEGIBLES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  BANCO: "Banco",
  EFECTIVO: "Efectivo",
  AHORRO: "Ahorro",
  INVERSION: "Inversión",
  PRESTAMO: "Préstamo",
};

export const ACCOUNT_TYPE_ICONS: Record<AccountType, string> = {
  BANCO: "landmark",
  EFECTIVO: "banknote",
  AHORRO: "piggy-bank",
  INVERSION: "chart-line",
  PRESTAMO: "hand-coins",
};

/** El estado de un préstamo (columna `loan.status`). */
export const LOAN_STATUSES = ["ACTIVO", "LIQUIDADO", "CANCELADO"] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  ACTIVO: "Activo",
  LIQUIDADO: "Liquidado",
  CANCELADO: "Cancelado",
};

/** De qué parte de un préstamo es un movimiento (columna `transaction.loan_part`). */
export const LOAN_PARTS = [
  "DESEMBOLSO",
  "COMISION",
  "INTERESES",
  "CAPITAL",
  "LIQUIDACION",
  "COMISION_CANCELACION",
  "AMORTIZACION",
  "COMISION_AMORTIZACION",
] as const;
export type LoanPart = (typeof LOAN_PARTS)[number];

/** El estado de cada cuota en `loan_schedule`. */
export type LoanInstallmentState = "PREVIA" | "COBRADA" | "PENDIENTE" | "ANULADA";

/**
 * El tipo de una tarjeta. Es una etiqueta informativa, no un comportamiento:
 * ninguna de las tres cambia de dónde sale el dinero (todas gastan del saldo de
 * su cuenta). Coincide con el enum `card_type` de la base de datos.
 */
export const CARD_TYPES = ["DEBITO", "CREDITO", "PREPAGO"] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CARD_TYPE_LABELS: Record<CardType, string> = {
  DEBITO: "Débito",
  CREDITO: "Crédito",
  PREPAGO: "Prepago",
};

export const TRANSACTION_SOURCES = ["SHORTCUT", "MANUAL", "RECURRING", "IMPORT"] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const PERIODICITIES = ["SEMANAL", "MENSUAL", "TRIMESTRAL", "ANUAL"] as const;
export type Periodicity = (typeof PERIODICITIES)[number];

/** Cuántos cargos al año genera cada periodicidad. Para anualizar suscripciones. */
export const PERIODICITY_PER_YEAR: Record<Periodicity, number> = {
  SEMANAL: 52,
  MENSUAL: 12,
  TRIMESTRAL: 4,
  ANUAL: 1,
};

export const PERIODICITY_LABELS: Record<Periodicity, string> = {
  SEMANAL: "Semanal",
  MENSUAL: "Mensual",
  TRIMESTRAL: "Trimestral",
  ANUAL: "Anual",
};

/** El color semántico de cada tipo, como variable CSS. */
export const TYPE_COLOR_VAR: Record<TransactionType, string> = {
  EXPENSE: "var(--expense)",
  INCOME: "var(--income)",
  TRANSFER: "var(--transfer)",
};
