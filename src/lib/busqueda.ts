/**
 * Texto del usuario dentro de una búsqueda: cómo meterlo sin que cambie el
 * significado de la consulta.
 *
 * Hay dos capas que pueden reinterpretar lo que se escribe, y cada una tiene su
 * escape:
 *
 * 1. **Los comodines de LIKE/ILIKE.** `%` es «cualquier cosa» y `_` es «un
 *    carácter». Sin escaparlos, buscar «50%» encuentra «50 €» y buscar «_» lo
 *    encuentra todo. Postgres escapa con la barra invertida por defecto, así que
 *    la barra también se escapa.
 *
 * 2. **La gramática de filtros de PostgREST.** Dentro de `or=(…)`, `and=(…)` o
 *    `in.(…)`, la coma separa condiciones, el paréntesis las agrupa y el punto
 *    separa columna, operador y valor. Un texto interpolado tal cual puede
 *    romper la consulta («Amazon, Inc») o añadirle condiciones nuevas
 *    («x%,id.neq.0»). La RLS impide que eso llegue a datos de otro usuario, pero
 *    la búsqueda deja de ser la que se escribió. PostgREST admite el valor entre
 *    comillas dobles, con `\"` y `\\` como únicos escapes.
 *
 * Lo preferible es no interpolar nada: pasar el texto como argumento de una RPC
 * (`search_transactions`), que llega a Postgres como parámetro. Para eso basta
 * con la capa 1. La capa 2 solo hace falta si alguna vez se vuelve a construir
 * un `.or()` o un `.filter()` con texto del usuario; la prueba de
 * `busqueda.test.ts` vigila que no aparezca ninguno sin pasar por aquí.
 */

/**
 * Escapa los comodines de LIKE/ILIKE para que el texto se busque literal.
 * Pensado para el argumento de una RPC que hace `col ilike '%' || p_q || '%'`.
 */
export function escaparComodinesLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Patrón «contiene» para un filtro `.ilike()` de PostgREST.
 *
 * Además de los comodines de Postgres, PostgREST convierte TODO `*` de un
 * patrón like/ilike en `%`, y no hay forma de escaparlo. Por eso el `*` se
 * cambia por `_` (un carácter cualquiera): sigue encontrando el asterisco
 * literal y, como mucho, algún falso positivo de un carácter, en lugar de
 * convertirse en un «cualquier cosa» que lo encuentra todo.
 *
 * En un filtro simple (`col=ilike.valor`) PostgREST toma el valor tal cual, sin
 * interpretar comas ni paréntesis, así que no hace falta citarlo. Dentro de un
 * `.or()` sí: ver `citarValorPostgrest`.
 */
export function patronContienePostgrest(texto: string): string {
  return `%${escaparComodinesLike(texto).replaceAll("*", "_")}%`;
}

/**
 * Cita un valor para usarlo dentro de `or=(…)`, `and=(…)` o `in.(…)` de
 * PostgREST: entre comillas dobles, con `"` y `\` escapados. Así la coma, el
 * paréntesis, el punto o los dos puntos del texto son texto y no gramática.
 */
export function citarValorPostgrest(valor: string): string {
  return `"${valor.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
