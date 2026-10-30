import { z } from "zod";
import { esFechaIso } from "./dates";
import { parseAmountToCents } from "./money";
import { isinValido, parseParticipaciones } from "./participaciones";
import {
  PLAZO_MAXIMO,
  PRINCIPAL_MAXIMO,
  PRINCIPAL_MINIMO,
  TAE_MAXIMA,
  TIN_MAXIMO,
  comisionPorPorcentaje,
  leerTipo,
  primeraCuotaPorDefecto,
} from "./prestamos";
import { ACCOUNT_TYPES_ELEGIBLES, CARD_TYPES, TRANSACTION_TYPES } from "./types";
// H-11: los mensajes por defecto de Zod, en español (configuración global).
import "./zod-es";

/**
 * Validación compartida entre el formulario y el servidor. El cliente nunca es
 * fuente de verdad: estos esquemas se ejecutan siempre en el servidor, y la
 * base de datos vuelve a comprobar los invariantes por su cuenta.
 */

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** El tope de `tx_amount_positive` en la base: mil millones de euros. */
export const IMPORTE_MAXIMO_CENTS = 100_000_000_000;
export const MENSAJE_TOPE_IMPORTE = "El importe máximo es de 1.000 millones de euros";

/** Texto de un importe → céntimos enteros. Nunca coma flotante. */
export const amountCents = z
  .string({ error: "Escribe un importe válido, por ejemplo 12,40" })
  .transform((value, ctx) => {
    const cents = parseAmountToCents(value);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: "Escribe un importe válido, por ejemplo 12,40" });
      return z.NEVER;
    }
    if (Math.abs(cents) > IMPORTE_MAXIMO_CENTS) {
      ctx.addIssue({ code: "custom", message: MENSAJE_TOPE_IMPORTE });
      return z.NEVER;
    }
    return cents;
  });

export const positiveAmountCents = amountCents.refine((cents) => cents > 0, {
  message: "El importe tiene que ser mayor que cero",
});

/** El saldo inicial sí puede ser negativo: una tarjeta arranca en deuda. */
export const signedAmountCents = amountCents;

/**
 * Una fecha `YYYY-MM-DD` que EXISTE (H-12). Comprobar solo el formato dejaba
 * pasar «2026-02-30» o «2026-13-45» hasta Postgres, que respondía en inglés.
 * Es la única: las acciones la importan de aquí en vez de tener su copia.
 */
export const isoDate = z
  .string({ error: "Fecha no válida" })
  .refine((v) => esFechaIso(v), "Fecha no válida");

/** Una hora `HH:MM` de 00:00 a 23:59 (H-12): «99:99» no es una hora. */
export const horaHHMM = z
  .string({ error: "Hora no válida" })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora no válida");

/** El id de una fila: un uuid, con mensaje propio (H-16). */
export const idSchema = z.uuid("No se ha encontrado. Recarga la página.");

/** El icono de una categoría: un nombre de la lista (kebab-case), no texto libre (H-24). */
const iconoSchema = z
  .string({ error: "Elige un icono" })
  .trim()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Elige un icono")
  .max(40, "Elige un icono");

export const accountSchema = z.object({
  name: z.string().trim().min(1, "Ponle un nombre").max(60, "Máximo 60 caracteres"),
  // PRESTAMO no se elige a mano: esa cuenta la crea y la gestiona su préstamo.
  type: z.enum(ACCOUNT_TYPES_ELEGIBLES, {
    error: "Elige un tipo de cuenta. Las de préstamo se gestionan desde Préstamos.",
  }),
  initial_balance_cents: signedAmountCents,
  color: z.string().regex(HEX, "Color no válido"),
});

/**
 * Eliminar una cuenta exige escribir su nombre. Aquí solo se comprueba que hay
 * algo escrito y que cabe; la comparación exacta la hace `delete_account` en la
 * base, contra el nombre guardado (la única fuente de verdad).
 */
export const accountDeleteSchema = z.object({
  id: z.uuid("Cuenta no válida"),
  confirm_name: z
    .string()
    .trim()
    .min(1, "Escribe el nombre de la cuenta para confirmar")
    .max(60, "Máximo 60 caracteres"),
});

