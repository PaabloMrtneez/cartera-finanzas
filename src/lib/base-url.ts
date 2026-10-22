import { headers } from "next/headers";

/**
 * La dirección estable de la app, para lo que se copia fuera de ella.
 *
 * NO se puede usar el `host` de la petición. Abriendo la app desde un despliegue
 * de vista previa —cosa normal al probar antes de publicar— ese host es algo
 * como `wallet-ay6wvkrht-....vercel.app`, que apunta a ESA compilación concreta.
 * Un Atajo del iPhone montado con esa dirección se queda clavado en una versión
 * vieja y deja de funcionar cuando el despliegue desaparece, sin dar la cara: el
 * pago simplemente no entra.
 *
 * `VERCEL_PROJECT_PRODUCTION_URL` la pone Vercel sola en todos los despliegues,
 * incluidos los de vista previa, y siempre es el dominio de producción. En local
 * no existe, y ahí sí vale el host de la petición.
 */
export async function getBaseUrl(): Promise<string> {
  const produccion = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (produccion) return `https://${produccion}`;

  const host = (await headers()).get("host") ?? "localhost:3000";
  const protocolo = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return `${protocolo}://${host}`;
}
