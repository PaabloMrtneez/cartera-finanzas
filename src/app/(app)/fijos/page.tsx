import { PageBody, PageHeader } from "@/components/app/page-header";
import { ListaFijos } from "@/components/fijos/lista-fijos";
import { TarjetaProximos } from "@/components/fijos/proximos";
import { VistaFijosToggle } from "@/components/fijos/vista-fijos";
import { FuentesIngreso } from "@/components/ingresos/fuentes-ingreso";
import { GenerateIncomeButton } from "@/components/ingresos/generate-income-button";
import { IncomeDialog } from "@/components/ingresos/income-dialog";
import { CommitmentChart } from "@/components/suscripciones/commitment-chart";
import { GenerateChargesButton } from "@/components/suscripciones/generate-charges-button";
import { SubscriptionDialog } from "@/components/suscripciones/subscription-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { addDays, monthLabel, monthStart, shiftMonth, todayIso } from "@/lib/dates";
import { leerVistaFijos, netoFijo } from "@/lib/fijos";
import { MESES_INGRESO_MEDIO, ingresoMedio } from "@/lib/ingresos";
import { formatCents, formatShare, formatSignedDelta } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Fijos" };

/**
 * FIJOS: lo que se repite solo, en las dos direcciones.
 *
 * Reúne lo que eran Suscripciones e Ingresos recurrentes, que en el fondo eran
 * la misma cosa con el signo cambiado. La pantalla es UNA:
 *
 *  · La cabecera da la cifra que solo tiene sentido con los dos juntos: el NETO
 *    FIJO del mes —lo que entra fijo menos lo que sale fijo—, es decir, con
 *    cuánto arrancas cada mes antes de gastar un euro en el día a día. Debajo,
 *    sus dos componentes con lo que suman al año, y el peso de los gastos fijos
 *    sobre tus ingresos medios.
 *  · Después, un grupo u otro (`?ver=gastos|ingresos`), con su lista, su
 *    gráfico, lo que viene en 60 días y lo que está en pausa.
 *
 * Solo se consulta el detalle del grupo que se ve; las cifras de la cabecera,
 * que son de los dos, salen de las dos vistas de resumen, que son baratas.
 */
