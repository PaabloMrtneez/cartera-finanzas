import { Bloque, EsqHeroe, EsqLista, EsqueletoPantalla } from "@/components/app/esqueleto";

/*
 * En el grupo `(lista)` y no en `movimientos/` a propósito: ahí envolvería
 * también `/movimientos/nuevo` y `/movimientos/[id]`, y abrir la hoja de
 * «Nuevo movimiento» enseñaría el esqueleto de la LISTA.
 */
export default function Cargando() {
  return (
    <EsqueletoPantalla titulo="Movimientos">
      <EsqHeroe />
      {/* Mes y filtros. */}
      <div aria-hidden className="flex h-9 items-center justify-between gap-2">
        <Bloque className="h-8 w-44 rounded-sm" />
        <Bloque className="h-8 w-24 rounded-sm lg:hidden" />
      </div>
      {/* El buscador. */}
      <Bloque className="h-11 w-full rounded-sm" />
      <EsqLista filas={8} cabecera />
    </EsqueletoPantalla>
  );
}
