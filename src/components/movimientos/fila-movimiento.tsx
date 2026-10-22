import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { groupHeading, shortDate, whenLabel } from "@/lib/dates";
import { formatCents, formatSignedCents } from "@/lib/money";
import { TYPE_COLOR_VAR, type TransactionType } from "@/lib/types";

/**
 * La fila de un movimiento y la cabecera de su día, compartidas por la lista de
 * Resumen (componente de servidor) y la de Movimientos (de cliente, porque
 * crece con «Cargar más»). Este módulo NO lleva "use client" a propósito: sin
 * estado ni efectos, vale en los dos lados, y así hay una sola fila que
 * mantener.
 *
 * Lo que necesita de cada movimiento es lo justo para pintarlo. La lista de
 * Movimientos viaja al navegador como datos, y cada campo de más se paga
 * multiplicado por cientos de filas.
 */
export type MovimientoVista = {
  id: string;
  type: TransactionType;
  amount_cents: number;
  description: string | null;
  occurred_on: string;
  occurred_time: string;
  status: string;
  category: { name: string; color: string; icon: string } | null;
  account: { name: string } | null;
  toAccount: { name: string } | null;
};

/** El ancho de la columna del importe en la tabla de escritorio (fila y cabecera). */
export const ANCHO_IMPORTE = "lg:w-36 lg:min-w-fit";

/** Color e icono con que se pinta un movimiento según su categoría o su tipo. */
function aspecto(tx: MovimientoVista) {
  if (tx.category) return { color: tx.category.color, icon: tx.category.icon };
  if (tx.type === "TRANSFER") return { color: "var(--transfer)", icon: "arrow-left-right" };
  return { color: "var(--uncat)", icon: "circle-help" };
}

/** «Origen → destino» en un traspaso; la cuenta a secas en lo demás. */
function cuentaDe(tx: MovimientoVista): string {
  if (tx.type === "TRANSFER" && tx.toAccount) {
    return `${tx.account?.name ?? "—"} → ${tx.toAccount.name}`;
  }
  return tx.account?.name ?? "—";
}

function subtitulo(tx: MovimientoVista): string {
  if (tx.type === "TRANSFER" && tx.toAccount) return cuentaDe(tx);
  const partes = [tx.category?.name ?? "Sin categoría"];
  if (tx.account) partes.push(tx.account.name);
  return partes.join(" · ");
}

/**
 * El filete entre filas de la TABLA (escritorio), en el `<li>`. En la lista de
 * móvil las filas no llevan filete —lo que separa son las cabeceras de día—,
 * que es como se veían ya: el `first:border-t-0` que tenía el enlace se cumplía
 * siempre (el enlace es el primer hijo de su `<li>`) y no pintaba ninguno.
 */
export const LI_FILA_TABLA = "lg:hair-t lg:border-separator";

/** Los movimientos agrupados por día, en el orden en que llegan. */
export function agruparPorDia<T extends MovimientoVista>(txs: T[]): [string, T[]][] {
  const dias = new Map<string, T[]>();
  for (const tx of txs) {
    const lista = dias.get(tx.occurred_on);
    if (lista) lista.push(tx);
    else dias.set(tx.occurred_on, [tx]);
  }
  return [...dias.entries()];
}

/**
 * La cabecera de un día con su subtotal de gasto. Gasto bruto de lo cargado:
 * los traspasos no suman, porque mueven dinero pero no lo gastan.
 */
