/**
 * Borrador local de «Nuevo movimiento» (hallazgo M-6).
 *
 * Una recarga, un cambio de pestaña o el sistema matando la app en segundo
 * plano se llevaban lo que estabas escribiendo. Ahora el formulario deja una
 * copia en `sessionStorage` a cada cambio y la recupera al volver a montarse.
 *
 * `sessionStorage` y no `localStorage`, a propósito: vive lo que vive la
 * pestaña (o la app instalada abierta). Un importe a medio escribir no debe
 * reaparecer días después, ni sobrevivir a cerrar la sesión en un dispositivo
 * compartido.
 *
 * Los importes viajan como el TEXTO que escribió el usuario («12,40»), nunca
 * como número: el paso a céntimos lo sigue haciendo el servidor.
 */

export const CLAVE_BORRADOR_MOVIMIENTO = "cartera:borrador:nuevo-movimiento";

/** Caduca a las 12 horas: un borrador de ayer ya no es «lo que estabas escribiendo». */
const VIDA_MS = 12 * 60 * 60 * 1000;

export type BorradorMovimiento = {
  type: "EXPENSE" | "INCOME" | "TRANSFER";
  categoryId: string | null;
  fecha: string;
  reembolsa: {
    id: string;
    description: string;
    amount_cents: number;
    occurred_on: string;
    merchant_raw: string | null;
  } | null;
  seRepite: boolean;
  periodicidad: string;
  destino: string;
  posicionId: string;
  /** Los campos sin estado de React, tal como están en el formulario. */
  campos: {
    amount: string;
    description: string;
    occurred_time: string;
    account_id: string;
    note: string;
    position_units: string;
  };
};

/** ¿Hay algo que merezca la pena recuperar? Tipo, fecha o cuenta solos no. */
export function tieneContenido(b: BorradorMovimiento): boolean {
  const { amount, description, note, position_units } = b.campos;
  return (
    [amount, description, note, position_units].some((t) => t.trim() !== "") ||
    b.categoryId !== null ||
    b.reembolsa !== null ||
    b.seRepite
  );
}

export function guardarBorrador(b: BorradorMovimiento) {
  try {
    if (!tieneContenido(b)) {
      sessionStorage.removeItem(CLAVE_BORRADOR_MOVIMIENTO);
      return;
    }
    sessionStorage.setItem(CLAVE_BORRADOR_MOVIMIENTO, JSON.stringify({ ...b, ts: Date.now() }));
  } catch {
    // Sin sessionStorage (modo privado estricto, cuota llena): sin borrador.
  }
}

export function leerBorrador(ahora = Date.now()): BorradorMovimiento | null {
  try {
    const raw = sessionStorage.getItem(CLAVE_BORRADOR_MOVIMIENTO);
    if (!raw) return null;
    const datos = JSON.parse(raw) as BorradorMovimiento & { ts?: number };
    if (typeof datos.ts !== "number" || ahora - datos.ts > VIDA_MS || !datos.campos) {
      sessionStorage.removeItem(CLAVE_BORRADOR_MOVIMIENTO);
      return null;
    }
    const { ts: _ts, ...borrador } = datos;
    void _ts;
    return tieneContenido(borrador) ? borrador : null;
  } catch {
    return null;
  }
}

export function borrarBorrador() {
  try {
    sessionStorage.removeItem(CLAVE_BORRADOR_MOVIMIENTO);
  } catch {
    // Nada que borrar.
  }
}