/**
 * Eliminar un fondo (posición): el id y el nombre escrito para confirmar. El
 * mismo tope que `position_name_len` (60). La comparación exacta la hace
 * `delete_position` en la base.
 */
export const positionDeleteSchema = z.object({
  id: z.uuid("Posición no válida"),
  confirm_name: z
    .string()
    .trim()
    .min(1, "Escribe el nombre del fondo para confirmar")
    .max(60, "Máximo 60 caracteres"),
});

/**
 * Una tarjeta es un último4 con nombre, colgado de una cuenta. Etiqueta, no
 * crédito: solo sirve para que el Atajo del iPhone enrute cada pago a su cuenta.
 * Los mismos límites que impone la tabla `card` (last4 de 4 dígitos, tipo del
 * enum, alias de 1 a 40 caracteres), comprobados antes para dar un mensaje
 * decente en lugar de un error de restricción.
 */
export const cardSchema = z.object({
  account_id: z.uuid("Elige una cuenta"),
  last4: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ""))
    .refine((value) => /^\d{4}$/.test(value), "Escribe los 4 dígitos de la tarjeta"),
  type: z.enum(CARD_TYPES, { error: "Elige si es de débito o de crédito" }),
  // El alias es opcional: vacío se guarda como null. Si se escribe, la base de
  // datos exige entre 1 y 40 caracteres (ya sin espacios de sobra).
  nickname: z
    .string()
    .trim()
    .max(40, "El alias admite 40 caracteres como mucho")
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .default(null),
});

/** Al editar una tarjeta no se cambia de cuenta: se queda en la suya. */
export const cardEditSchema = cardSchema.omit({ account_id: true });

export const categorySchema = z.object({
  name: z.string().trim().min(1, "Ponle un nombre").max(40, "Máximo 40 caracteres"),
  type: z.enum(TRANSACTION_TYPES, { error: "Elige si es de gasto, de ingreso o de traspaso" }),
  color: z.string().regex(HEX, "Color no válido"),
  icon: iconoSchema,
});

/** Al editar no se toca el tipo: es inmutable, y la base de datos lo impide. */
export const categoryEditSchema = categorySchema.omit({ type: true });

export const merchantRuleSchema = z.object({
  match_text: z
    .string()
    .trim()
    .min(2, "Escribe al menos 2 caracteres")
    .max(60, "Máximo 60 caracteres"),
  category_id: z.uuid("Elige una categoría"),
  apply_retroactively: z.boolean().default(false),
});

export const transactionSchema = z
  .object({
    type: z.enum(TRANSACTION_TYPES, { error: "Elige si es un gasto, un ingreso o un traspaso" }),
    amount_cents: positiveAmountCents,
    description: z.string().trim().max(200, "El concepto admite 200 caracteres como mucho").default(""),
    occurred_on: isoDate,
    occurred_time: horaHHMM.default("00:00"),
    account_id: z.uuid("Elige una cuenta"),
    to_account_id: z.uuid("Elige la cuenta de destino").nullable().default(null),
    category_id: z.uuid("Elige una categoría").nullable().default(null),
    note: z.string().trim().max(500, "La nota admite 500 caracteres como mucho").nullable().default(null),
    reimburses_id: z.uuid("Elige el gasto que reembolsa").nullable().default(null),
    /**
     * A qué posición fue el dinero de un traspaso a una cuenta de inversión.
     *
     * Es lo que convierte «he movido 640 € a My Investor» en «he metido 640 €
     * en el MSCI»: sin esto, el rendimiento no tiene coste contra el que
     * medirse. Opcional a propósito: se puede dejar dinero en la cuenta sin
     * desplegar, y eso es justo lo que Patrimonio llama «sin desplegar».
     */
    position_id: z.uuid("Elige una posición").nullable().default(null),
    /**
     * Las participaciones que compró la aportación, cuando la posición sigue un
     * fondo o una acción. Texto → decimal exacto (lib/participaciones.ts), nunca
     * un float. Vacío es null, y la base las estima con el precio de ese día.
     */
    position_units: z
      .string()
      .nullable()
      .default(null)
      .transform((v, ctx) => {
        if (v === null || v.trim() === "") return null;
        const lectura = parseParticipaciones(v);
        if (!lectura.ok) {
          ctx.addIssue({ code: "custom", message: lectura.error });
          return z.NEVER;
        }
        return lectura.valor;
      }),
  })
  // Los mismos invariantes que impone la base de datos, comprobados antes para
  // poder dar un mensaje decente en lugar de un error de restricción.
  .refine((v) => v.type !== "TRANSFER" || v.to_account_id !== null, {
    message: "Un traspaso necesita cuenta de destino",
    path: ["to_account_id"],
  })
  .refine((v) => v.type === "TRANSFER" || v.to_account_id === null, {
    message: "Solo un traspaso tiene cuenta de destino",
    path: ["to_account_id"],
  })
  .refine((v) => v.type !== "TRANSFER" || v.to_account_id !== v.account_id, {
    message: "El destino tiene que ser una cuenta distinta del origen",
    path: ["to_account_id"],
  })
  .refine((v) => v.reimburses_id === null || v.type === "INCOME", {
    message: "Solo un ingreso puede reembolsar un gasto",
    path: ["reimburses_id"],
  })
  // El mismo `tx_position_only_transfer` que impone la base de datos.
  .refine((v) => v.position_id === null || v.type === "TRANSFER", {
    message: "Solo un traspaso puede ir a una posición",
    path: ["position_id"],
  })
  // Y el `tx_units_only_position`: participaciones solo con posición.
  .refine((v) => v.position_units === null || v.position_id !== null, {
    message: "Solo una aportación a una posición puede llevar participaciones",
    path: ["position_units"],
  });

