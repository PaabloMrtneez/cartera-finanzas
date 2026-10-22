import { EsqHeroe, EsqLista, EsqTira, EsqueletoPantalla } from "@/components/app/esqueleto";

export default function Cargando() {
  return (
    <EsqueletoPantalla titulo="Préstamos">
      <div className="flex flex-col">
        <EsqHeroe />
        <div className="mt-5 lg:mt-6">
          <EsqTira columnas={2} />
        </div>
      </div>
      <EsqLista filas={2} />
    </EsqueletoPantalla>
  );
}
