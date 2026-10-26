"use client";

import { useId, useState } from "react";
import { Label } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/cn";

/** Lo que el formulario trae ya elegido al editar un préstamo. */
export type GastoInicial = {
  categoryId: string | null;
  entera: boolean;
};

const OPCIONES = [
  {
    valor: "intereses",
    titulo: "Solo los intereses",
    texto:
      "Si lo que pagaste con el préstamo ya está apuntado como gasto (el coche, la reforma). El capital solo baja la deuda: contarlo otra vez sería contarlo dos veces.",
  },
  {
    valor: "entera",
    titulo: "La cuota entera",
    texto:
      "Si no lo está. Cada cuota cuenta entera como gasto en su categoría: en el mes, en el reparto y en sus límites.",
  },
] as const;

/**
 * La categoría del préstamo y qué cuenta como gasto cada mes: solo los
 * intereses (por defecto) o la cuota entera. Los `name` son los de la server
 * action: `category_id` (vacío: «Intereses», que se crea sola) y
 * `cuenta_gasto` («intereses» | «entera»). Con la cuota entera la categoría es
 * obligatoria: la cuota de un coche no es «Intereses».
 */
export function GastoPrestamo({
  categorias,
  inicial,
}: {
  categorias: { id: string; name: string }[];
  inicial?: GastoInicial;
}) {
  const id = useId();
  const [categoria, setCategoria] = useState(inicial?.categoryId ?? "");
  const [entera, setEntera] = useState(inicial?.entera ?? false);
  const nombre = categorias.find((c) => c.id === categoria)?.name ?? null;

  return (
    <>
      <div className="flex flex-col gap-[6px]">
        <Label htmlFor={id}>Categoría</Label>
        <Select
          id={id}
          name="category_id"
          required={entera}
          placeholder={entera ? "Elige una categoría" : "Intereses"}
          value={categoria}
          onValueChange={setCategoria}
          aria-describedby={`${id}-ayuda`}
        >
          {categorias.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </Select>
        <p id={`${id}-ayuda`} className="text-[13px] leading-[18px] text-muted">
          {entera
            ? `La cuota entera cuenta en ${nombre ? `«${nombre}»` : "la categoría que elijas"}.`
            : `Los intereses y las comisiones van a ${nombre ? `«${nombre}»` : "«Intereses»"}.`}
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] leading-[18px] font-semibold text-muted">
          ¿Qué cuenta como gasto cada mes?
        </legend>
        {OPCIONES.map((o) => (
          <label
            key={o.valor}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md bg-surface-2 p-3",
              "ring-accent has-checked:ring-[1.5px]",
            )}
          >
            <input
              type="radio"
              name="cuenta_gasto"
              value={o.valor}
              checked={entera === (o.valor === "entera")}
              onChange={() => setEntera(o.valor === "entera")}
              className="mt-[2px] size-[18px] shrink-0 accent-accent"
            />
            <span className="flex flex-col gap-[2px]">
              <span className="text-[15px] leading-5 font-semibold">{o.titulo}</span>
              <span className="text-[13px] leading-[18px] text-muted">{o.texto}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </>
  );
}
