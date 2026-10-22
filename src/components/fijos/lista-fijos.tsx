import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { shortDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import type { Category } from "@/lib/supabase/database.types";
import { PERIODICITY_LABELS, type Periodicity } from "@/lib/types";

/** Lo común a un gasto fijo y a un ingreso fijo para pintar su fila. */
export type FilaFija = {
  id: string;
  description: string;
  amount_cents: number;
  periodicity: Periodicity;
  /** El próximo cargo (gasto) o el próximo ingreso. */
  proxima: string;
  category_id: string | null;
  active: boolean;
  yearly_cents: number;
  due: boolean;
};

/**
 * La lista de un grupo de Fijos: una fila por gasto o ingreso fijo, con su
 * categoría, cada cuánto, lo que suma al año, cuándo toca y el importe.
 *
 * Los dos grupos usan la MISMA fila: lo único que cambia es el color del
 * importe (un ingreso va en el verde de ingreso), el icono cuando no hay
 * categoría y el diálogo de edición, que llega hecho desde la página porque
 * cada grupo tiene el suyo.
 */
export function ListaFijos<T extends FilaFija>({
  filas,
  tipo,
  categorias,
  editar,
}: {
  filas: T[];
  tipo: "gasto" | "ingreso";
  categorias: Map<string, Category>;
  /** El botón de editar de cada fila, con su diálogo. */
  editar: (fila: T) => React.ReactNode;
}) {
  return (
    <Card>
      <ul>
        {filas.map((fila) => {
          const categoria = fila.category_id ? categorias.get(fila.category_id) : null;
          return (
            <li
              key={fila.id}
              className="flex min-h-[60px] items-center gap-3 hair-t border-separator px-4 py-2 first:border-t-0 lg:px-5"
            >
              <span
                className={cn(
                  "flex size-[38px] shrink-0 items-center justify-center rounded-full",
                  !categoria && "bg-surface-2 text-muted",
                )}
                style={
                  categoria
                    ? {
                        background: `color-mix(in srgb, ${categoria.color} 14%, transparent)`,
                        color: categoria.color,
                      }
                    : undefined
                }
              >
                <Icon
                  name={categoria?.icon ?? (tipo === "gasto" ? "repeat" : "banknote")}
                  size={19}
                />
              </span>

              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-[6px]">
                  <span className="truncate text-[17px] leading-[22px] font-semibold lg:text-[15px]">
                    {fila.description}
                  </span>
                  {fila.due && fila.active ? (
                    <span className="shrink-0 rounded-xs bg-accent-soft px-[6px] py-[1px] text-[13px] leading-4 font-bold text-accent-text">
                      Toca
                    </span>
                  ) : null}
                </span>
                {/*
                  Se parte en dos líneas antes que truncar: con «…» a 390 px se
                  perdía justo lo que se busca aquí, cuánto suma al año y cuándo
                  toca. En los anuales el total del año es el propio importe, así
                  que no se repite.
                */}
                <span className="text-[13px] leading-[18px] text-pretty text-muted tabular-nums">
                  {PERIODICITY_LABELS[fila.periodicity]}
                  {fila.periodicity !== "ANUAL" ? ` · ${formatCents(fila.yearly_cents)} al año` : ""}
                  {fila.active ? ` · próximo ${shortDate(fila.proxima)}` : ""}
                </span>
              </span>

              <span
                className={cn(
                  "shrink-0 text-[17px] leading-[22px] font-semibold tabular-nums lg:text-[15px]",
                  tipo === "ingreso" && "text-income",
                )}
              >
                {formatCents(fila.amount_cents)}
              </span>

              {editar(fila)}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
