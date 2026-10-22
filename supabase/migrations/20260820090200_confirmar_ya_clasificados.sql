-- ===========================================================================
-- Confirmar los cargos que ya tenían categoría pero seguían pendientes.
--
-- Había dos caminos para clasificar un cargo del Atajo —el diálogo de
-- clasificar y el formulario de edición— y solo el primero cambiaba el estado.
-- Quien usara el segundo dejaba el movimiento con su categoría puesta y en
-- PENDIENTE a la vez: con su pastilla en la lista y contando en el aviso de la
-- barra inferior, ya clasificado.
--
-- El código ya no lo permite. Esto arregla las filas que quedaron así, que de
-- otro modo habría que tocar una por una.
--
-- La condición es la definición misma de pendiente: si tiene categoría, alguien
-- lo miró. No se inventa nada ni se toca ningún importe.
-- ===========================================================================

update public.transaction
   set status = 'CONFIRMED'
 where status = 'PENDING'
   and category_id is not null;
