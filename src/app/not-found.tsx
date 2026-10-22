import { BrandMark } from "@/components/brand-mark";
import { ButtonLink } from "@/components/ui/button";

export const metadata = { title: "No encontrada" };

/**
 * La página que no existe.
 *
 * Antes no había ninguna y salía la de serie de Next: «404 · This page could not
 * be found.», en inglés y en tinta NEGRA sobre el fondo espacio, es decir, casi
 * invisible en el tema oscuro, que es el de por defecto. Ahora es el mismo marco
 * sereno que la página sin conexión: la marca con su halo, qué ha pasado y una
 * salida.
 *
 * Solo la ve quien ya ha entrado: sin sesión, el proxy manda cualquier ruta
 * desconocida a /entrar. También la usa el detalle de un movimiento que ya no
 * existe (`notFound()`), por ejemplo uno borrado desde otro dispositivo.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <span className="relative mb-1 flex items-center justify-center">
        <span
          aria-hidden
          className="pointer-events-none absolute size-[104px] rounded-full opacity-40 blur-2xl"
          style={{ background: "var(--grad-aurora)" }}
        />
        <BrandMark size={60} className="relative" />
      </span>
      <h1 className="text-[22px] leading-7 font-semibold text-balance">
        Esta página no existe
      </h1>
      <p className="max-w-sm text-[15px] leading-5 text-pretty text-muted">
        Puede que el enlace esté mal escrito o que lo que buscabas, un movimiento por ejemplo, se
        haya borrado. Tus datos siguen donde estaban.
      </p>
      <ButtonLink href="/resumen" className="mt-2">
        Ir al Resumen
      </ButtonLink>
    </main>
  );
}
