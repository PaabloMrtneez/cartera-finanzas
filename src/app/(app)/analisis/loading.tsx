import { EsqHeroe, EsqTarjeta, EsqueletoPantalla } from "@/components/app/esqueleto";

/* La misma rejilla de 12 columnas que la pantalla en escritorio. */
export default function Cargando() {
  return (
    <EsqueletoPantalla
      titulo="Análisis"
      className="lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-8 lg:gap-y-8"
    >
      <EsqHeroe className="lg:col-span-12" />
      <EsqTarjeta cuerpo="h-48 lg:h-56" className="lg:col-span-7" />
      <EsqTarjeta cuerpo="h-48 lg:h-56" className="lg:col-span-5" />
      <EsqTarjeta cuerpo="h-40" className="lg:col-span-6" />
      <EsqTarjeta cuerpo="h-40" className="lg:col-span-6" />
    </EsqueletoPantalla>
  );
}
