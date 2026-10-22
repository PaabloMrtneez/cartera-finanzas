"use client";

/**
 * «±»: cambia el signo de un importe escrito en un campo.
 *
 * Existe por el iPhone. `inputMode="decimal"` saca el teclado numérico, que es
 * el bueno para escribir dinero, pero ese teclado NO tiene signo menos: un
 * saldo inicial en deuda o una valoración que ha caído un 3 % no se podían
 * escribir. En lugar de cambiar a un teclado completo para todos los importes
 * (casi siempre positivos), se deja el numérico y este botón al lado. Solo en
 * móvil: un teclado físico ya tiene «-».
 */
export function BotonSigno({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Cambiar el signo"
      className="pulsable flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[19px] font-semibold text-fg lg:hidden"
    >
      ±
    </button>
  );
}

/** El mismo texto con el signo contrario: «12,40» ↔ «-12,40». */
export function alternarSigno(texto: string): string {
  const limpio = texto.trim();
  if (limpio.startsWith("-") || limpio.startsWith("−")) return limpio.slice(1);
  return `-${limpio}`;
}
