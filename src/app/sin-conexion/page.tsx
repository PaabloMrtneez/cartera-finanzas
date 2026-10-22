import { BrandMark } from "@/components/brand-mark";
import { ButtonLink } from "@/components/ui/button";

export const metadata = { title: "Sin conexión" };

export default function SinConexionPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="relative mb-1 flex items-center justify-center">
        <span
          aria-hidden
          className="pointer-events-none absolute size-[104px] rounded-full opacity-40 blur-2xl"
          style={{ background: "var(--grad-aurora)" }}
        />
        <BrandMark size={60} className="relative" />
      </span>
      <h1 className="text-[22px] leading-7 font-semibold">No hay conexión</h1>
      <p className="max-w-sm text-[15px] leading-5 text-muted">
        Cartera guarda todo en el servidor a propósito, así que necesita conexión para enseñarte tus
        cifras. Cuando vuelvas a tener cobertura, reinténtalo.
      </p>
      {/*
        Un enlace y no un botón con JavaScript: esta página se sirve desde la
        caché del service worker cuando no hay red, y puede que los scripts de la
        app no estén guardados. `ButtonLink` pinta un <a href> de verdad, que
        navega aunque no hidrate. Antes no había ninguna salida y el texto
        prometía que «se abre sola», cosa que nada hacía.
      */}
      <ButtonLink href="/resumen" prefetch={false} className="mt-2 px-6">
        Reintentar
      </ButtonLink>
    </main>
  );
}
