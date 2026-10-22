/**
 * La cifra que «cuenta» al registrar un movimiento.
 *
 * Cuando alguien apunta un ingreso o un gasto y luego llega a Resumen, la cifra
 * que ha cambiado sube desde su valor anterior hasta el nuevo: rápido al
 * principio y frenando al acercarse, como cuando acabas de cobrar y ves subir el
 * dinero. Este módulo es neutral —ni servidor ni cliente— para que lo puedan
 * importar el formulario (que deja la señal), el componente que anima y las
 * pruebas de las funciones puras.
 *
 * Lo que vive aquí:
 *  · la SEÑAL en `sessionStorage` que dice «vengo de registrar» (dejar / evaluar
 *    / borrar),
 *  · la CURVA `easeOutExpo` que interpola el número,
 *  · la DURACIÓN en función de la cantidad, con suelo y techo.
 */

/** Tipos de movimiento que animan una cifra. Un traspaso no mueve ninguna. */
export type TipoCuenta = "EXPENSE" | "INCOME";

/**
 * La señal que el formulario deja tras registrar. No lleva el valor viejo del
 * servidor: con el `delta` basta para contar desde `objetivo − delta`.
 */
export type RegistroReciente = {
  tipo: TipoCuenta;
  /** Importe del movimiento en céntimos: el delta que la cifra recorre. */
  delta: number;
  /** Primer día del mes del movimiento, para animar solo si se ve ese mes. */
  mes: string;
  /** Cuándo se registró, en epoch ms, para medir la frescura. */
  ts: number;
};

/** La clave del almacén. Con prefijo de la app para no chocar con nada. */
const CLAVE = "cartera:registro-reciente";

/**
 * Más allá de esto, una visita a Resumen ya no es «vengo de registrar»: es una
 * visita normal, y una visita normal no debe disparar la cuenta. Quince
 * segundos dan de sobra para guardar y saltar a Resumen, y no tantos como para
 * que una vuelta despistada media hora después cuente sola.
 */
export const FRESCURA_MS = 15_000;

/**
 * Deja la señal. La llama el formulario al guardar con éxito, solo al CREAR y
 * solo en los casos de cuenta limpia (un gasto, o un ingreso que no reembolsa).
 * Si `sessionStorage` no está disponible —modo privado, cuota llena—, no pasa
 * nada: la animación es un adorno, y sin señal simplemente no se anima.
 */
export function dejarRegistroReciente(datos: Omit<RegistroReciente, "ts">): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(CLAVE, JSON.stringify({ ...datos, ts: Date.now() }));
  } catch {
    // Sin almacén, sin animación. No es un error que deba verse.
  }
}

/** Qué hacer con la señal al llegar a una pantalla. */
export type EvaluacionRegistro = {
  /** La señal que debe animar ahora, o null si esta pantalla no la usa. */
  animar: RegistroReciente | null;
  /** Si hay que retirar la señal del almacén (consumida, o caduca/basura). */
  limpiar: boolean;
};

/**
 * Decide, para el mes que se está viendo, si hay una cuenta que disparar.
 *
 * Es una función PURA (no toca el almacén): se lee en el inicializador de
 * `useState`, que puede ejecutarse dos veces con StrictMode, y borrar ahí dentro
 * dejaría la segunda lectura en blanco. El borrado se hace aparte, en un efecto,
 * guiado por `limpiar`.
 *
 * Reglas:
 *  · basura o caduca → no anima y SÍ se limpia (que no ensucie visitas futuras),
 *  · fresca pero de OTRO mes → no anima y NO se limpia (que dispare cuando se
 *    navegue a ese mes),
 *  · fresca y de este mes → anima y se consume.
 */
export function evaluarRegistro(mesActual: string): EvaluacionRegistro {
  if (typeof window === "undefined") return { animar: null, limpiar: false };

  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(CLAVE);
  } catch {
    return { animar: null, limpiar: false };
  }
  if (!raw) return { animar: null, limpiar: false };

  const señal = parseRegistro(raw);
  if (!señal) return { animar: null, limpiar: true };
  if (Date.now() - señal.ts >= FRESCURA_MS) return { animar: null, limpiar: true };
  if (señal.mes !== mesActual) return { animar: null, limpiar: false };
  return { animar: señal, limpiar: true };
}

