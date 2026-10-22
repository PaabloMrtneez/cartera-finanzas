import { EsqHeroe, EsqLista, EsqTarjeta, EsqTira, EsqueletoPantalla } from "@/components/app/esqueleto";

export default function Cargando() {
  return (
    <EsqueletoPantalla titulo="Inversiones">
      <div className="flex flex-col">
        <EsqHeroe />
        <div className="mt-5 lg:mt-6">
          <EsqTira />
        </div>
      </div>
      <EsqTarjeta cuerpo="h-48 lg:h-64" />
      <EsqLista filas={3} />
    </EsqueletoPantalla>
  );
}
