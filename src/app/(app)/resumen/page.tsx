import Link from "next/link";
import { Fragment } from "react";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { MonthNav } from "@/components/movimientos/month-nav";
import { SubNav } from "@/components/app/sub-nav";
import { AnillosLimites } from "@/components/resumen/anillos-limites";
import { BandaCategorias } from "@/components/resumen/banda-categorias";
import { CategoryComparison } from "@/components/resumen/category-comparison";
import { CifraContada, RegistroRecienteProvider } from "@/components/resumen/cifra-contada";
import { MonthsBars } from "@/components/resumen/months-bars";
import { PaceChart } from "@/components/resumen/pace-chart";
import { DIAS_MINIMOS, PrevisionMes } from "@/components/resumen/prevision";
import {
  TransactionList,
  type Enriched,
} from "@/components/movimientos/transaction-views";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { monthLabel, monthStart, shiftMonth, todayIso } from "@/lib/dates";
import {
  formatCents,
  formatCentsRounded,
  formatShare,
  formatSignedCents,
  percentChange,
} from "@/lib/money";
import { TYPE_COLOR_VAR } from "@/lib/types";
import { contarPendientes } from "@/lib/supabase/consultas-compartidas";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/cn";

export const metadata = { title: "Resumen" };

export default async function ResumenPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const { mes } = await searchParams;
  // El mes vive en la dirección: así el botón de atrás recupera el mes anterior
  // y un enlace compartido abre el mismo periodo. Un valor inventado no rompe
  // nada, cae al mes en curso.
  const month =
    mes && /^\d{4}-\d{2}-\d{2}$/.test(mes)
      ? monthStart(mes)
      : monthStart(todayIso());
  // La previsión solo se pinta en el mes en curso: la de un mes ya cerrado es su
  // propio total y no aporta nada.
  const esMesActual = month === monthStart(todayIso());
  const supabase = await createClient();

  const [
    { data: summaries },
    { data: breakdown },
    { data: ritmo },
    { data: comparativa },
    { data: recent },
    { data: categories },
    { data: accounts },
    { count: pending },
    { count: sinClasificarTotal },
    { data: prevision },
    { data: categoriasPrevision },
    { data: ingresoPendiente },
    { data: limites },
  ] = await Promise.all([
    supabase
      .from("v_month_summary")
      .select("*")
      // Los 13 meses que acaban en el elegido (el gráfico y el mes anterior).
      // Con el filtro, la base agrega solo esos meses por el índice
      // tx_user_month_idx, no todo el histórico (B4); y un mes antiguo ya no
      // se queda fuera de «los 13 más recientes».
      .lte("period_month", month)
      .gte("period_month", shiftMonth(month, -12))
      .order("period_month", { ascending: false })
      .limit(13),
    supabase.rpc("category_breakdown", { p_month: month }),
    supabase.rpc("month_pace", { p_month: month }),
    supabase.rpc("category_comparison", { p_month: month }),
    supabase
      .from("transaction")
      .select("*")
      .neq("status", "DISCARDED")
      .order("occurred_on", { ascending: false })
      .order("occurred_time", { ascending: false })
      .limit(5),
    supabase.from("category").select("*"),
    supabase.from("account").select("*"),
    // La misma cuenta que hace el armazón para la insignia: memorizada, no se
    // repite la consulta en la misma petición.
    contarPendientes().then((count) => ({ count })),
    // Sin clasificar de TODO el histórico, no solo del mes que se está viendo.
    // Un gasto sin categoría no consume límite ni entra en el reparto: si el de
    // marzo no se vuelve a mencionar, el análisis de marzo queda mal para
    // siempre y nada lo dice.
    supabase
      .from("transaction")
      .select("*", { count: "exact", head: true })
      .eq("type", "EXPENSE")
      .neq("status", "DISCARDED")
      .is("category_id", null),
    // Previsión de fin de mes: gasto y límites en riesgo. Solo se PINTA en el
    // mes en curso (la de un mes cerrado es su total), pero se pide siempre en
    // el mismo lote para no encadenar otra ida y vuelta.
    supabase.rpc("month_forecast", { p_month: month }),
    supabase.rpc("category_forecast", { p_month: month }),
    // Ingresos recurrentes que faltan este mes, para el balance previsto.
    supabase.rpc("pending_recurring_income", { p_month: month }),
    // Los límites del mes, para los anillos.
    supabase.rpc("budget_status", { p_month: month }),
  ]);

  const current = summaries?.find((s) => s.period_month === month);
  const previous = summaries?.find(
    (s) => s.period_month === shiftMonth(month, -1),
  );

  const netExpense = current?.net_expense_cents ?? 0;
  const income = current?.income_cents ?? 0;
  const balance = current?.month_balance_cents ?? 0;
  const gross = current?.gross_expense_cents ?? 0;
  const refunded = current?.reimbursed_cents ?? 0;
  // Del mes, solo para poder desglosarlo dentro del aviso.
  const sinClasificarDelMes = current?.unclassified_count ?? 0;
  const sinClasificar = sinClasificarTotal ?? 0;

  const delta = previous
    ? percentChange(netExpense, previous.net_expense_cents)
    : null;

  // La previsión para la tira de totales: solo si hay base para extrapolar (mismo
  // umbral que la tarjeta de previsión). Fuera de eso, la columna muestra «—».
  const previsionData = esMesActual ? (prevision?.[0] ?? null) : null;
  const previsionStripCents =
    previsionData && previsionData.dias_transcurridos >= DIAS_MINIMOS
      ? previsionData.prevision_cents
      : null;

  /*
    Cuánto miden las tres cifras de la tira, en caracteres. Con eso la tira
    encoge sus cifras para caber (`cifra-tira`, en globals.css) y, si ni así
    caben a un cuerpo legible —importes de siete u ocho cifras en un móvil
    estrecho (hallazgo M-1)—, pasa a filas: rótulo a la izquierda y cifra a la
    derecha. En escritorio siempre cabe en columnas.
  */
  const textoPrevision =
    previsionStripCents !== null ? `≈ ${formatCentsRounded(previsionStripCents)}` : "—";
  const caracteresTira =
    formatCents(income).length + formatCents(balance).length + 1 + textoPrevision.length;
  const tiraEnFilas = caracteresTira > 36;

  const byCategory = new Map((categories ?? []).map((c) => [c.id, c]));
  const byAccount = new Map((accounts ?? []).map((a) => [a.id, a]));
  const lastMovements: Enriched[] = (recent ?? []).map((tx) => ({
    ...tx,
    category: tx.category_id ? (byCategory.get(tx.category_id) ?? null) : null,
    account: byAccount.get(tx.account_id) ?? null,
    toAccount: tx.to_account_id
      ? (byAccount.get(tx.to_account_id) ?? null)
      : null,
  }));

  // Los doce últimos meses en orden cronológico (el gráfico enseña 6 o 12).
  // `summaries` viene del más reciente al más antiguo, y una gráfica de tiempo
  // se lee al contrario.
  const ultimosMeses = (summaries ?? [])
    .filter((s) => s.period_month <= month)
    .slice(0, 12)
    .reverse()
    .map((s) => ({
      period_month: s.period_month,
      income_cents: s.income_cents,
      net_expense_cents: s.net_expense_cents,
    }));

  const hasData = (recent?.length ?? 0) > 0;

  return (
    <>
      <PageHeader
        title="Resumen"
        actions={
          <MonthNav
            month={month}
            all={false}
            max={monthStart(todayIso())}
            permiteTodo={false}
          />
        }
      />

      <PageBody>
        {!hasData ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="chart-pie" size={26} />
            </span>
            <h2 className="text-[17px] leading-[22px] font-semibold">
              Aún no hay nada que resumir
            </h2>
            {/* Aquí ya hay al menos una cuenta: sin ninguna, el armazón manda al
                primer arranque y esta pantalla no se llega a ver. Lo único que
                falta de verdad es el primer movimiento. */}
            <p className="max-w-sm text-[15px] leading-5 text-muted">
              Registra tu primer movimiento y esta pantalla se llenará sola:
              gasto del mes, reparto por categoría y comparativa. O conecta el
              Atajo del iPhone y que entren solos al pagar con Apple Pay.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <ButtonLink href="/movimientos/nuevo">
                Añadir un movimiento
              </ButtonLink>
              <ButtonLink href="/ajustes" variant="secondary">
                Conectar el Atajo
              </ButtonLink>
            </div>
          </Card>
        ) : (
          <>
            {/*
              La composición Aurora: héroe editorial, la banda de categorías como
              firma, la tira de secundarias con filetes y la previsión en tarjeta
              de cristal. Entran en cascada (animate-rise escalonado), que con
              movimiento reducido degrada a un fundido sin recorrido.

              El héroe va SIN caja: la cifra principal es el titular, no se agrupa
              con nada. La banda tampoco necesita caja: su propio carril de cristal
              la cierra. Lo único que de verdad flota —y por eso lleva cristal— es
              la previsión.
            */}
            <RegistroRecienteProvider mesActual={month}>
              {/* Héroe: eyebrow, cifra enorme y el delta en un chip iridiscente. */}
              <section className="flex animate-rise flex-col" style={{ animationDelay: "0ms" }}>
                <Eyebrow className="text-accent-text">Gasto de {monthLabel(month)}</Eyebrow>
                <p className="mt-2 cifra-hero">
                  {/* Al llegar de registrar un gasto, sube desde (valor − importe). */}
                  <CifraContada objetivo={netExpense} campo="gasto" />
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] leading-5 text-muted lg:text-[15px]">
                  {delta !== null ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-[linear-gradient(90deg,color-mix(in_srgb,var(--c-aurora)_22%,transparent),color-mix(in_srgb,var(--v-aurora)_22%,transparent))] px-2.5 py-1 text-[13px] font-semibold text-accent-text tabular-nums">
                      <Icon name={delta < 0 ? "arrow-down" : "arrow-up"} size={13} />
                      {formatShare(Math.abs(delta), 1)}
                    </span>
                  ) : null}
                  <span className="tabular-nums">
                    {delta !== null ? `${delta < 0 ? "menos" : "más"} que el mes pasado` : null}
                    {delta !== null && refunded > 0 ? " · " : ""}
                    {refunded > 0
                      ? `pagado ${formatCents(gross)} y devuelto ${formatCents(refunded)}`
                      : null}
                    {delta === null && refunded === 0 ? "Lo que te has gastado de verdad." : null}
                  </span>
                </div>
              </section>

              {/* La banda Aurora: el espectro de categorías, la firma de la pantalla. */}
              {breakdown && breakdown.length > 0 ? (
                <div className="animate-rise" style={{ animationDelay: "80ms" }}>
                  <BandaCategorias trozos={breakdown} mes={monthLabel(month)} mesIso={month} />
                </div>
              ) : null}

              {/* La tira de secundarias: ingresos, balance y previsión. Sin cajas,
                  separada con filete, a lo ancho para que no se partan palabras. */}
              <div
                data-tira
                className={cn(
                  "flex animate-rise hair-t hair-b border-hairline",
                  tiraEnFilas && "flex-col [--cifra-tira-cuerpo:20px] lg:flex-row",
                )}
                style={{ animationDelay: "140ms", "--n": caracteresTira } as React.CSSProperties}
              >
                {(
                  [
                    {
                      rotulo: "Ingresos",
                      tono: "text-income",
                      // Al llegar de registrar un ingreso (que no reembolsa), sube.
                      cifra: <CifraContada objetivo={income} campo="ingresos" />,
                    },
                    {
                      rotulo: "Balance",
                      tono: balance < 0 ? "text-expense" : "",
                      // El signo va fuera, sobre el valor final: la cuenta de
                      // bienvenida (0 → balance) no lo hace parpadear.
                      cifra: (
                        <>
                          {balance >= 0 ? "+" : ""}
                          <CifraContada objetivo={balance} campo="balance" />
                        </>
                      ),
                    },
                    {
                      rotulo: "Previsión",
                      tono: "",
                      // Redondeada en la tira: en un vistazo los céntimos son
                      // ruido y el número cabe en una columna estrecha.
                      cifra: textoPrevision,
                    },
                  ] as const
                ).map((columna, i) => (
                  <Fragment key={columna.rotulo}>
                    {i > 0 ? (
                      <div
                        className={cn(
                          "shrink-0 bg-hairline",
                          tiraEnFilas ? "h-[0.5px] lg:h-auto lg:w-px" : "w-px",
                        )}
                      />
                    ) : null}
                    <div
                      className={cn(
                        "flex min-w-0 py-3 lg:flex-1 lg:flex-col lg:py-4",
                        i > 0 && "lg:pl-6",
                        tiraEnFilas
                          ? "items-baseline justify-between gap-3 lg:items-stretch lg:justify-start lg:gap-0"
                          : cn("flex-auto flex-col", i > 0 && "pl-4"),
                      )}
                    >
                      <span className="text-[13px] leading-[18px] text-muted lg:text-[14px]">
                        {columna.rotulo}
                      </span>
                      <span
                        className={cn(
                          "cifra-tira font-medium lg:mt-1",
                          !tiraEnFilas && "mt-1",
                          columna.tono,
                        )}
                      >
                        {columna.cifra}
                      </span>
                    </div>
                  </Fragment>
                ))}
              </div>

              {/* La previsión en tarjeta de cristal con anillo: lo que de verdad
                  flota. Engancha con el dato de previsión que ya existe. */}
              {esMesActual && prevision && prevision.length > 0 ? (
                <div className="animate-rise" style={{ animationDelay: "200ms" }}>
                  <PrevisionMes
                    prevision={prevision[0]}
                    categorias={categoriasPrevision ?? []}
                    ingresoPendiente={ingresoPendiente ?? 0}
                  />
                </div>
              ) : null}
            </RegistroRecienteProvider>

            {/* Cola de pendientes y sin clasificar. */}
            {(pending ?? 0) > 0 || sinClasificar > 0 ? (
              <Link
                href={`/movimientos?${(pending ?? 0) > 0 ? "pendientes=1" : "categoria=sin"}`}
                className="pulsable flex items-center gap-3 rounded-lg bg-accent-soft p-4 text-fg"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink">
                  <Icon name="inbox" size={20} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[15px] font-semibold">
                    {(pending ?? 0) > 0
                      ? `${pending} ${pending === 1 ? "pago pendiente" : "pagos pendientes"} de confirmar`
                      : `${sinClasificar} sin categorizar`}
                  </span>
                  <span className="text-[13px] leading-[18px] text-muted">
                    {(pending ?? 0) > 0
                      ? "Llegaron del Atajo y ninguna regla supo clasificarlos."
                      : sinClasificarDelMes === sinClasificar
                        ? `Todos de ${monthLabel(month)}. Sin clasificar no cuentan en el reparto.`
                        : sinClasificarDelMes === 0
                          ? `Todo el histórico, ninguno de ${monthLabel(month)}.`
                          : `Todo el histórico, no solo ${monthLabel(month)} · ${sinClasificarDelMes} ${sinClasificarDelMes === 1 ? "es" : "son"} de este mes.`}
                  </span>
                </span>
                <Icon name="chevron-right" size={18} />
              </Link>
            ) : null}

            {/* Ritmo: cómo va el mes contra el anterior a estas alturas. */}
            <Card>
              <CardHeader title="Ritmo del mes" />
              <p className="px-4 pb-2 text-[13px] leading-[18px] text-muted lg:px-5">
                Gasto neto acumulado día a día.
              </p>
              <PaceChart
                puntos={ritmo ?? []}
                mesActual={monthLabel(month)}
                mesAnterior={monthLabel(shiftMonth(month, -1))}
                prevision={previsionStripCents}
              />
            </Card>

            {/* Los límites del mes, en anillos: cuánto de cada tope se ha ido.
                Sin límites no hay tarjeta: se ponen desde Análisis. */}
            {limites && limites.length > 0 ? (
              <Card>
                <CardHeader title={`Límites de ${monthLabel(month)}`} />
                <AnillosLimites limites={limites} mes={monthLabel(month)} mesIso={month} />
              </Card>
            ) : null}

            {/* Las categorías del mes en ranking, con la muesca del anterior:
                en qué gastas y qué se ha movido, en una sola tarjeta. */}
            {comparativa && comparativa.length > 0 ? (
              <Card>
                <CardHeader
                  title={`Categorías, ${monthLabel(month)} contra ${monthLabel(shiftMonth(month, -1))}`}
                />
                <CategoryComparison
                  filas={comparativa}
                  mes={monthLabel(month)}
                  mesPrevio={monthLabel(shiftMonth(month, -1))}
                  mesIso={month}
                />
              </Card>
            ) : null}

            <div className="flex items-baseline justify-between px-1">
              <Eyebrow>Últimos movimientos</Eyebrow>
              <Link
                href="/movimientos"
                className="toque relative text-[13px] font-semibold text-accent-text"
              >
                Ver todos
              </Link>
            </div>
            <TransactionList transactions={lastMovements} />
            {/* La lista agrupada solo se pinta en móvil; en escritorio, tabla simple. */}
            <Card className="hidden lg:block">
              <ul>
                {lastMovements.map((tx) => (
                  <li key={tx.id}>
                    <Link
                      href={`/movimientos/${tx.id}`}
                      className="fila-pulsable flex min-h-12 items-center gap-3 hair-t border-separator px-[18px] py-2 text-fg first:border-t-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                        {tx.description || "Sin descripción"}
                      </span>
                      <span className="truncate text-[13px] text-muted">
                        {tx.category?.name ?? "Sin categoría"}
                      </span>
                      {/* Con signo y color de tipo, como la lista de móvil y la
                          tabla de Movimientos: sin ellos un ingreso de 1200 €
                          se leía igual que un gasto de 1200 €. */}
                      <span
                        className="w-28 text-right text-[15px] font-semibold tabular-nums"
                        style={{ color: TYPE_COLOR_VAR[tx.type] }}
                      >
                        {formatSignedCents(tx.amount_cents, tx.type)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Últimos meses" />
              <MonthsBars meses={ultimosMeses} />
            </Card>

          </>
        )}

        {/* Fuera del condicional a propósito: en móvil esto es la única vía a
            Análisis, y tiene que existir también cuando aún no hay datos. */}
        <SubNav parent="/resumen" />
      </PageBody>
    </>
  );
}
