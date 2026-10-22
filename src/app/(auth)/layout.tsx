import { BrandMark } from "@/components/brand-mark";

/**
 * La puerta de la app. Primer y único momento de marca: el monograma Aurora con
 * un halo iridiscente sobre el fondo espacio, el logotipo y el formulario dentro
 * de una tarjeta de cristal que flota de verdad (es de las pocas cosas que lo
 * merecen). El resto de pantallas de acceso —2FA, invitación— heredan este marco
 * sin repetirlo.
 *
 * Entra en cascada con `animate-rise`, que con movimiento reducido degrada a un
 * fundido sin recorrido.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-[380px] flex-col gap-7">
        <header className="flex animate-rise flex-col items-center gap-4 text-center">
          <span className="relative flex items-center justify-center">
            {/* El halo: el espectro Aurora desenfocado tras el monograma. Es un
                token (`--grad-aurora`), no un color inventado. */}
            <span
              aria-hidden
              className="pointer-events-none absolute size-[104px] rounded-full opacity-45 blur-2xl"
              style={{ background: "var(--grad-aurora)" }}
            />
            <BrandMark size={64} className="relative" />
          </span>
          <div className="flex flex-col items-center gap-1.5">
            <h1 className="font-cifra text-[32px] leading-none font-semibold tracking-[-0.02em]">
              Cartera
            </h1>
            <p className="text-[14px] leading-5 text-muted">
              Tus finanzas, privadas y en un solo sitio.
            </p>
          </div>
        </header>

        <div
          className="glass-card animate-rise rounded-lg p-5 lg:p-6"
          style={{ animationDelay: "80ms" }}
        >
          {children}
        </div>
      </div>
    </main>
  );
}
