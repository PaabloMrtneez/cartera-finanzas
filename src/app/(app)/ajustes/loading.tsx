import { FILA_SECCION } from "@/components/ajustes/seccion";
import { Bloque, EsqLista, EsqueletoPantalla } from "@/components/app/esqueleto";

/* La misma maqueta que la pantalla: la losa y, debajo, una fila por sección. */
function EsqSeccion({ filas }: { filas: number }) {
  return (
    <div className={FILA_SECCION}>
      <div aria-hidden className="flex flex-col gap-2 px-1 lg:px-0">
        <Bloque className="h-4 w-28" />
        <Bloque className="hidden h-3 w-full lg:block" />
        <Bloque className="hidden h-3 w-3/4 lg:block" />
      </div>
      <EsqLista filas={filas} />
    </div>
  );
}

export default function Cargando() {
  return (
    <EsqueletoPantalla titulo="Ajustes" className="lg:max-w-[1200px] lg:gap-8">
      <EsqLista filas={1} />
      <EsqSeccion filas={1} />
      <EsqSeccion filas={3} />
    </EsqueletoPantalla>
  );
}
