import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SUBSECTIONS } from "@/lib/nav";

/**
 * Los accesos a las pantallas que cuelgan de esta pestaña.
 *
 * Solo en móvil (`lg:hidden`): en escritorio esas pantallas están en la barra
 * lateral como entradas de primer nivel, y repetirlas aquí sería ruido. Pero en
 * móvil no hay barra lateral, así que esto ES la única forma de llegar.
 *
 * Se pinta desde `SUBSECTIONS`, la misma lista de la que sale el resaltado de la
 * pestaña. Así no puede volver a pasar que una pantalla ilumine su pestaña madre
 * y no tenga ningún enlace que lleve hasta ella.
 */
export function SubNav({ parent }: { parent: string }) {
  const hijas = SUBSECTIONS[parent] ?? [];
  if (hijas.length === 0) return null;

  return (
    <Card className="lg:hidden">
      <ul>
        {hijas.map((hija) => (
          <li key={hija.href}>
            <Link
              href={hija.href}
              className="fila-pulsable flex min-h-[60px] items-center gap-3 hair-t border-separator px-4 py-2 text-fg first:border-t-0"
            >
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                <Icon name={hija.icon} size={16} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[17px] leading-[22px] font-semibold">{hija.label}</span>
                {hija.hint ? (
                  <span className="truncate text-[13px] leading-[18px] text-muted">
                    {hija.hint}
                  </span>
                ) : null}
              </span>
              <Icon name="chevron-right" size={18} />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
