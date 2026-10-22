import { EsqHeroe, EsqLista, EsqTarjeta, EsqTira, EsqueletoPantalla } from "@/components/app/esqueleto";

export default function Cargando() {
  return (
    <EsqueletoPantalla titulo="Resumen">
      <EsqHeroe />
      {/* La banda de categorías. */}
      <EsqTarjeta titulo={false} cuerpo="h-24" />
      <EsqTira />
      <EsqTarjeta cuerpo="h-36 lg:h-44" />
      <EsqLista filas={4} cabecera />
    </EsqueletoPantalla>
  );
}