// ---------------------------------------------------------------------------
// Inversiones que se actualizan solas (instrumento de mercado + participaciones)
// ---------------------------------------------------------------------------

/** El mismo formato que el CHECK de `instrument.yahoo_symbol`. */
const SIMBOLO_YAHOO = /^[A-Za-z0-9.^=-]{1,32}$/;

/**
 * Participaciones escritas por una persona → decimal EXACTO en texto
 * («1.234,5678» → «1234.5678»), que es como viajan a `numeric(24,8)`. Nunca
 * `parseFloat`: ver lib/participaciones.ts.
 */
export function participacionesSchema({ permitirCero = false } = {}) {
  return z.string().transform((texto, ctx) => {
    const lectura = parseParticipaciones(texto, { permitirCero });
    if (!lectura.ok) {
      ctx.addIssue({ code: "custom", message: lectura.error });
      return z.NEVER;
    }
    return lectura.valor;
  });
}

export const buscarInstrumentosSchema = z.object({
  q: z
    .string()
    .trim()
    .min(2, "Escribe al menos dos letras del nombre, el ISIN o el símbolo")
    .max(80, "Máximo 80 caracteres"),
});

/** Una posición nueva que nace ya siguiendo un instrumento. */
const posicionNuevaSchema = z.object({
  name: z.string().trim().min(1, "Ponle un nombre").max(60, "Máximo 60 caracteres"),
  account_id: z.uuid("Elige una cuenta de inversión"),
  color: z.string().regex(HEX, "Color no válido"),
});

export const seguirInstrumentoSchema = z
  .object({
    /** Una posición que ya existe… */
    position_id: z.uuid("Posición no válida").nullable().default(null),
    /** …o los datos para crearla. Una de las dos, no las dos. */
    nueva: posicionNuevaSchema.nullable().default(null),
    simbolo: z.string().trim().regex(SIMBOLO_YAHOO, "Elige un instrumento de la lista"),
    isin: z
      .string()
      .trim()
      .toUpperCase()
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .default(null)
      .refine((v) => v === null || isinValido(v), "Ese ISIN no es válido: revisa las letras y los números"),
    participaciones: participacionesSchema(),
    /** Total aportado hasta la fecha: el «importe invertido» del bróker. */
    aportado: amountCents.refine((c) => c >= 0, "Lo aportado no puede ser negativo"),
    fecha: isoDate,
  })
  .refine((v) => (v.position_id === null) !== (v.nueva === null), {
    message: "Elige una posición o crea una nueva",
    path: ["position_id"],
  });

export const ajustarParticipacionesSchema = z.object({
  position_id: z.uuid("Posición no válida"),
  // Un ajuste puede dejar la posición a cero: lo has vendido todo.
  participaciones: participacionesSchema({ permitirCero: true }),
  fecha: isoDate,
  nota: z
    .string()
    .trim()
    .max(200, "Máximo 200 caracteres")
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null),
});

