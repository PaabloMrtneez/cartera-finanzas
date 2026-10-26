import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { DeleteTransactionButton } from "@/components/movimientos/delete-transaction-button";
import { TransactionForm } from "@/components/movimientos/transaction-form";
import { CategoryContext } from "@/components/movimientos/category-context";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { longDate, monthLabel } from "@/lib/dates";
import { formatCents, formatSignedCents } from "@/lib/money";
import { origenMovimientoPrestamo } from "@/lib/prestamos-vista";
import { createClient } from "@/lib/supabase/server";
import { TRANSACTION_TYPE_LABELS, TYPE_COLOR_VAR } from "@/lib/types";

export const metadata = { title: "Movimiento" };

export default async function DetalleMovimientoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Dos tandas en paralelo en lugar de tres seguidas. Lo que no depende del
  // movimiento sale ya, A LA VEZ que el propio movimiento; lo que depende de él
  // (el gasto enlazado, el préstamo, el contexto de la categoría), en una
  // segunda tanda conjunta. Los constructores de PostgREST no consultan hasta
  // que alguien los espera: `Promise.all` es lo que los lanza.
  const independientes = Promise.all([
    supabase.from("account").select("*").order("name"),
    supabase.from("category").select("*").order("name"),
    // Ingresos que reembolsan este gasto: es lo que lo abarata.
    supabase.from("transaction").select("*").eq("reimburses_id", id),
    // Para poder cambiar a qué posición fue un traspaso a inversión, y saber
    // si sigue un instrumento (entonces se piden participaciones).
    supabase
      .from("v_position_value")
      .select("position_id, name, account_id, instrument_id")
      .eq("archived", false)
      .order("name"),
  ]);

  const { data: tx } = await supabase
    .from("transaction")
    // Las participaciones, además, como TEXTO: numeric llega como doble y
    // aquí se enseñan y se reenvían tal cual, sin pasar por coma flotante.
    .select("*, unidades_texto:position_units::text")
    .eq("id", id)
    .maybeSingle();
  if (!tx) notFound();

  const [
    [{ data: accounts }, { data: categories }, { data: reimbursements }, { data: posiciones }],
    { data: enlazado },
    { data: prestamo },
    { data: contexto },
  ] = await Promise.all([
    independientes,
    // Si esto es un ingreso enlazado, el gasto al que apunta.
    tx.reimburses_id
      ? supabase
          .from("transaction")
          .select("id, description, amount_cents, occurred_on, merchant_raw")
          .eq("id", tx.reimburses_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Si es parte de un préstamo, de cuál: el detalle lo dice («Cuota 3 de 60
    // del préstamo Coche») en vez de «Generado por un gasto fijo».
    tx.loan_id
      ? supabase
          .from("loan")
          .select("id, name, term_months, interest_category_id, counts_full_installment")
          .eq("id", tx.loan_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Contexto: qué peso tiene este gasto dentro de su categoría, y cómo van
    // los seis meses. Solo en gastos: un traspaso no pesa en ninguna
    // categoría, y un ingreso enlazado ya se explica con el gasto que abarata.
    tx.type === "EXPENSE"
      ? supabase.rpc("category_context", {
          p_category: tx.category_id,
          p_month: tx.period_month,
          p_months: 6,
        })
      : Promise.resolve({ data: null }),
  ]);

  // El capital de un préstamo que cuenta la cuota entera es un traspaso, pero
  // cuenta como gasto en la categoría DEL PRÉSTAMO (v_transaction_econ).
  const cuentaComoGasto =
    tx.type === "TRANSFER" &&
    (tx.loan_part === "CAPITAL" || tx.loan_part === "LIQUIDACION") &&
    prestamo?.counts_full_installment === true;
  const categoryId = cuentaComoGasto ? (prestamo?.interest_category_id ?? null) : tx.category_id;
  const category = categories?.find((c) => c.id === categoryId) ?? null;
  const account = accounts?.find((a) => a.id === tx.account_id) ?? null;
  const toAccount = accounts?.find((a) => a.id === tx.to_account_id) ?? null;

  const refunded = (reimbursements ?? []).reduce((sum, r) => sum + r.amount_cents, 0);
  const net = tx.amount_cents - refunded;

  return (
    <>
      <PageHeader
        title="Movimiento"
        subtitle={longDate(tx.occurred_on)}
        actions={
          <DeleteTransactionButton
            id={tx.id}
            reimbursements={reimbursements?.length ?? 0}
            reimbursesDescription={enlazado?.description ?? null}
          />
        }
      />

      {/*
        Dos columnas en escritorio: los datos a la izquierda, el formulario a la
        derecha y pegado.

        A 840 px en una sola columna, para cambiarle la categoría a un
        movimiento había que bajar por delante del importe, del origen y de la
        gráfica de contexto. Y el contexto es justo lo que quieres estar mirando
        MIENTRAS decides la categoría, no algo por lo que pasar de largo.

        La rejilla coloca por filas, así que las columnas se dicen a mano: el
        orden del DOM sigue siendo el de móvil.

        Y las FILAS también. El formulario mide unos 960 px: si ocupara solo la
        fila 1, esa fila mediría eso entero y la columna izquierda pondría el
        importe arriba y todo lo demás (origen, contexto) DEBAJO del formulario,
        con un hueco del alto de la pantalla en medio. Por eso el formulario
        abarca todas las filas, y la última es elástica (1fr): ahí va a parar lo
        que le sobra de alto, y la columna izquierda queda apretada arriba.
        Cuatro filas de contenido a la izquierda —importe, origen, contexto y
        volver— más la elástica.
      */}
      <PageBody className="lg:grid lg:max-w-[1240px] lg:grid-cols-[minmax(0,1fr)_440px] lg:grid-rows-[auto_auto_auto_auto_1fr] lg:items-start">
        {/* El importe manda, sin caja alrededor: es el titular de la pantalla. */}
        <div className="flex animate-rise flex-col gap-1 lg:col-start-1 lg:row-start-1">
          <p className="cifra-hero" style={{ color: TYPE_COLOR_VAR[tx.type] }}>
            {formatSignedCents(tx.amount_cents, tx.type)}
          </p>
          <p className="text-[19px] leading-6 font-semibold break-words">
            {tx.description || "Sin descripción"}
          </p>
          <p className="text-[14px] leading-5 text-muted">
            {TRANSACTION_TYPE_LABELS[tx.type]}
            {" · "}
            {tx.type === "TRANSFER" && toAccount
              ? `${account?.name ?? "—"} → ${toAccount.name}`
              : (account?.name ?? "—")}
            {" · "}
            {category?.name ?? "Sin categoría"}
            {cuentaComoGasto ? " · cuenta como gasto" : null}
          </p>

          {refunded > 0 ? (
            <div className="mt-4 flex flex-col gap-1 rounded-md hair border-hairline bg-surface-2 p-3">
              <Eyebrow>Te costó de verdad</Eyebrow>
              <p className="cifra text-[26px] leading-8">{formatCents(net)}</p>
              <p className="text-[13px] leading-[18px] text-muted">
                Pagaste {formatCents(tx.amount_cents)} y te devolvieron {formatCents(refunded)}.
              </p>
            </div>
          ) : null}
        </div>

        {/* Origen: de dónde salió este apunte. */}
        <Card className="flex flex-col lg:col-start-1">
          <div className="px-[18px] pt-4 pb-[10px]">
            <Eyebrow>Origen</Eyebrow>
          </div>
          {[
            [
              "Registro",
              tx.loan_part
                ? origenMovimientoPrestamo({
                    parte: tx.loan_part,
                    periodo: tx.loan_period,
                    plazo: prestamo?.term_months ?? null,
                    nombre: prestamo?.name ?? "",
                  })
                : tx.source === "SHORTCUT"
                ? "Automático, desde el Atajo del iPhone"
                : tx.source === "RECURRING"
                  ? tx.type === "INCOME"
                    ? "Generado por un ingreso fijo"
                    : "Generado por un gasto fijo"
                  : tx.source === "IMPORT"
                    ? "Importado de un extracto del banco"
                    : "A mano",
            ],
            ...(tx.merchant_raw ? [["Comercio", tx.merchant_raw]] : []),
            ...(tx.card_last4 ? [["Tarjeta", `···${tx.card_last4}`]] : []),
            ["Estado", tx.status === "PENDING" ? "Pendiente de confirmar" : "Confirmado"],
            ...(tx.note ? [["Nota", tx.note]] : []),
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex min-h-12 items-center gap-3 hair-t border-separator px-[18px] py-2"
            >
              <span className="flex-1 text-[15px] leading-5 text-muted">{label}</span>
              {/* Partido en líneas y no cortado: la nota llega a 500 caracteres y
                  el comercio en bruto puede ser un código largo; con `truncate`
                  no había forma de leerlos enteros. */}
              <span className="max-w-[60%] text-right text-[15px] leading-5 font-semibold break-words">
                {value}
              </span>
            </div>
          ))}
          {tx.loan_id ? (
            <Link
              href={`/prestamos#prestamo-${tx.loan_id}`}
              className="fila-pulsable flex min-h-12 items-center gap-3 hair-t border-separator px-[18px] py-2 text-[15px] leading-5 font-semibold text-accent-text"
            >
              <span className="flex-1">Ver el préstamo</span>
              <Icon name="chevron-right" size={16} />
            </Link>
          ) : null}
        </Card>

        {/*
          Dos columnas sí, pegajoso NO. El formulario mide 962 px y una ventana
          de portátil son 900: anclado arriba se quedaba con el botón de guardar
          fuera de alcance, sin forma de llegar a él. Que se desplace con la
          página.
        */}
        <Card className="p-4 lg:col-start-2 lg:row-span-5 lg:row-start-1 lg:p-6">
          <div className="mb-4 flex items-center gap-2">
            <Icon name="pencil" size={16} />
            <h2 className="text-[16px] leading-[22px] font-semibold">Editar</h2>
          </div>
          <TransactionForm
            transaction={tx}
            accounts={accounts ?? []}
            categories={categories ?? []}
            reimbursed={enlazado ?? null}
            positions={posiciones ?? []}
            unidadesTexto={tx.unidades_texto}
            prestamo={tx.loan_id ? (prestamo?.name ?? "") : null}
          />
        </Card>

        {/* Mismo criterio que el gráfico: sin gasto este mes no pinta nada, y la
            tarjeta se quedaba con solo el título. */}
        {contexto && contexto.length > 0 && (contexto[contexto.length - 1]?.cents ?? 0) > 0 ? (
          <Card className="lg:col-start-1">
            <CardHeader title={`${category?.name ?? "Sin categoría"}, 6 meses`} />
            <CategoryContext
              meses={contexto}
              categoria={category?.name ?? "Sin categoría"}
              categoriaId={tx.category_id}
              mes={monthLabel(tx.period_month)}
              importe={tx.amount_cents}
            />
          </Card>
        ) : null}

        <p className="px-1 text-[13px] leading-[18px] text-muted lg:col-start-1">
          <Link href="/movimientos" className="font-semibold text-accent-text">
            Volver a Movimientos
          </Link>
        </p>
      </PageBody>
    </>
  );
}
