import { EsqTarjeta, EsqueletoPantalla } from "@/components/app/esqueleto";

export default function Cargando() {
  return (
    <EsqueletoPantalla titulo="Metas">
      <div className="flex flex-col gap-3">
        <EsqTarjeta cuerpo="h-24" />
        <EsqTarjeta cuerpo="h-24" />
      </div>
    </EsqueletoPantalla>
  );
}