export const dejarDeSeguirSchema = z.object({
  position_id: z.uuid("Posición no válida"),
  fecha: isoDate,
});

export const participacionesAportacionSchema = z.object({
  transaction_id: z.uuid("Movimiento no válido"),
  /** null o vacío: se borran y se vuelven a estimar con el precio del día. */
  participaciones: z
    .string()
    .nullable()
    .default(null)
    .transform((v, ctx) => {
      if (v === null || v.trim() === "") return null;
      const lectura = parseParticipaciones(v);
      if (!lectura.ok) {
        ctx.addIssue({ code: "custom", message: lectura.error });
        return z.NEVER;
      }
      return lectura.valor;
    }),
});

// ---------------------------------------------------------------------------
// Préstamos. Los límites son los mismos CHECK de `loan` y de create_loan; aquí
// se comprueban antes para dar un mensaje decente. Los tipos (TIN, TAE, la
// comisión en %) se leen como decimal EXACTO con `leerTipo` (diezmilésimas de
// punto), nunca con parseFloat: ver lib/prestamos.ts.
// ---------------------------------------------------------------------------

/** Texto de un tipo de interés → diezmilésimas de punto («6,5» → 65 000). */
function tipoSchema(maximo: number, mensaje: string) {
  return z.string().transform((texto, ctx) => {
    const t = leerTipo(texto, maximo);
    if (t === null) {
      ctx.addIssue({ code: "custom", message: mensaje });
      return z.NEVER;
    }
    return t;
  });
}

/** Un tipo opcional: vacío → null. */
function tipoOpcionalSchema(maximo: number, mensaje: string) {
  return z
    .string()
    .nullable()
    .default(null)
    .transform((texto, ctx) => {
      if (texto === null || texto.trim() === "") return null;
      const t = leerTipo(texto, maximo);
      if (t === null) {
        ctx.addIssue({ code: "custom", message: mensaje });
        return z.NEVER;
      }
      return t;
    });
}

/**
 * Un entero escrito con DÍGITOS (H-25). `z.coerce.number` aceptaba «1e2» o
 * «0x10» como meses; aquí solo valen cifras (o un número entero de verdad).
 */
const entero = (min: number, max: number, mensaje: string) =>
  z.union([z.number(), z.string()], { error: mensaje }).transform((v, ctx) => {
    const texto = typeof v === "number" ? String(v) : v.trim();
    const n = /^\d{1,9}$/.test(texto) ? Number(texto) : Number.NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: "custom", message: mensaje });
      return z.NEVER;
    }
    return n;
  });

/** Cómo se escribe la comisión de apertura: un importe o un % del principal. */
export const LOAN_FEE_MODES = ["IMPORTE", "PORCENTAJE"] as const;
export type LoanFeeMode = (typeof LOAN_FEE_MODES)[number];

/** Las condiciones financieras, sin la cuenta (la vista previa no la necesita). */
const loanFinanceBase = z.object({
  principal_cents: positiveAmountCents.refine(
    (c) => c >= PRINCIPAL_MINIMO && c <= PRINCIPAL_MAXIMO,
    "El importe va de 100 € a 10 millones",
  ),
  term_months: entero(1, PLAZO_MAXIMO, `El plazo va de 1 a ${PLAZO_MAXIMO} meses`),
  tin: tipoSchema(TIN_MAXIMO, `Escribe el TIN, por ejemplo 6,5 (de 0 a ${TIN_MAXIMO} %)`),
  fee_mode: z.enum(LOAN_FEE_MODES, { error: "Elige si la comisión va en euros o en %" }).default("IMPORTE"),
  fee: z.string().default(""),
  charge_day: entero(1, 28, "El día de cobro va del 1 al 28").default(1),
  start_on: isoDate,
  /** Vacía: el día de cobro del mes siguiente al de inicio (como create_loan). */
  first_charge_on: isoDate.nullable().default(null),
  /** true: «el dinero entra ahora»; false: «ya lo tenía apuntado». */
  disbursed: z.boolean({ error: "Indica si el dinero entra ahora o ya lo tenías apuntado" }),
});

type LoanFinanceRaw = z.output<typeof loanFinanceBase>;

