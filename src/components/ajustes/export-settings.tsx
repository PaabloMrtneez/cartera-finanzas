import Link from "next/link";
import { Grupo } from "@/components/ui/card";
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
    <Grupo titulo="Tus datos">

      {OPCIONES.map((o) => (
        <a
          key={o.href}
          href={o.href}
          download
          className="flex min-h-[60px] items-center gap-3 hair-t border-separator px-[18px] py-2 text-fg first:border-t-0"
        >
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
            <Icon name={o.icon} size={16} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-semibold">{o.titulo}</span>
            <span className="text-[13px] leading-[18px] text-muted">{o.detalle}</span>
          </span>
          <Icon name="download" size={18} />
        </a>
      ))}

      <Link
        href="/importar"
        className="fila-pulsable flex min-h-[60px] items-center gap-3 hair-t border-separator px-[18px] py-2 text-fg"
      >
        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
          <Icon name="arrow-down" size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] font-semibold">Importar del banco</span>
          <span className="text-[13px] leading-[18px] text-muted">
            Un extracto en CSV. Se enseña lo que va a entrar antes de escribir nada.
          </span>
        </span>
        <Icon name="chevron-right" size={18} />
      </Link>

      <p className="hair-t border-separator px-[18px] py-3 text-[13px] leading-[18px] text-muted">
        Se descarga solo lo tuyo. Además hay una copia cifrada semanal del servidor, por si el
        problema no eres tú.
      </p>
    </Grupo>
  );
}