export default async function FijosPage({
  searchParams,
}: {
  searchParams: Promise<{ ver?: string | string[] }>;
}) {
  const vista = leerVistaFijos((await searchParams).ver);
  const esGastos = vista === "gastos";
  const supabase = await createClient();
  const hoy = todayIso();
  const mesActual = monthStart(hoy);
  const sinDatos = Promise.resolve({ data: null });

  const [
    { data: subs },
    { data: recurrentes },
    { data: accounts },
    { data: categories },
    { data: meses },
    { data: proximosCargos },
    { data: compromiso },
    { data: porSuscripcion },
    { data: proximosIngresos },
    { data: fuentesActual },
    { data: fuentesPrevio },
    { data: prestamosActivos },
  ] = await Promise.all([
    supabase.from("v_subscription_summary").select("*").order("description"),
    supabase.from("v_recurring_income_summary").select("*").order("description"),
    // Ni las archivadas ni las de un préstamo: esas las mueve el préstamo.
    supabase.from("account").select("*").eq("archived", false).neq("type", "PRESTAMO").order("name"),
    // Las categorías del grupo que se ve: un gasto fijo solo admite categorías
    // de gasto y un ingreso fijo, de ingreso (lo sostiene la clave compuesta).
    supabase
      .from("category")
      .select("*")
      .eq("type", esGastos ? "EXPENSE" : "INCOME")
      .order("name"),
    // Los meses CERRADOS de la media (ver lib/ingresos.ts): el mes en curso no
    // entra, porque va a medias y a principio de mes casi no hay ingresos.
    supabase
      .from("v_month_summary")
      .select("period_month, income_cents")
      .gte("period_month", shiftMonth(mesActual, -MESES_INGRESO_MEDIO))
      .lt("period_month", mesActual),
    esGastos ? supabase.rpc("upcoming_charges", { p_days: 60 }) : sinDatos,
    esGastos ? supabase.rpc("commitment_history", { p_months: 12 }) : sinDatos,
    // Quién cuenta cada mes: lo que explica cada escalón de la curva.
    esGastos ? supabase.rpc("commitment_by_subscription", { p_months: 12 }) : sinDatos,
    esGastos ? sinDatos : supabase.rpc("upcoming_income", { p_days: 60 }),
    esGastos ? sinDatos : supabase.rpc("income_breakdown", { p_month: mesActual }),
    // El mes anterior, por si el actual aún está vacío (ver «De dónde entra el
    // dinero», abajo). Se pide ya, a la vez que lo demás: esperar a saber si
    // hace falta costaba una ida y vuelta más a la base justo a primeros de mes.
    esGastos
      ? sinDatos
      : supabase.rpc("income_breakdown", { p_month: shiftMonth(mesActual, -1) }),
    // Los préstamos vivos, para sus cuotas (abajo). Antes se pedían DESPUÉS de
    // todo lo anterior.
    esGastos
      ? supabase.from("v_loan_status").select("loan_id, name").eq("status", "ACTIVO")
      : sinDatos,
  ]);

  // Las cuotas de los préstamos también son cargos que vienen: se cobran solas
  // como un gasto fijo. Van en «Próximos cargos», con el nombre del préstamo.
  const cuotasProximas: { id: string; description: string; amount_cents: number; fecha: string }[] = [];
  if (esGastos) {
    const activos = prestamosActivos;
    const limite = addDays(hoy, 60);
    // Un cuadro por préstamo, todos a la vez. Son uno o dos préstamos por
    // persona; si llegaran a ser muchos, esto pediría una RPC por lotes.
    const cuadros = await Promise.all(
      (activos ?? []).map((p) => supabase.rpc("loan_schedule", { p_loan_id: p.loan_id })),
    );
    (activos ?? []).forEach((p, i) => {
      for (const c of cuadros[i].data ?? []) {
        if (c.state === "PENDIENTE" && c.due_on >= hoy && c.due_on <= limite) {
          cuotasProximas.push({
            id: `prestamo-${p.loan_id}-${c.period}`,
            description: `Cuota de ${p.name}`,
            amount_cents: c.payment_cents,
            fecha: c.due_on,
          });
        }
      }
    });
  }
  const proximos = [
    ...(proximosCargos ?? []).map((c) => ({
      id: c.subscription_id,
      description: c.description,
      amount_cents: c.amount_cents,
      fecha: c.charge_date,
    })),
    ...cuotasProximas,
  ].sort((a, b) => a.fecha.localeCompare(b.fecha));

  const gastos = subs ?? [];
  const ingresos = recurrentes ?? [];
  const gastosActivos = gastos.filter((s) => s.active);
  const gastosPausados = gastos.filter((s) => !s.active);
  const ingresosActivos = ingresos.filter((r) => r.active);
  const ingresosPausados = ingresos.filter((r) => !r.active);

  const { gastosCents, ingresosCents, netoCents } = netoFijo(gastos, ingresos);
  const gastosAnio = gastosActivos.reduce((s, r) => s + r.yearly_cents, 0);
  const ingresosAnio = ingresosActivos.reduce((s, r) => s + r.yearly_cents, 0);
  const hayAlgo = gastos.length + ingresos.length > 0;

  // «De tus ingresos medios»: los gastos fijos sobre la media de los últimos
  // meses cerrados, no sobre lo que lleva entrado este mes (a día 5, sin la
  // nómina, salía un 300 %). El cociente es solo para pintar un porcentaje; los
  // dos importes son céntimos enteros.
  const media = ingresoMedio(meses ?? [], hoy);
  const porcentaje =
    media && media.mediaCents > 0 ? (gastosCents / media.mediaCents) * 100 : null;

  // De dónde entra el dinero. A primeros de mes la nómina aún no ha llegado y
  // el donut del mes en curso saldría vacío casi siempre: entonces se enseña
  // el mes anterior, que ya está completo, y se dice cuál es. Si tampoco hubo
  // nada el mes anterior, se queda el mes en curso.
  let mesFuentes = mesActual;
  let fuentes = fuentesActual ?? [];
  if (!esGastos && fuentes.every((f) => f.income_cents <= 0)) {
    const previo = fuentesPrevio ?? [];
    if (previo.some((f) => f.income_cents > 0)) {
      mesFuentes = shiftMonth(mesActual, -1);
      fuentes = previo;
    }
  }

  const porCategoria = new Map((categories ?? []).map((c) => [c.id, c]));

  const nuevoGasto = (trigger: React.ReactNode) => (
    <SubscriptionDialog accounts={accounts ?? []} categories={categories ?? []} trigger={trigger} />
  );
  const nuevoIngreso = (trigger: React.ReactNode) => (
    <IncomeDialog accounts={accounts ?? []} categories={categories ?? []} trigger={trigger} />
  );
  const botonEditar = (nombre: string) => (
    <Button variant="ghost" size="icon" aria-label={`Editar ${nombre}`}>
      <Icon name="pencil" size={18} />
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Fijos"
        actions={
          // El alta es la del grupo que se ve, y el botón lo dice: así no hace
          // falta un paso más para preguntar si es gasto o ingreso.
          (esGastos ? nuevoGasto : nuevoIngreso)(
            <Button
              size="compact"
              aria-label={esGastos ? "Nuevo gasto fijo" : "Nuevo ingreso fijo"}
            >
              <Icon name="plus" size={15} />
              <span className="hidden lg:inline">
                {esGastos ? "Nuevo gasto fijo" : "Nuevo ingreso fijo"}
              </span>
            </Button>,
          )
        }
      />

      <PageBody>
        {/* Sin nada apuntado no hay neto que dar: un «+0,00 €» encima del estado
            vacío lo contradiría. */}
        {hayAlgo ? (
          <>
            {/* El héroe, sin caja: la cifra que resume es el titular. */}
            <section className="flex animate-rise flex-col">
              <Eyebrow className="text-accent-text">Neto fijo al mes</Eyebrow>
              <p
                className={cn(
                  "mt-2 cifra-hero",
                  netoCents < 0 && "text-expense",
                )}
              >
                {formatSignedDelta(netoCents)}
              </p>
              <p className="mt-2 max-w-[640px] text-[14px] leading-5 text-muted lg:text-[15px] lg:leading-[22px]">
                {ingresosCents === 0
                  ? "Sin ingresos fijos, es lo que sale cada mes sin que hagas nada. Apunta la nómina y verás con cuánto arrancas el mes."
                  : "Con cuánto arrancas cada mes: lo que entra fijo menos lo que sale fijo, antes del gasto del día a día."}
              </p>
            </section>

            {/* Sus dos componentes, en el orden del segmentado de abajo. Sin
                cajas, separados con filete, como la tira de Resumen. */}
            <div
              className="flex animate-rise hair-t hair-b border-hairline"
              style={{ animationDelay: "60ms" }}
            >
              {[
                {
                  rotulo: "Gastos fijos",
                  mes: gastosCents,
                  anio: gastosAnio,
                  clase: "",
                },
                {
                  rotulo: "Ingresos fijos",
                  mes: ingresosCents,
                  anio: ingresosAnio,
                  clase: "text-income",
                },
              ].map((c, i) => (
                <div
                  key={c.rotulo}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col py-3 lg:py-4",
                    i === 1 && "hair-l border-hairline pl-4 lg:pl-6",
                  )}
                >
                  <span className="text-[13px] leading-[18px] text-muted lg:text-[14px]">
                    {c.rotulo} al mes
                  </span>
                  <span
                    className={cn(
                      "cifra mt-1 text-[20px] leading-7 font-medium tabular-nums lg:text-[24px] lg:leading-9",
                      c.clase,
                    )}
                  >
                    {formatCents(c.mes)}
                  </span>
                  <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                    {formatCents(c.anio)} al año
                  </span>
                </div>
              ))}
            </div>

            {/* El peso de lo fijo. Era un indicador con la explicación en un
                `title` —invisible en un móvil—; ahora es una frase entera. */}
            {gastosCents > 0 ? (
              <p className="-mt-1 animate-rise text-[14px] leading-5 text-muted lg:-mt-2 lg:text-[15px] lg:leading-[22px]">
                {porcentaje !== null && media ? (
                  <>
                    Los gastos fijos se llevan el{" "}
                    <span className="font-semibold text-fg tabular-nums">
                      {formatShare(porcentaje, 1)}
                    </span>{" "}
                    de tus ingresos medios:{" "}
                    <span className="tabular-nums">{formatCents(media.mediaCents)}</span> al mes,
                    la media de{" "}
                    {media.meses === 1
                      ? "el último mes cerrado"
                      : `los ${media.meses} últimos meses cerrados`}
                    .
                  </>
                ) : (
                  "Cuando cierre tu primer mes con ingresos, aquí verás qué parte de ellos se llevan los gastos fijos."
                )}
              </p>
            ) : null}
          </>
        ) : null}

        {/* Lo que ya tocaba generar, de los dos grupos: es una tarea pendiente
            y no puede quedar escondida detrás del segmentado. */}
        <GenerateChargesButton
          pendientes={gastosActivos.filter((s) => s.due).length}
        />
        <GenerateIncomeButton pendientes={ingresosActivos.filter((r) => r.due).length} />

        <VistaFijosToggle vista={vista} />

        {esGastos ? (
          <section aria-label="Gastos fijos" className="flex flex-col gap-4 lg:gap-6">
            {gastos.length === 0 ? (
              <>
                <Vacio
                  icono="repeat"
                  titulo="Todavía no hay gastos fijos"
                  texto="Lo que pagas cada mes sin pensarlo: streaming, gimnasio, móvil, el seguro. Apuntarlos es la forma de ver cuánto se te va en piloto automático, y sus cargos entran solos cuando tocan."
                  boton={nuevoGasto(<Button>Añadir el primero</Button>)}
                />
                {/* Sin gastos fijos, las cuotas de un préstamo siguen viniendo. */}
                {proximos.length > 0 ? (
                  <TarjetaProximos titulo="Próximos cargos" tipo="gasto" hoy={hoy} proximos={proximos} />
                ) : null}
              </>
            ) : (
              <>
                {gastosActivos.length > 0 ? (
                  <ListaFijos
                    tipo="gasto"
                    categorias={porCategoria}
                    filas={gastosActivos.map((s) => ({ ...s, proxima: s.next_charge_date }))}
                    editar={(s) => (
                      <SubscriptionDialog
                        subscription={s}
                        accounts={accounts ?? []}
                        categories={categories ?? []}
                        trigger={botonEditar(s.description)}
                      />
                    )}
                  />
                ) : null}

                <Card>
                  <CardHeader title="Gastos fijos, 12 meses" />
                  <CommitmentChart puntos={compromiso ?? []} suscripciones={porSuscripcion ?? []} />
                </Card>

                {proximos.length > 0 ? (
                  <TarjetaProximos titulo="Próximos cargos" tipo="gasto" hoy={hoy} proximos={proximos} />
                ) : null}

                {gastosPausados.length > 0 ? (
                  <EnPausa n={gastosPausados.length}>
                    <ListaFijos
                      tipo="gasto"
                      categorias={porCategoria}
                      filas={gastosPausados.map((s) => ({ ...s, proxima: s.next_charge_date }))}
                      editar={(s) => (
                        <SubscriptionDialog
                          subscription={s}
                          accounts={accounts ?? []}
                          categories={categories ?? []}
                          trigger={botonEditar(s.description)}
                        />
                      )}
                    />
                  </EnPausa>
                ) : null}
              </>
            )}
          </section>
        ) : (
          <section aria-label="Ingresos fijos" className="flex flex-col gap-4 lg:gap-6">
            {ingresos.length === 0 ? (
              <Vacio
                icono="banknote"
                titulo="Todavía no hay ingresos fijos"
                texto="La nómina, un alquiler que cobras, una pensión. Apuntarlos hace dos cosas: entran solos como movimiento cuando toca, y la previsión pasa a decirte con qué balance acabas el mes, no solo cuánto gastas."
                boton={nuevoIngreso(<Button>Añadir el primero</Button>)}
              />
            ) : ingresosActivos.length > 0 ? (
              <ListaFijos
                tipo="ingreso"
                categorias={porCategoria}
                filas={ingresosActivos.map((r) => ({ ...r, proxima: r.next_income_date }))}
                editar={(r) => (
                  <IncomeDialog
                    income={r}
                    accounts={accounts ?? []}
                    categories={categories ?? []}
                    trigger={botonEditar(r.description)}
                  />
                )}
              />
            ) : null}

            {/* Es ingreso REAL del mes, no solo el fijo: por eso se pinta
                aunque no haya ningún ingreso fijo apuntado. */}
            <Card>
              <CardHeader title={`De dónde entra, ${monthLabel(mesFuentes)}`} />
              <FuentesIngreso
                fuentes={fuentes}
                mes={monthLabel(mesFuentes)}
                mesPrevio={monthLabel(shiftMonth(mesFuentes, -1))}
                mesIso={mesFuentes}
              />
            </Card>

            {proximosIngresos && proximosIngresos.length > 0 ? (
              <TarjetaProximos
                titulo="Próximos ingresos"
                tipo="ingreso"
                hoy={hoy}
                proximos={proximosIngresos.map((r) => ({
                  id: r.recurring_income_id,
                  description: r.description,
                  amount_cents: r.amount_cents,
                  fecha: r.income_date,
                }))}
              />
            ) : null}

            {ingresosPausados.length > 0 ? (
              <EnPausa n={ingresosPausados.length}>
                <ListaFijos
                  tipo="ingreso"
                  categorias={porCategoria}
                  filas={ingresosPausados.map((r) => ({ ...r, proxima: r.next_income_date }))}
                  editar={(r) => (
                    <IncomeDialog
                      income={r}
                      accounts={accounts ?? []}
                      categories={categories ?? []}
                      trigger={botonEditar(r.description)}
                    />
                  )}
                />
              </EnPausa>
            ) : null}
          </section>
        )}
      </PageBody>
    </>
  );
}

function Vacio({
  icono,
  titulo,
  texto,
  boton,
}: {
  icono: string;
  titulo: string;
  texto: string;
  boton: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Icon name={icono} size={26} />
      </span>
      <h2 className="text-[17px] leading-[22px] font-semibold">{titulo}</h2>
      <p className="max-w-sm text-[15px] leading-5 text-muted">{texto}</p>
      {boton}
    </Card>
  );
}

function EnPausa({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Eyebrow className="px-1 tabular-nums">En pausa · {n}</Eyebrow>
      <p className="px-1 text-[13px] leading-[18px] text-muted">
        No generan movimientos ni cuentan en lo fijo del mes.
      </p>
      {children}
    </div>
  );
}
