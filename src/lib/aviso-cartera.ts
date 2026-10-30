import { createHash } from "node:crypto";
import { esFechaIso, ZONA_HORARIA } from "@/lib/dates";
import { esInstanteIso } from "@/lib/ingesta";
import { parseAmountToCents } from "@/lib/money";

/**
 * El aviso que muestra Cartera (Wallet) por cada cargo de una tarjeta guardada
 * —con Apple Pay o sin él: online, desde otra app, una recarga—, tal como lo
 * entrega el disparador «Al recibir una notificación de Cartera» de iOS 27:
 *
 *   Título     «Santander»                  la tarjeta (su nombre en Cartera)
 *   Subtítulo  «Cafeteria. Madrid, Madrid»  el comercio, a veces con el lugar
 *   Cuerpo     «2,30 €»                     el importe, solo
 *   Fecha      «27 oct 2026, 10:00» o ISO   cuándo llegó el aviso
 *
 * El atajo manda los cuatro campos tal cual y la lectura se hace aquí: si
 * Apple cambia el formato, se arregla en la app sin tocar el iPhone.
 */
export type AvisoCartera = {
  tarjeta?: string | null;
  comercio?: string | null;
  importe: string;
  fecha?: string | null;
};

export type AvisoLeido =
  | {
      ok: true;
      cents: number;
      /** El nombre de la tarjeta en Cartera: decide la cuenta. */
      tarjeta: string | null;
      comercio: string | null;
      /** ISO 8601 con desplazamiento, o null (la base pone la hora de llegada). */
      occurredAt: string | null;
    }
  | { ok: false; error: "invalid_amount" | "currency_not_supported" | "not_a_charge"; pista: string };

/**
 * «Cafeteria. Madrid, Madrid» → «Cafeteria». Cartera añade la ciudad y la
 * provincia tras un punto; sin quitarlas, la misma cafetería en dos ciudades
 * serían dos comercios para las reglas. Solo se quita ese final exacto
 * («. Algo, Algo»): «Dr. Oetker» o «Amazon.es» se quedan como están.
 */
export function limpiarComercio(texto: string | null | undefined): string | null {
  const t = (texto ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const m = /^(.+?)\.\s+[^.,]+,\s*[^.,]+$/.exec(t);
  return (m ? m[1] : t).trim() || null;
}

const MESES: Record<string, number> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12,
};

/** Minutos que Madrid va por delante de UTC en ese instante (60 o 120). */
function desfaseMadrid(instante: Date): number {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONA_HORARIA,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instante);
  const v = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value);
  const comoUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"));
  return Math.round((comoUtc - Math.floor(instante.getTime() / 60_000) * 60_000) / 60_000);
}

/** Una hora de pared en Madrid → ISO con su desplazamiento («+01:00» / «+02:00»). */
export function isoDesdeMadrid(y: number, mes: number, d: number, h: number, min: number): string | null {
  const fecha = `${y}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (!esFechaIso(fecha) || h > 23 || min > 59) return null;
  const comoUtc = Date.UTC(y, mes - 1, d, h, min);
  // Se ajusta dos veces: el desfase de la hora supuesta puede no ser el de la
  // real cerca del cambio de hora.
  let desfase = desfaseMadrid(new Date(comoUtc));
  desfase = desfaseMadrid(new Date(comoUtc - desfase * 60_000));
  const signo = desfase >= 0 ? "+" : "-";
  const abs = Math.abs(desfase);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${fecha}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00${signo}${hh}:${mm}`;
}

/**
 * La fecha del aviso. Vale ISO 8601 (si en el atajo se le pone ese formato) o
 * la que iOS escribe por defecto en español: «27 oct 2026, 10:00», con o sin
 * coma, y «27/10/2026 10:00». Lo que no se entiende devuelve null y la base
 * usa la hora de llegada, que es la del pago con segundos de diferencia: un
 * aviso no se pierde por la forma de su fecha.
 */
export function leerFechaAviso(texto: string | null | undefined): string | null {
  const t = (texto ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (esInstanteIso(t)) return t;

  const largo = /^(\d{1,2}) ([a-zá]{3,5})\.? (\d{4}),? (\d{1,2}):(\d{2})$/i.exec(t);
  if (largo) {
    const mes = MESES[largo[2].toLowerCase()];
    if (!mes) return null;
    return isoDesdeMadrid(Number(largo[3]), mes, Number(largo[1]), Number(largo[4]), Number(largo[5]));
  }
  const corto = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),? (\d{1,2}):(\d{2})$/.exec(t);
  if (corto) {
    return isoDesdeMadrid(Number(corto[3]), Number(corto[2]), Number(corto[1]), Number(corto[4]), Number(corto[5]));
  }
  return null;
}

/** El aviso de Cartera → lo que necesita la ingesta, o por qué no es un cargo. */
export function leerAvisoCartera(aviso: AvisoCartera): AvisoLeido {
  const bruto = aviso.importe.replace(/\s+/g, " ").trim();

  // Otra moneda: Cartera la escribe con su símbolo o su código.
  if (/[$£¥₿]|\b(USD|GBP|CHF|JPY|MXN|ARS)\b/i.test(bruto)) {
    return { ok: false, error: "currency_not_supported", pista: `Llegó «${bruto}»: solo se apuntan cargos en euros.` };
  }
  // Un signo delante (devolución, abono) o palabras: no es un cargo que apuntar.
  if (/^[-−+]/.test(bruto) || /[a-zñ]{3,}/i.test(bruto.replace(/€|eur/gi, ""))) {
    return {
      ok: false,
      error: "not_a_charge",
      pista: `Llegó «${bruto}» en el importe: no parece un cargo (una devolución o un aviso de otro tipo).`,
    };
  }

  const cents = parseAmountToCents(bruto.replace(/€|eur/gi, "").trim());
  if (cents === null || cents <= 0) {
    return {
      ok: false,
      error: "invalid_amount",
      pista: bruto
        ? `El cuerpo del aviso traía «${bruto}» y no se entiende como importe.`
        : "El importe llegó vacío: el campo «importe» del atajo tiene que llevar el Cuerpo de la notificación.",
    };
  }

  return {
    ok: true,
    cents,
    tarjeta: (aviso.tarjeta ?? "").replace(/\s+/g, " ").trim() || null,
    comercio: limpiarComercio(aviso.comercio),
    occurredAt: leerFechaAviso(aviso.fecha),
  };
}

/**
 * El identificador de un aviso: el mismo aviso (iOS lo reintenta) da el mismo,
 * y la base no lo apunta dos veces. Va con el texto CRUDO de la fecha, que es
 * lo que distingue dos cafés iguales a horas distintas. Sin fecha, cuenta el
 * minuto de llegada (`llegada`): un reintento en el mismo minuto no duplica,
 * aunque dos cafés iguales en ese minuto se fundirían (por eso la guía pide
 * mandar siempre la fecha).
 */
export function idDeAviso(aviso: AvisoCartera, cents: number, llegada: Date = new Date()): string {
  const fecha = aviso.fecha?.trim() || `llegada ${llegada.toISOString().slice(0, 16)}`;
  const huella = [aviso.tarjeta ?? "", aviso.comercio ?? "", String(cents), fecha]
    .map((s) => s.replace(/\s+/g, " ").trim())
    .join("|");
  return `cartera_${createHash("sha256").update(huella).digest("hex").slice(0, 40)}`;
}
