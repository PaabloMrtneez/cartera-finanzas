import { Card } from "@/components/ui/card";
import { todayIso } from "@/lib/dates";
import type { Account, Category, Transaction } from "@/lib/supabase/database.types";
import { agruparPorDia, CabeceraDia, FilaMovimiento } from "./fila-movimiento";

export type Enriched = Transaction & {
  category: Category | null;
  account: Account | null;
  toAccount: Account | null;
};

/**
 * Lista agrupada por día con subtotal, la vista de móvil de los «Últimos
 * movimientos» de Resumen. Componente de servidor: son unas pocas filas y no
 * crecen. (Movimientos usa `ListaMovimientos`, la de cliente, que sí crece.)
 */
export function TransactionList({ transactions }: { transactions: Enriched[] }) {
  const hoy = todayIso();

  return (
    /*
      UNA sola superficie para toda la lista, no una tarjeta por día.

      Con una tarjeta por día, un mes normal son treinta cajas flotando, y la
      caja no aporta nada: lo que agrupa los movimientos de un día es su
      cabecera, no un borde. Aquí la cabecera de día va DENTRO, con fondo propio,
      y hace de separador entre tramos igual que en un extracto impreso.
    */
    <Card className="lg:hidden">
      {agruparPorDia(transactions).map(([dia, items]) => (
        <section key={dia} className="hair-t border-hairline first:border-t-0">
          <CabeceraDia dia={dia} items={items} hoy={hoy} />
          <ul>
            {items.map((tx) => (
              <li key={tx.id}>
                <FilaMovimiento tx={tx} hoy={hoy} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Card>
  );
}
