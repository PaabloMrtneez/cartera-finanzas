import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { BudgetBar } from "@/components/analisis/budget-bar";
import { BudgetDialog } from "@/components/analisis/budget-dialog";
import { CalendarioGasto } from "@/components/analisis/calendario-gasto";
import { CascadaMes } from "@/components/analisis/cascada-mes";
import { GastoComercios } from "@/components/analisis/gasto-comercios";
import { MapaCalor } from "@/components/analisis/mapa-calor";
import { CategoryTrends } from "@/components/analisis/category-trends";
import { MonthClose } from "@/components/analisis/month-close";
import { YoyChart } from "@/components/analisis/yoy-chart";
import { ReportDownload } from "@/components/analisis/report-download";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { addDays, monthEnd, monthLabel, monthStart, parseIsoDate, todayIso } from "@/lib/dates";
import { formatCents, formatPercent, formatShare, percentChange } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Análisis" };

/** Cuántos meses de histórico hacen falta para que comparar signifique algo. */
const MESES_MINIMOS = 3;

/** Los días que mira el mapa de calor: un mes solo deja la rejilla casi vacía. */
const DIAS_CALOR = 90;

export default async function AnalisisPage() {
  const hoy = todayIso();
  const month = monthStart(hoy);
  const supabase = await createClient();

  const [
    { data: limites },
    { data: medias },
    { data: hallazgos },
    { data: resumen },
    { data: categorias },
    { data: cerrados },
    { data: prevision },
    { data: anioAanio },
    { data: tendencia },
    { data: ingresoPendiente },
    { data: ritmo },
    { data: reparto },
    { data: comercios },
    { data: calor },
  ] = await Promise.all([
    supabase.rpc("budget_status", { p_month: month }),
    supabase.rpc("category_avg_6m", { p_month: month }),
    supabase.rpc("month_findings", { p_month: month }),
    supabase.from("v_month_summary").select("*").eq("period_month", month).maybeSingle(),
    supabase.from("category").select("*").eq("type", "EXPENSE").order("name"),
    supabase
      .from("v_closed_months")
      .select("*")
      .order("period_month", { ascending: false })
      .limit(24),
    // La previsión real (con suscripciones pendientes), en vez de una regla de
    // tres. La tendencia de 12 meses con su año a año. Y la tendencia por
    // categoría. Todo en el mismo lote.
    supabase.rpc("month_forecast", { p_month: month }),
    supabase.rpc("year_over_year", { p_month: month, p_months: 12 }),
    supabase.rpc("category_trend", { p_month: month, p_months: 12 }),
    // Ingresos recurrentes que faltan este mes, para cerrar el balance previsto.
    supabase.rpc("pending_recurring_income", { p_month: month }),
    // El mes día a día (el calendario), el reparto por categoría (la cascada),
    // los comercios del mes y el mapa de horas de los últimos 90 días.
    supabase.rpc("month_pace", { p_month: month }),
    supabase.rpc("category_breakdown", { p_month: month }),
    supabase.rpc("merchant_spend", {
      p_desde: month,
      p_hasta: monthEnd(month),
      p_limite: 8,
    }),
    supabase.rpc("spend_heatmap", {
      p_desde: addDays(hoy, -(DIAS_CALOR - 1)),
      p_hasta: hoy,
    }),
  ]);

  const conLimite = new Set((limites ?? []).map((l) => l.category_id));
  const sinLimite = (categorias ?? []).filter((c) => !conLimite.has(c.id));

  // Medias por categoría, para sugerir topes con criterio.
  const mediaPorCategoria = new Map(
    (medias ?? [])
      .filter((m): m is typeof m & { category_id: string } => m.category_id !== null)
      .map((m) => [m.category_id, m.avg_cents]),
  );

  const historico = Math.max(0, ...(medias ?? []).map((m) => m.months_with_data));
  const hayHistorico = historico >= MESES_MINIMOS;

  const gastoNeto = resumen?.net_expense_cents ?? 0;
  const dia = parseIsoDate(todayIso()).day;
  // La previsión buena: gasto real + suscripciones que faltan + discrecional
  // extrapolado. Humilde los primeros días (por eso el umbral de dias_transcurridos).
  const forecast = prevision?.[0];
  // Balance previsto = ingresos previstos (los reales de este mes + los ingresos
  // recurrentes que aún faltan por entrar) − gasto previsto. Es el pago de
  // modelar los ingresos recurrentes: la previsión deja de ser solo gasto.
  const ingresosPrevistos = (forecast?.ingresos_real_cents ?? 0) + (ingresoPendiente ?? 0);
  const balancePrevisto = forecast ? ingresosPrevistos - forecast.prevision_cents : 0;
  // El héroe da la previsión solo con base (los primeros días extrapolar es
  // ruido) y con algo gastado; si no, da el gasto neto.
  const conPrevision = Boolean(forecast && forecast.dias_transcurridos >= 4 && gastoNeto > 0);
  // Para el carril del héroe: qué parte de lo previsto ya está gastada y qué
  // parte del mes ha pasado. Solo presenta cifras que ya llegan hechas.
  const pctGastado =
    forecast && forecast.prevision_cents > 0
      ? Math.min(100, Math.max(0, (forecast.gasto_real_cents / forecast.prevision_cents) * 100))
      : 0;
  const pctMes =
    forecast && forecast.dias_totales > 0 ? Math.min(100, (dia / forecast.dias_totales) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Análisis"
        subtitle={monthLabel(month)}
        actions={
          <div className="flex items-center gap-2">
            <ReportDownload mes={month} />
            {cerrados && cerrados.length > 0 ? (
              <MonthClose
                months={cerrados}
                trigger={
                  <Button variant="secondary" size="compact" aria-label="Cierre de mes">
                    <Icon name="calendar-range" size={15} />
                    <span className="hidden lg:inline">Cierre de mes</span>
                  </Button>
                }
              />
            ) : null}
          </div>
        }
      />

      {/*
        La composición Aurora de Análisis. En móvil, una columna: el héroe (hacia
        dónde va el mes), lo que está pasando, la curva del año, los límites, la
        comparación con tu media y la tendencia por categoría. En escritorio, la
        MISMA secuencia colocada en una rejilla de doce: el héroe a lo ancho; la
        curva y los hallazgos lado a lado (con `col-start`, sin reordenar el
        DOM); límites y media, dos listas estrechas, a medias; y la tendencia a
        lo ancho, en múltiplos pequeños.
      */}
      <PageBody className="lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-8 lg:gap-y-8">
        {/* Héroe: sin caja. La cifra que manda es hacia dónde va el mes. */}
        <section className="flex animate-rise flex-col lg:col-span-12">
          <Eyebrow className="text-accent-text">
            {conPrevision
              ? `Cierre previsto de ${monthLabel(month)}`
              : `${monthLabel(month)}, a día ${dia}`}
          </Eyebrow>
          <p className="mt-2 cifra-hero">
            {conPrevision && forecast
              ? `≈ ${formatCents(forecast.prevision_cents)}`
              : formatCents(gastoNeto)}
          </p>
          <p className="mt-3 max-w-2xl text-[14px] leading-5 text-muted tabular-nums lg:text-[15px]">
            {conPrevision && forecast ? (
              <>
                Según tu ritmo y lo que falta por cargar. Llevas {formatCents(gastoNeto)} a día{" "}
                {dia}
                {ingresosPrevistos > 0 ? (
                  <>
                    {" "}
                    y el balance previsto es de{" "}
                    <span
                      className={cn(
                        "font-semibold",
                        balancePrevisto < 0 ? "text-expense" : "text-income",
                      )}
                    >
                      {balancePrevisto >= 0 ? "+" : ""}
                      {formatCents(balancePrevisto)}
                    </span>
                  </>
                ) : null}
                .
              </>
            ) : gastoNeto === 0 ? (
              "Todavía no has gastado nada este mes."
            ) : (
              "De gasto neto. La previsión de cierre aparece en cuanto haya unos días de base."
            )}
          </p>

          {/*
            El carril del mes: cuánto de lo previsto ya está gastado (el relleno
            iridiscente) contra cuánto mes ha pasado (la muesca). Si el relleno
            va por delante de la muesca, estás gastando antes de tiempo.
          */}
          {conPrevision && forecast ? (
            <div className="mt-5 flex max-w-2xl flex-col gap-2">
              <div className="relative">
                <div className="relative h-[6px] overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="absolute inset-y-0 left-0 origin-left animate-bar-fill rounded-full [background:var(--grad-aurora)]"
                    style={{ width: `${pctGastado}%`, animationDelay: "120ms" }}
                  />
                </div>
                <span
                  className="absolute -top-[5px] -bottom-[5px] w-[2px] -translate-x-1/2 rounded-full bg-fg opacity-55"
                  style={{ left: `${pctMes}%` }}
                  aria-hidden
                />
              </div>
              <div className="flex justify-between text-[13px] leading-[18px] text-muted tabular-nums">
                <span>
                  <span className="font-semibold text-fg">{formatShare(pctGastado)}</span> de lo
                  previsto
                </span>
                <span>
                  día {dia} de {forecast.dias_totales}
                </span>
              </div>
            </div>
          ) : null}
        </section>

        {/* Hallazgos: lo que merece que te lo cuenten sin buscarlo. Lista con
            filete, sin cajas: cada uno es una línea que se toca. */}
        {hallazgos && hallazgos.length > 0 ? (
          <section
            className="flex animate-rise flex-col gap-2 lg:col-span-5 lg:col-start-8 lg:row-start-2"
            style={{ animationDelay: "60ms" }}
          >
            <Eyebrow className="px-1">Qué está pasando</Eyebrow>
            <ul className="hair-b border-hairline">
              {hallazgos.map((h) => {
                const bien = h.tono === "bien";
                return (
                  <li key={h.kind} className="hair-t border-hairline">
                    <Link
                      href={h.href}
                      className="pulsable flex min-h-11 items-start gap-3 px-1 py-4 text-fg"
                    >
                      {/* El que va bien no lleva el triángulo: si todo se pinta
                          igual, todo se lee como una regañina. */}
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-full tint-14",
                          bien ? "text-income" : "text-warning",
                        )}
                      >
                        <Icon name={bien ? "check" : "triangle-alert"} size={16} />
                      </span>
                      {/* La cifra va en la línea del título, a la derecha; el
                          detalle corre debajo a todo el ancho, sin una columna
                          de números que lo estreche. */}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex items-baseline gap-3">
                          <span className="min-w-0 flex-1 text-[15px] leading-5 font-semibold">
                            {h.title}
                          </span>
                          <span
                            className={cn(
                              "cifra shrink-0 text-[19px] leading-6 font-medium",
                              bien && "text-income",
                            )}
                          >
                            {formatCents(h.cents)}
                          </span>
                        </span>
                        <span className="text-[13px] leading-[18px] text-muted">
                          {h.detail}{" "}
                          <span className="whitespace-nowrap tabular-nums">
                            ·{" "}
                            {bien
                              ? `${h.count} ${h.count === 1 ? "mes" : "meses"}`
                              : `${h.count} ${h.count === 1 ? "movimiento" : "movimientos"}`}
                          </span>
                        </span>
                      </span>
                      <span className="mt-[2px] shrink-0 text-muted">
                        <Icon name="chevron-right" size={16} />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {/* Año a año: la tendencia de 12 meses contra el mismo mes del año pasado. */}
        <Card
          className={cn(
            "animate-rise",
            hallazgos && hallazgos.length > 0
              ? "lg:col-span-7 lg:col-start-1 lg:row-start-2"
              : "lg:col-span-12",
          )}
          style={{ animationDelay: "120ms" }}
        >
          <CardHeader title="Año a año" />
          <p className="-mt-1 px-[18px] pb-3 text-[13px] leading-[18px] text-muted lg:px-5">
            Gasto neto de cada mes, con el año pasado por debajo.
          </p>
          <YoyChart puntos={anioAanio ?? []} />
        </Card>

        {/*
          El mes por dentro: QUÉ DÍAS gastas (el calendario) y ADÓNDE VA lo que
          entra (la cascada). Viven aquí y no en Resumen a propósito: Resumen es
          el vistazo —cuánto, a qué ritmo, en qué— y es de una columna; estas dos
          son para pararse a mirar, que es lo que se viene a hacer a Análisis.
        */}
        <Card className="animate-rise lg:col-span-5" style={{ animationDelay: "160ms" }}>
          <CardHeader title={`${capitalizar(monthLabel(month))}, día a día`} />
          <CalendarioGasto puntos={ritmo ?? []} mesIso={month} mes={monthLabel(month)} hoy={hoy} />
        </Card>

        <Card className="animate-rise lg:col-span-7" style={{ animationDelay: "200ms" }}>
          <CardHeader title="Del ingreso al ahorro" />
          <CascadaMes
            ingreso={resumen?.income_cents ?? 0}
            trozos={reparto ?? []}
            mes={monthLabel(month)}
            mesIso={month}
          />
        </Card>

        {/* Límites del mes. */}
        <Card className="lg:col-span-6">
          <CardHeader
            title="Límites del mes"
            action={
              sinLimite.length > 0 ? (
                <BudgetDialog
                  categories={sinLimite}
                  averages={mediaPorCategoria}
                  trigger={
                    <Button variant="ghost" size="compact" className="text-accent-text">
                      <Icon name="plus" size={15} />
                      Nuevo límite
                    </Button>
                  }
                />
              ) : null
            }
          />

          {limites && limites.length > 0 ? (
            <ul>
              {limites.map((limite) => (
                <li
                  key={limite.budget_id}
                  className="flex items-center gap-2 hair-t border-separator py-3.5 pr-2 pl-4 lg:pl-5"
                >
                  <div className="min-w-0 flex-1">
                    <BudgetBar budget={limite} month={month} />
                  </div>
                  <BudgetDialog
                    budget={limite}
                    categories={categorias ?? []}
                    averages={mediaPorCategoria}
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Editar el límite de ${limite.name}`}
                      >
                        <Icon name="pencil" size={18} />
                      </Button>
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center hair-t border-separator">
              <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted">
                <Icon name="lightbulb" size={22} />
              </span>
              <p className="max-w-sm text-[15px] leading-5 text-muted">
                Un límite no te impide gastar: te avisa cuando te acercas. Empieza por la categoría
                donde más se te escapa el dinero.
              </p>
              {sinLimite.length > 0 ? (
                <BudgetDialog
                  categories={sinLimite}
                  averages={mediaPorCategoria}
                  trigger={<Button>Poner el primer límite</Button>}
                />
              ) : (
                <p className="text-[13px] text-muted">
                  Antes hace falta alguna categoría de gasto.{" "}
                  <Link href="/categorias" className="font-semibold text-accent-text">
                    Crear una
                  </Link>
                </p>
              )}
            </div>
          )}
        </Card>

        {/* Comparativa contra la media: se calla si el histórico es corto. */}
        <Card className="lg:col-span-6">
          <CardHeader title="Contra tu media de 6 meses" />
          {!hayHistorico ? (
            <p className="px-[18px] pb-4 text-[13px] leading-[18px] text-muted">
              Aún no hay suficiente histórico para que esta comparación signifique algo. Con{" "}
              {MESES_MINIMOS} meses de datos empieza a aparecer; ahora mismo{" "}
              {historico === 0 ? "no hay ninguno" : historico === 1 ? "hay uno" : `hay ${historico}`}.
            </p>
          ) : (
            <ul>
              {(medias ?? []).slice(0, 10).map((m, i) => {
                const delta = percentChange(m.current_cents, m.avg_cents);
                const masCaro = m.current_cents > m.avg_cents;
                const maximo = Math.max(m.current_cents, m.avg_cents, 1);
                const ancho = Math.min(
                  100,
                  (Math.abs(m.current_cents - m.avg_cents) / maximo) * 100,
                );

                return (
                  <li
                    key={m.category_id ?? "sin"}
                    className="flex items-start gap-3 hair-t border-separator px-4 py-3.5 lg:px-5"
                  >
                    <span
                      className="flex size-[30px] shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: `color-mix(in srgb, ${m.color} 16%, transparent)`,
                        color: m.color,
                      }}
                    >
                      <Icon name={m.icon} size={16} />
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col gap-2">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                          {m.name}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 text-right text-[15px] font-semibold tabular-nums",
                            masCaro ? "text-expense" : "text-income",
                          )}
                        >
                          {delta === null ? formatCents(m.current_cents) : formatPercent(delta, 0)}
                        </span>
                      </span>

                      {/* Barra divergente: la media es el cero. Lo que sube va a
                          la derecha y lo que baja a la izquierda, y cada barra
                          crece desde el centro hacia su lado. */}
                      <span className="relative flex h-[8px] items-center" aria-hidden>
                        <span className="absolute inset-x-0 h-px bg-separator" />
                        <span className="absolute -top-[3px] -bottom-[3px] left-1/2 w-px bg-hairline" />
                        <span
                          className={cn(
                            "absolute h-[8px] animate-bar-fill overflow-hidden rounded-full",
                            masCaro ? "origin-left" : "origin-right",
                          )}
                          style={{
                            width: `${ancho / 2}%`,
                            left: masCaro ? "50%" : `${50 - ancho / 2}%`,
                            background: masCaro ? "var(--expense)" : "var(--income)",
                            animationDelay: `${i * 40}ms`,
                          }}
                        >
                          <span className="absolute inset-0 [background:linear-gradient(180deg,rgba(255,255,255,0.3),transparent_60%)] [mix-blend-mode:screen]" />
                        </span>
                      </span>

                      <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                        {formatCents(m.current_cents)} este mes · media {formatCents(m.avg_cents)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Dónde y cuándo: los comercios del mes y las horas de los últimos
            90 días. */}
        <Card className="lg:col-span-5">
          <CardHeader title="Por comercio" />
          <GastoComercios filas={comercios ?? []} mes={monthLabel(month)} mesIso={month} />
        </Card>

        <Card className="lg:col-span-7">
          <CardHeader title="Cuándo gastas" />
          <p className="-mt-1 px-[18px] pb-3 text-[13px] leading-[18px] text-muted lg:px-5">
            Por día de la semana y hora, en los últimos {DIAS_CALOR} días.
          </p>
          <MapaCalor celdas={calor ?? []} periodo={`los últimos ${DIAS_CALOR} días`} />
        </Card>

        {/* Tendencia por categoría: las de más gasto, mes a mes. */}
        {tendencia && tendencia.length > 0 ? (
          <Card className="lg:col-span-12">
            <CardHeader title="Tendencia por categoría" />
            <p className="-mt-1 px-[18px] pb-1 text-[13px] leading-[18px] text-muted lg:px-5 lg:pb-2">
              En qué más gastas, mes a mes. El último mes va resaltado.
            </p>
            <CategoryTrends filas={tendencia} />
          </Card>
        ) : null}
      </PageBody>
    </>
  );
}

const capitalizar = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
