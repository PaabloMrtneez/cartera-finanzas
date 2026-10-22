import { EsqLista, EsqueletoPantalla } from "@/components/app/esqueleto";

/* Grupos de ajustes en dos columnas en escritorio, como la pantalla. */
export default function Cargando() {
  return (
    <EsqueletoPantalla
      titulo="Ajustes"
      subtitulo
      className="lg:grid lg:max-w-[1080px] lg:grid-cols-2 lg:items-start"
    >
      <EsqLista filas={3} />
      <EsqLista filas={4} />
      <EsqLista filas={2} />
    </EsqueletoPantalla>
  );
}
