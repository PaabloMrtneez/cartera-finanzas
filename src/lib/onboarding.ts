import type { IconName } from "@/components/ui/icon";

/**
 * Las categorías que se ofrecen en el primer arranque.
 *
 * La app arranca vacía a propósito, así que esto es una oferta, no un
 * sembrado: quien quiera las suyas las crea y ya está. Pero empezar con la
 * pantalla en blanco hace que el primer gasto no se pueda clasificar, y un
 * gasto sin clasificar no consume límite ni aparece en el reparto.
 *
 * Vive en el servidor y el navegador solo manda QUÉ claves ha elegido, nunca
 * el nombre ni el color. Así nadie puede colar una categoría a medida por el
 * camino del arranque.
 */
export type CategoriaSugerida = {
  clave: string;
  name: string;
  type: "EXPENSE" | "INCOME";
  color: string;
  icon: IconName;
};

export const CATEGORIAS_SUGERIDAS: CategoriaSugerida[] = [
  { clave: "super", name: "Supermercado", type: "EXPENSE", color: "#2f8f4e", icon: "shopping-cart" },
  { clave: "restaurantes", name: "Restaurantes", type: "EXPENSE", color: "#c96a1e", icon: "utensils" },
  { clave: "transporte", name: "Transporte", type: "EXPENSE", color: "#1f7fa8", icon: "bus" },
  { clave: "casa", name: "Casa", type: "EXPENSE", color: "#8a5a12", icon: "house" },
  { clave: "suministros", name: "Suministros", type: "EXPENSE", color: "#7a6a2e", icon: "lightbulb" },
  { clave: "ocio", name: "Ocio", type: "EXPENSE", color: "#6d4bc4", icon: "film" },
  { clave: "salud", name: "Salud", type: "EXPENSE", color: "#b03060", icon: "heart-pulse" },
  { clave: "compras", name: "Compras", type: "EXPENSE", color: "#8b3fbf", icon: "shopping-bag" },
  { clave: "nomina", name: "Nómina", type: "INCOME", color: "#0e7352", icon: "banknote" },
];

export function esClaveSugerida(clave: string): boolean {
  return CATEGORIAS_SUGERIDAS.some((c) => c.clave === clave);
}