/**
 * Lo común a la vista previa y al alta: la comisión a CÉNTIMOS (si venía en %,
 * redondeada al céntimo con mitad hacia arriba sobre el principal), la primera
 * cuota resuelta y las reglas que cruzan campos. El TIN sale en diezmilésimas
 * de punto (ver lib/prestamos.ts).
 */
function completarCondiciones<T extends LoanFinanceRaw>(v: T, ctx: z.RefinementCtx) {
  let comision = 0;
  const texto = v.fee.trim();
  if (texto !== "") {
    if (v.fee_mode === "PORCENTAJE") {
      const t = leerTipo(texto, 100);
      if (t === null) {
        ctx.addIssue({ code: "custom", message: "Escribe la comisión en %, por ejemplo 1,5", path: ["fee"] });
        return z.NEVER;
      }
      comision = comisionPorPorcentaje(v.principal_cents, t);
    } else {
      const c = parseAmountToCents(texto);
      if (c === null || c < 0) {
        ctx.addIssue({ code: "custom", message: "Escribe la comisión en euros, por ejemplo 150,00", path: ["fee"] });
        return z.NEVER;
      }
      comision = c;
    }
  }
  if (comision >= v.principal_cents) {
    ctx.addIssue({ code: "custom", message: "La comisión no puede llegar al importe del préstamo", path: ["fee"] });
    return z.NEVER;
  }
  if (!v.disbursed && comision > 0) {
    ctx.addIssue({
      code: "custom",
      message: "Un préstamo que ya tenías apuntado no lleva comisión de apertura",
      path: ["fee"],
    });
    return z.NEVER;
  }
  const primera = v.first_charge_on ?? primeraCuotaPorDefecto(v.start_on, v.charge_day);
  if (primera <= v.start_on) {
    ctx.addIssue({
      code: "custom",
      message: "La primera cuota tiene que ser posterior a la fecha de inicio",
      path: ["first_charge_on"],
    });
    return z.NEVER;
  }
  if (Number(primera.slice(8, 10)) !== v.charge_day) {
    ctx.addIssue({
      code: "custom",
      message: "La primera cuota tiene que caer en el día de cobro",
      path: ["first_charge_on"],
    });
    return z.NEVER;
  }
  return {
    principal_cents: v.principal_cents,
    term_months: v.term_months,
    tin: v.tin,
    opening_fee_cents: comision,
    charge_day: v.charge_day,
    start_on: v.start_on,
    first_charge_on: primera,
    disbursed: v.disbursed,
  };
}

/** Las condiciones de la vista previa (sin cuenta). */
export const loanPreviewSchema = loanFinanceBase.transform(completarCondiciones);

/** Las condiciones de un alta o de un cambio de condiciones: con la cuenta de pago. */
export const loanTermsSchema = loanFinanceBase
  .extend({ payment_account_id: z.uuid("Elige la cuenta desde la que se paga") })
  .transform((v, ctx) => {
    const c = completarCondiciones(v, ctx);
    return c === z.NEVER ? z.NEVER : { ...c, payment_account_id: v.payment_account_id };
  });

const loanNameSchema = z.string().trim().min(1, "Ponle un nombre").max(40, "Máximo 40 caracteres");
const taeSchema = tipoOpcionalSchema(TAE_MAXIMA, `Escribe la TAE, por ejemplo 6,9 (de 0 a ${TAE_MAXIMA} %), o déjala vacía`);

/**
 * La categoría del préstamo y qué cuenta como gasto: solo los intereses (lo de
 * siempre) o la cuota entera, que entonces necesita una categoría (la base lo
 * exige también). Sin categoría, los intereses van a «Intereses».
 */
const loanGastoCampos = {
  category_id: z.uuid("Elige una categoría de la lista").nullable().default(null),
  counts_full_installment: z.boolean().default(false),
};
const CATEGORIA_DE_LA_CUOTA = {
  message: "Elige en qué categoría cuenta la cuota",
  path: ["category_id"],
};
const cuotaConCategoria = (v: { category_id: string | null; counts_full_installment: boolean }) =>
  !v.counts_full_installment || v.category_id !== null;

