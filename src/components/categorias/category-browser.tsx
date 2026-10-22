"use client";

import { useState } from "react";
import { CategoryDialog } from "@/components/categorias/category-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import type { Category } from "@/lib/supabase/database.types";
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type TransactionType } from "@/lib/types";

/** Lo que cada grupo ES, no cómo se usa: por eso vive aquí y no en una ayuda flotante. */
const GROUP_HINT: Record<TransactionType, string> = {
  EXPENSE: "Dónde se va el dinero. Es lo que reparte la banda del resumen.",
  INCOME: "De dónde viene. Un ingreso que reembolsa un gasto no cuenta aquí.",
  TRANSFER:
    "Solo etiquetas: dicen por qué moviste el dinero. No convierten el traspaso en gasto.",
};

/** El segmento activo se tiñe con el color semántico del tipo, como en el alta. */
const SEG_COLOR: Record<TransactionType, string> = {
  EXPENSE: "var(--expense)",
  INCOME: "var(--income)",
  TRANSFER: "var(--transfer)",
};

/**
 * Categorías, un tipo cada vez.
 *
 * En vez de las tres listas enfrentadas en columnas —que en escritorio obligaban
 * a barrer tres sitios y en móvil eran un rollo largo—, un segmentado elige el
 * tipo y debajo va UNA lista agrupada, al estilo de los Ajustes de iOS. La misma
 * maqueta sirve en móvil y en escritorio: se estrecha y se centra, porque una
 * lista de ajustes no se lee mejor por ser más ancha.
 *
 * La fila entera es el disparador de la edición —no un lapicero diminuto—: se
 * toca donde se mira. «Sin categoría» es la excepción: no es una fila de la base
 * de datos sino la ausencia de una, así que ni se edita ni se borra, y lo dice su
 * candado.
 */
export function CategoryBrowser({ groups }: { groups: Record<TransactionType, Category[]> }) {
  const [tipo, setTipo] = useState<TransactionType>("EXPENSE");
  const categorias = groups[tipo];

  return (
    <div className="mx-auto flex w-full max-w-[600px] flex-col gap-4">
      <Segmented
        value={tipo}
        onChange={setTipo}
        label="Tipo de categoría"
        options={TRANSACTION_TYPES.map((t) => ({
          value: t,
          label: TRANSACTION_TYPE_LABELS[t],
          color: SEG_COLOR[t],
        }))}
      />

      <p className="px-1 text-[13px] leading-[18px] text-muted">{GROUP_HINT[tipo]}</p>

      <Card>
        <ul>
          {categorias.map((category) => (
            <li key={category.id}>
              <CategoryDialog
                category={category}
                type={tipo}
                trigger={
                  <button
                    type="button"
                    aria-label={`Editar ${category.name}`}
                    className={cn(
                      "fila-pulsable flex min-h-[56px] w-full items-center gap-3 px-4 text-left",
                      "hair-t border-separator first:border-t-0",
                      "transition-colors duration-150 ease-ui hover:bg-surface-2",
                    )}
                  >
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-[11px]"
                      style={{
                        background: `color-mix(in srgb, ${category.color} 16%, transparent)`,
                        color: category.color,
                      }}
                    >
                      <Icon name={category.icon} size={18} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[16px] leading-[22px] font-semibold">
                      {category.name}
                    </span>
                    <Icon name="chevron-right" size={18} className="shrink-0 text-muted" />
                  </button>
                }
              />
            </li>
          ))}

          {/*
            «Sin categoría» no es una fila de la base de datos: es la ausencia de
            una. Un movimiento sin clasificar simplemente no apunta a ninguna. Se
            pinta aquí, con su candado, porque forma parte del modelo mental de la
            persona, pero por eso mismo es imposible borrarla o renombrarla.
          */}
          <li className="flex min-h-[56px] items-center gap-3 hair-t border-separator px-4 first:border-t-0">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-surface-2 text-uncat">
              <Icon name="circle-help" size={18} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[16px] leading-[22px] font-semibold text-muted">
              Sin categoría
            </span>
            <span className="flex size-[34px] shrink-0 items-center justify-center text-muted">
              <Icon name="lock" size={16} />
              {/* El `title` no llega al lector de pantalla en un móvil. */}
              <span className="sr-only">Siempre existe y no se puede borrar</span>
            </span>
          </li>
        </ul>

        <div className="hair-t border-separator p-2">
          <CategoryDialog
            type={tipo}
            trigger={
              <Button variant="ghost" size="compact" className="w-full justify-start text-accent-text">
                <Icon name="plus" size={15} />
                Nueva categoría de {TRANSACTION_TYPE_LABELS[tipo].toLowerCase()}
              </Button>
            }
          />
        </div>
      </Card>
    </div>
  );
}
