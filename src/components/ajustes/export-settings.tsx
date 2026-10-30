import Link from "next/link";
import { ContenidoFila, FILA_AJUSTE_ENLACE, SeccionAjustes } from "@/components/ajustes/seccion";
import { Icon } from "@/components/ui/icon";

/**
 * Descargar tus datos.
 *
 * Son enlaces normales, sin nada de JavaScript: el navegador descarga y ya. Un
 * botón que montara el fichero en memoria se comería un año de movimientos en
 * el móvil sin necesidad.
 */
const OPCIONES = [
  {
    href: "/api/informe",
    icon: "chart-pie",
    titulo: "Informe de este mes (Markdown)",
    detalle:
      "Resumen del mes —gasto por categoría frente a tu media y estado de los límites—, pensado para pedirle a un asistente qué ajustar para ahorrar más.",
  },
  {
    href: "/api/exportar?formato=csv",
    icon: "list",
    titulo: "Movimientos en CSV",
    detalle: "Para abrirlo en Excel o en Numbers. Importes en euros, con coma.",
  },
  {
    href: "/api/exportar?formato=json",
    icon: "database",
    titulo: "Copia completa en JSON",
    detalle: "Todo: cuentas, categorías, reglas, límites e inversiones. En céntimos exactos.",
  },
] as const;

export function ExportSettings() {
  return (
    <SeccionAjustes
      titulo="Tus datos"
      descripcion="Se descarga solo lo tuyo. Además hay una copia cifrada semanal del servidor, por si el problema no eres tú."
    >
      {OPCIONES.map((o) => (
        <a key={o.href} href={o.href} download className={FILA_AJUSTE_ENLACE}>
          <ContenidoFila
            icono={<Icon name={o.icon} size={17} />}
            titulo={o.titulo}
            detalle={o.detalle}
          />
          <Icon name="download" size={18} />
        </a>
      ))}

      <Link href="/importar" className={FILA_AJUSTE_ENLACE}>
        <ContenidoFila
          icono={<Icon name="arrow-down" size={17} />}
          titulo="Importar del banco"
          detalle="Un extracto en CSV. Se enseña lo que va a entrar antes de escribir nada."
        />
        <Icon name="chevron-right" size={18} />
      </Link>
    </SeccionAjustes>
  );
}