/** Retira la señal del almacén. Idempotente: llamarla de más no molesta. */
export function borrarRegistroReciente(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(CLAVE);
  } catch {
    // Nada que hacer.
  }
}

/* --------------------------------------------------------------------------
   La bienvenida: la cuenta de 0 → valor la primera vez que se abre Resumen.
-------------------------------------------------------------------------- */

/**
 * La marca de que la bienvenida de Resumen YA se vio en esta sesión.
 *
 * La cuenta de 0 → valor de las tres cifras héroe (gasto, ingresos, balance) es
 * un momento de bienvenida. Se permite UNA vez por sesión, no en cada visita a
 * Resumen: la pantalla se abre mucho, y de-cada-navegación el efecto pasaría de
 * deleite a estorbo. Con prefijo de la app, como la señal de registro.
 */
const CLAVE_BIENVENIDA = "cartera:resumen-bienvenida-vista";

/**
 * ¿Toca la bienvenida? Cierto solo mientras la marca NO está puesta: la primera
 * carga de Resumen de la sesión.
 *
 * Función PURA (solo lee), igual que `evaluarRegistro`: se lee en el
 * inicializador de `useState`, que StrictMode puede ejecutar dos veces, y
 * consumir ahí dentro dejaría la segunda lectura en blanco. El marcado —el
 * efecto colateral— va aparte, en un efecto.
 */
export function bienvenidaPendiente(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(CLAVE_BIENVENIDA) === null;
  } catch {
    // Sin almacén no se puede recordar si ya se vio; mejor no animar que
    // repetir la bienvenida en cada carga.
    return false;
  }
}

/** Deja la marca: la bienvenida ya se vio en esta sesión. Idempotente. */
export function marcarBienvenidaVista(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(CLAVE_BIENVENIDA, "1");
  } catch {
    // Sin almacén, sin marca: la bienvenida es un adorno, no un dato.
  }
}

/** Retira la marca de bienvenida. Para las pruebas y la limpieza de sesión. */
export function borrarBienvenida(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(CLAVE_BIENVENIDA);
  } catch {
    // Nada que hacer.
  }
}

/** Valida la forma de lo leído: un JSON ajeno o viejo no debe animar. */
function parseRegistro(raw: string): RegistroReciente | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.tipo !== "EXPENSE" && o.tipo !== "INCOME") return null;
    if (typeof o.delta !== "number" || !Number.isFinite(o.delta)) return null;
    if (typeof o.mes !== "string") return null;
    if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return null;
    return { tipo: o.tipo, delta: o.delta, mes: o.mes, ts: o.ts };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
   La curva y la duración.
-------------------------------------------------------------------------- */

/**
 * Ease-out exponencial: arranca disparado y llega frenando casi a cero, que es
 * el gesto de «ver subir el dinero». Está normalizada para tocar exactamente el
 * 1 en t = 1; el easeOutExpo de manual se queda en 0,999 y pega un salto al
 * final, que en una cifra grande son varios euros de golpe.
 */
export function easeOutExpo(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return (1 - Math.pow(2, -10 * t)) / (1 - Math.pow(2, -10));
}

/** Lo mínimo que dura una cuenta: por debajo se lee como un parpadeo. */
const SUELO_MS = 1200;
/** Lo máximo: un momento deliberado y raro puede durar, pero no eternizarse. */
const TECHO_MS = 9000;
/** A partir de este importe (en €) la cuenta ya dura lo máximo. */
const EUROS_TECHO = 3000;

/**
 * Cuánto dura la cuenta según el importe. Crece con la cantidad pero se satura:
 * la raíz cuadrada estira los importes pequeños (un café no dura lo mismo que un
 * alquiler) y aplana los grandes contra el techo.
 *
 *   duración = SUELO + (TECHO − SUELO) · min(1, √€ / √3000)
 *
 * Referencias: 2,50 € ≈ 1,25 s · 45 € ≈ 2,1 s · 500 € ≈ 4,4 s · 1200 € ≈ 6,1 s ·
 * 3000 € o más → 9 s. Un pago pequeño nunca se acerca al techo.
 */
export function duracionCuenta(deltaCents: number): number {
  const euros = Math.abs(deltaCents) / 100;
  const f = Math.min(1, Math.sqrt(euros) / Math.sqrt(EUROS_TECHO));
  return Math.round(SUELO_MS + (TECHO_MS - SUELO_MS) * f);
}
