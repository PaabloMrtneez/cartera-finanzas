import { Bloque, EsqHeroe, EsqLista, EsqueletoPantalla } from "@/components/app/esqueleto";

export default function Cargando() {
  return (
    <EsqueletoPantalla titulo="Cuentas">
      <EsqHeroe />
      <div aria-hidden className="flex flex-col gap-2">
        <Bloque className="mx-1 h-3 w-24" />
        <EsqLista filas={4} />
      </div>
    </EsqueletoPantalla>
  );
}
