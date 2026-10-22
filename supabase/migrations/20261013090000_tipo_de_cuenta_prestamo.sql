-- ===========================================================================
-- Un tipo de cuenta más: PRESTAMO, la cuenta-PASIVO de un préstamo.
--
-- Su saldo es NEGATIVO y vale lo que se debe. El desembolso es un traspaso de
-- esta cuenta a la del banco, y el capital de cada cuota un traspaso de vuelta;
-- así el patrimonio refleja la deuda sin almacenar nada (invariante 2) y el
-- capital no cuenta como gasto (invariante 3). Ver 20261013090100_prestamos.sql.
--
-- Va en su propia migración porque PostgreSQL no deja USAR un valor de enum
-- nuevo en la misma transacción en la que se añade (el mismo motivo que
-- 20260819090000_import_source.sql).
-- ===========================================================================

alter type public.account_type add value if not exists 'PRESTAMO';
