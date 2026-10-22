import { EsqHeroe, EsqTarjeta, EsqueletoPantalla } from "@/components/app/esqueleto";

export default function Cargando() {
  return (
    <EsqueletoPantalla titulo="Patrimonio">
      <EsqHeroe />
      {/* La curva de evolución, a lo ancho. */}
      <EsqTarjeta cuerpo="h-48 lg:h-72" />
      <EsqTarjeta cuerpo="h-40" />
    </EsqueletoPantalla>
  );
}