/** Alta: nombre, TAE opcional (si falta, la app la calcula), la categoría y las condiciones. */
export const loanCreateSchema = z
  .object({
    name: loanNameSchema,
    tae: taeSchema,
    ...loanGastoCampos,
    terms: loanTermsSchema,
  })
  .refine(cuotaConCategoria, CATEGORIA_DE_LA_CUOTA);

/** Lo que se puede cambiar siempre: el nombre, la TAE del contrato y la categoría. */
export const loanUpdateSchema = z
  .object({
    id: z.uuid("Préstamo no válido"),
    name: loanNameSchema,
    tae: taeSchema,
    ...loanGastoCampos,
  })
  .refine(cuotaConCategoria, CATEGORIA_DE_LA_CUOTA);

/**
 * Una aportación extra: el importe (1 € o más; que no llegue a lo que se debe
 * lo comprueba la base), la fecha (por defecto hoy), si reduce plazo o cuota y
 * la comisión o intereses que cobre el banco, si los hay.
 */
export const loanPrepaymentSchema = z.object({
  id: z.uuid("Préstamo no válido"),
  on: isoDate.nullable().default(null),
  amount_cents: z.string().transform((texto, ctx) => {
    const c = parseAmountToCents(texto);
    if (c === null || c < 100) {
      ctx.addIssue({ code: "custom", message: "Escribe la aportación en euros, de 1 € o más, por ejemplo 500,00" });
      return z.NEVER;
    }
    return c;
  }),
  mode: z.enum(["PLAZO", "CUOTA"], { error: "Elige si reduce el plazo o la cuota" }),
  fee_cents: z
    .string()
    .default("")
    .transform((texto, ctx) => {
      if (texto.trim() === "") return 0;
      const c = parseAmountToCents(texto);
      if (c === null || c < 0) {
        ctx.addIssue({ code: "custom", message: "Escribe la comisión en euros, por ejemplo 25,00" });
        return z.NEVER;
      }
      return c;
    }),
});

/** Liquidación anticipada: la fecha (por defecto hoy) y la comisión, si la hay. */
export const loanSettleSchema = z.object({
  id: z.uuid("Préstamo no válido"),
  on: isoDate.nullable().default(null),
  fee_cents: z
    .string()
    .default("")
    .transform((texto, ctx) => {
      if (texto.trim() === "") return 0;
      const c = parseAmountToCents(texto);
      if (c === null || c < 0) {
        ctx.addIssue({ code: "custom", message: "Escribe la comisión en euros, por ejemplo 50,00" });
        return z.NEVER;
      }
      return c;
    }),
});

/**
 * Eliminar un préstamo exige escribir su nombre. La comparación exacta la hace
 * `delete_loan` en la base, contra el nombre guardado.
 */
export const loanDeleteSchema = z.object({
  id: z.uuid("Préstamo no válido"),
  confirm_name: z
    .string()
    .trim()
    .min(1, "Escribe el nombre del préstamo para confirmar")
    .max(40, "Máximo 40 caracteres"),
});

export type LoanTermsInput = z.input<typeof loanTermsSchema>;
export type LoanTerms = z.output<typeof loanTermsSchema>;

export type SeguirInstrumentoInput = z.input<typeof seguirInstrumentoSchema>;
export type AjustarParticipacionesInput = z.input<typeof ajustarParticipacionesSchema>;
export type DejarDeSeguirInput = z.input<typeof dejarDeSeguirSchema>;
export type ParticipacionesAportacionInput = z.input<typeof participacionesAportacionSchema>;

/**
 * Invitar a alguien: solo el correo. Se normaliza (sin espacios, en minúsculas)
 * para que «Ana@Correo.com » y «ana@correo.com» sean la misma persona y no dos
 * cuentas.
 */
export const invitarSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Escribe el correo de la persona")
    .max(254, "Ese correo es demasiado largo")
    .pipe(z.email("Ese correo no parece válido")),
});

export type AccountInput = z.infer<typeof accountSchema>;
export type CardInput = z.infer<typeof cardSchema>;
export type CategoryInput = z.infer<typeof categorySchema>;
export type TransactionInput = z.infer<typeof transactionSchema>;

/** Forma que devuelven todas las acciones de servidor. */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Primer mensaje de error de un ZodError, para enseñárselo a la persona. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Revisa los datos del formulario";
}