export function CabeceraDia({
  dia,
  items,
  hoy,
  className,
}: {
  dia: string;
  items: MovimientoVista[];
  hoy: string;
  className?: string;
}) {
  const subtotal = items.reduce(
    (suma, tx) => (tx.type === "EXPENSE" ? suma + tx.amount_cents : suma),
    0,
  );
  return (
    <div className={cn("flex items-baseline justify-between bg-surface-2 px-4 py-[7px]", className)}>
      <h2 className="text-[13px] leading-[18px] font-semibold tracking-[0.03em] text-muted uppercase">
        {groupHeading(dia, hoy)}
      </h2>
      {subtotal > 0 ? (
        <span className="text-[13px] leading-[18px] font-semibold text-muted tabular-nums">
          {formatCents(subtotal)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Una fila. Con `columnas`, la MISMA fila se abre en escritorio en las cinco
 * columnas de la tabla (descripción, categoría, cuenta, fecha, importe) con
 * variantes `lg:`; sin ellas es siempre la fila de la lista de móvil.
 *
 * Antes Movimientos pintaba una lista (móvil) y una tabla (escritorio) enteras,
 * una de las dos oculta: el doble de HTML y de nodos por cada movimiento. Con
 * 600 filas eran 3 MB de HTML y 18 600 nodos.
 *
 * `prefetch={false}`: un enlace por fila precargaba cada detalle al asomar en
 * pantalla, decenas de peticiones al servidor por vista para pantallas que casi
 * nunca se abren. El detalle se pide al tocarlo.
 */
export function FilaMovimiento({
  tx,
  hoy,
  columnas = false,
}: {
  tx: MovimientoVista;
  hoy: string;
  columnas?: boolean;
}) {
  const { color, icon } = aspecto(tx);
  const importe = formatSignedCents(tx.amount_cents, tx.type);

  return (
    <Link
      href={`/movimientos/${tx.id}`}
      prefetch={false}
      className={cn(
        "fila-pulsable flex min-h-[60px] items-center gap-3 px-4 py-[9px] text-fg",
        columnas && "lg:min-h-12 lg:px-[18px] lg:py-[6px]",
      )}
    >
      <span
        className={cn(
          "flex size-[38px] shrink-0 items-center justify-center rounded-full tint-14",
          columnas && "lg:size-[30px]",
        )}
        style={{ color }}
      >
        <Icon name={icon} size={19} className={columnas ? "lg:size-4" : undefined} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-[6px]">
          <span
            className={cn(
              "truncate text-[17px] leading-[22px] font-semibold",
              columnas && "lg:text-[15px] lg:leading-5",
            )}
          >
            {tx.description || "Sin descripción"}
          </span>
          {tx.status === "PENDING" ? (
            <span className="shrink-0 rounded-xs bg-accent-soft px-[7px] py-[2px] text-[13px] leading-4 font-bold text-accent-text">
              Pendiente
            </span>
          ) : null}
        </span>
        <span
          className={cn("truncate text-[13px] leading-[18px] text-muted", columnas && "lg:hidden")}
        >
          {subtitulo(tx)} · {whenLabel(tx.occurred_on, tx.occurred_time, hoy)}
        </span>
      </span>

      {columnas ? (
        <>
          <span
            className={cn(
              "hidden w-40 truncate text-[14px] lg:block",
              tx.category ? "text-fg" : "text-uncat",
            )}
          >
            {tx.category?.name ?? "Sin categoría"}
          </span>
          <span className="hidden w-36 truncate text-[14px] text-muted lg:block">{cuentaDe(tx)}</span>
          <span className="hidden w-24 text-[14px] text-muted tabular-nums lg:block">
            {shortDate(tx.occurred_on)}
          </span>
        </>
      ) : null}

      {/*
        El importe no se encoge nunca. En la tabla, además, la columna cabe
        «+9.999.999,99 €» (antes medía 112 px y un importe de ocho cifras se
        salía hasta el canto), y si algo más largo no cupiera, crece en vez de
        desbordar (`min-w-fit`). El mismo ancho que la cabecera de la tabla
        (`ANCHO_IMPORTE`), para que las columnas casen.
      */}
      <span
        className={cn(
          "shrink-0 text-right text-[17px] leading-[22px] font-semibold whitespace-nowrap tabular-nums",
          columnas && `lg:text-[15px] lg:leading-5 ${ANCHO_IMPORTE}`,
        )}
        style={{ color: TYPE_COLOR_VAR[tx.type] }}
      >
        {importe}
      </span>
    </Link>
  );
}
