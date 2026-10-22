"use client";

import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/**
 * Enlace de descarga del informe del mes, con aspecto de botón.
 *
 * Es un componente de cliente por una sola razón: `buttonClasses` vive en un
 * módulo `"use client"` y llamarlo desde un componente de servidor revienta en
 * runtime (cruza la frontera cliente/servidor). Aquí se llama en su lado.
 *
 * Es un `<a>` normal con `download`, NO navegación: el endpoint devuelve un
 * fichero Markdown, no una página.
 */
export function ReportDownload({ mes }: { mes: string }) {
  return (
    <a
      href={`/api/informe?mes=${mes}`}
      download
      className={buttonClasses({ variant: "secondary", size: "compact" })}
      aria-label="Descargar el informe del mes"
    >
      <Icon name="download" size={15} />
      <span className="hidden lg:inline">Informe</span>
    </a>
  );
}
