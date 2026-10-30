import Link from "next/link";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Icon } from "@/components/ui/icon";

/**
 * La cabecera de Ajustes: quién eres, cómo entras y la salida.
 *
 * La tira de abajo es solo de escritorio y es lo que queda de «Organización». En
 * móvil esos sitios ya están en los accesos de debajo; en escritorio, Reglas de
 * comercio no está en la barra lateral y esta es su única puerta.
 */
export function LosaCuenta({
  email,
  conDosPasos,
  accesos,
}: {
  email: string;
  conDosPasos: boolean;
  accesos: { href: string; label: string; count: number }[];
}) {
  return (
    <section
      aria-label="Tu cuenta"
      className="overflow-hidden rounded-lg hair border-hairline losa-aurora"
    >
      {/* En móvil el botón baja a su renglón: al lado, el correo se quedaba cortado. */}
      <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:gap-4 lg:px-6 lg:py-5">
        <div className="flex min-w-0 flex-1 items-center gap-3 lg:gap-4">
          {/* El canto del espectro, como el de las acciones principales. */}
          <span
            aria-hidden
            className="shrink-0 rounded-full p-[1.5px]"
            style={{ background: "var(--grad-aurora)" }}
          >
            <span className="flex size-11 items-center justify-center rounded-full bg-surface cifra text-[20px] font-semibold uppercase lg:size-12">
              {email.charAt(0)}
            </span>
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] leading-5 font-semibold lg:text-[17px] lg:leading-[22px]">
              {email}
            </span>
            <span className="text-[13px] leading-[18px] text-muted">
              {conDosPasos ? "Con verificación en dos pasos" : "Solo con contraseña"}
            </span>
          </span>
        </div>
        <SignOutButton className="w-full lg:w-auto" />
      </div>

      <div className="hidden hair-t border-hairline lg:grid lg:grid-cols-3">
        {accesos.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="fila-pulsable flex items-center gap-3 hair-l border-hairline px-6 py-3 text-fg first:border-l-0 hover:bg-surface-2"
          >
            <span className="flex-1 text-[14px] leading-5 text-muted">{a.label}</span>
            <span className="cifra text-[20px] leading-7 font-semibold">{a.count}</span>
            <Icon name="chevron-right" size={18} />
          </Link>
        ))}
      </div>
    </section>
  );
}
