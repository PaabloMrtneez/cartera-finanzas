-- ===========================================================================
-- Un origen más: los movimientos que vienen de un CSV del banco.
--
-- Va en su propia migración porque PostgreSQL no permite USAR un valor de enum
-- nuevo en la misma transacción en la que se añade, y la función que lo usa se
-- valida al crearse.
--
-- Merece un valor propio y no reutilizar MANUAL: al mirar un apunte raro, saber
-- si lo escribiste tú o lo trajo un extracto es la diferencia entre buscar el
-- error en tu memoria o en el fichero.
-- ===========================================================================

alter type public.tx_source add value if not exists 'IMPORT';
