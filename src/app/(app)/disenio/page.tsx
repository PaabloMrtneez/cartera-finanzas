import { notFound } from "next/navigation";
import { MuestrarioAurora } from "@/components/app/muestrario-aurora";
import { PageBody, PageHeader } from "@/components/app/page-header";

export const metadata = { title: "Sistema de diseño" };

/**
 * Banco de pruebas de la identidad Aurora. No es una pantalla del producto: no
 * tiene enlace en la navegación (ver `nav.test.ts`) y existe para comprobar de
 * un vistazo que tokens, materiales y primitivos se portan en los dos temas.
 * Se rehízo en la auditoría final: el anterior seguía hablando de «latón» y
 * «tinta» y no enseñaba ni el espectro ni los gráficos.
 *
 * En PRODUCCIÓN no existe (404): es una herramienta de quien desarrolla, no
 * algo que tengan que encontrarse los usuarios (fase 2 de seguridad). Sigue
 * abierta en local y en los despliegues de vista previa, que es donde se mira.
 */
export default function DisenioPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    <>
      <PageHeader title="Sistema de diseño" subtitle="Muestrario de la identidad Aurora" />
      <PageBody className="lg:max-w-3xl">
        <MuestrarioAurora />
      </PageBody>
    </>
  );
}
