import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuración TLS para conectar a la base de Supabase VALIDANDO el certificado.
 *
 * Antes cada script llevaba `ssl: { rejectUnauthorized: false }`, que apaga la
 * validación: cualquiera en posición de intermediario (Wi-Fi hostil, router
 * comprometido) podía presentar un certificado falso e interceptar la
 * `DATABASE_URL` y la `SERVICE_ROLE_KEY`, que son las credenciales más sensibles
 * del proyecto. Era el hallazgo M-02 de la auditoría.
 *
 * El pooler de Supabase presenta una cadena que raíz en «Supabase Root 2021 CA»,
 * una CA propia que no está en el almacén del sistema —por eso validar contra las
 * CA del sistema fallaba con SELF_SIGNED_CERT_IN_CHAIN—. La CA pública vive en
 * `supabase/prod-ca-2021.crt`; se comprobó que su huella SHA-256 coincide con la
 * raíz que presenta el servidor en vivo (80:70:25:AD:…:CA:FA), así que no es un
 * certificado colado por el camino.
 *
 * La ruta se resuelve respecto a ESTE fichero, no al directorio de trabajo, para
 * que dé igual desde dónde se lance el script.
 */
const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");

export const sslDb = {
  rejectUnauthorized: true,
  ca: readFileSync(join(raiz, "supabase", "prod-ca-2021.crt"), "utf8"),
};
