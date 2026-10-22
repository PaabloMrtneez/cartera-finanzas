import { Bloque, EsqHeroe, EsqLista, EsqTarjeta, EsqueletoPantalla } from "@/components/app/esqueleto";

export default function Cargando() {
  return (
    <EsqueletoPantalla titulo="Fijos">
      <EsqHeroe />
      {/* El conmutador Gastos · Ingresos. */}
      <Bloque className="h-9 w-56 rounded-sm" />
      <EsqLista filas={5} />
      <EsqTarjeta cuerpo="h-40" />
    </EsqueletoPantalla>
  );
}
