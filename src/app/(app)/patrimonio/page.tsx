import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { CajaInvertido } from "@/components/patrimonio/caja-invertido";
import { NetWorthChart } from "@/components/patrimonio/net-worth-chart";
import { RangeToggle } from "@/components/patrimonio/range-toggle";
import { SavingsBars } from "@/components/patrimonio/savings-bars";
import { YearlyClose } from "@/components/patrimonio/yearly-close";
import { BarrasRanking } from "@/components/ui/barras-ranking";
import { ButtonLink } from "@/components/ui/button";
import { CifraLectora, LecturaCompartida } from "@/components/ui/lectura";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { monthStart, shiftMonth, todayIso } from "@/lib/dates";
import { variacionImporte } from "@/lib/graficos";
import {
  formatCents,
  formatPercent,
  formatShare,
  formatSignedDelta,
  percentChange,
} from "@/lib/money";
import { diasDeRango, esDiario, leerRango, mesesDeRango } from "@/lib/rangos";
import { createClient } from "@/lib/supabase/server";
import { ACCOUNT_TYPE_ICONS, ACCOUNT_TYPE_LABELS } from "@/lib/types";
import { valorDeCadaCuenta } from "@/lib/valor-cuentas";

export const metadata = { title: "Patrimonio" };

export default async function PatrimonioPage({
  searchParams,
}: {
  searchParams: Promise<{ rango?: string }>;
}) {
  const clave = leerRango((await searchParams).rango);
  const supabase = await createClient();
  const hoy = todayIso();
  // 1M y 3M van día a día; el resto, mes a mes.
  const diario = esDiario(clave);
  const rangoDias = diario ? diasDeRango(clave, hoy) : null;

  // Todo lo que no depende del rango sale YA. Solo la historia mensual necesita
  // saber cuántos meses pedir, y en «Todo» eso depende del primer movimiento:
  // antes, en «Todo», las ocho consultas esperaban a esa primera. Los
  // constructores de PostgREST no consultan hasta que alguien los espera:
  // `Promise.all` es lo que los lanza.
  const independientes = Promise.all([
    supabase.from("v_net_worth").select("*").maybeSingle(),
    // El rango diario pide también el periodo anterior, de la misma longitud.
    rangoDias
      ? supabase.rpc("net_worth_daily", { p_desde: rangoDias.previoDesde, p_hasta: rangoDias.hasta })
      : Promise.resolve({ data: null }),
    supabase.from("v_account_balance").select("*"),
    // El valor de cada cuenta, con la MISMA regla que v_net_worth (en una de
    // inversión, su efectivo menos lo traspasado a todos sus fondos —también
    // los archivados— más lo que valen hoy los activos). Por eso la suma de
    // «Dónde está» es, céntimo a céntimo, la cifra héroe.
    supabase.from("v_account_worth").select("account_id, worth_cents"),
    // Lo que sumas cada mes se queda en doce aunque la curva mire cinco años:
    // sesenta barras en un móvil no son un gráfico, son una trama.
    supabase.rpc("monthly_savings", { p_months: 12 }),
    supabase.rpc("yearly_close"),
    // El valor de cada cuenta al cierre del mes pasado: la muesca de «Dónde está».
    supabase.rpc("account_balance_monthly", { p_months: 2 }),
  ]);

  // «Todo» va desde el primer movimiento: hay que saber cuál es antes de pedir
  // la historia. Los demás rangos tienen meses fijos y no lo necesitan.
  const { data: primero } =
    clave === "todo"
      ? await supabase
          .from("transaction")
          .select("occurred_on")
          .neq("status", "DISCARDED")
          .order("occurred_on")
          .limit(1)
      : { data: null };
  const meses = mesesDeRango(clave, primero?.[0]?.occurred_on ?? null, hoy);
  // Se pide el DOBLE de historia (y al menos 13 meses): la mitad de atrás es el
  // periodo anterior, que la curva dibuja en discontinua, y el mes de hace un
  // año da la variación anual de la cabecera. «Todo» no tiene periodo anterior.
  // En los rangos diarios, los 13 cierres mensuales siguen haciendo falta para
  // esas dos variaciones de la losa.
  const mesesPedidos = diario ? 13 : clave === "todo" ? meses : Math.max(meses * 2, 13);
  const mesPrevio = shiftMonth(monthStart(hoy), -1);

  const [
    [
      { data: patrimonio },
      { data: diaria },
      { data: saldos },
      { data: valores },
      { data: ahorro },
      { data: anios },
      { data: porCuentaMes },
    ],
    { data: historia },
  ] = await Promise.all([
    independientes,
    // Los cierres de mes, con sus partes (caja, invertido, sin desplegar):
    // mismo total que net_worth_history, y además el área de debajo.
    supabase.rpc("net_worth_monthly", { p_months: mesesPedidos }),
  ]);

  const total = patrimonio?.net_worth_cents ?? 0;
  const serie = historia ?? [];

  // Los puntos de la curva y del área, del rango elegido, con su periodo
  // anterior alineado por índice para la discontinua.
  const fuente = rangoDias
    ? (diaria ?? [])
    : serie.map(({ period_month, ...resto }) => ({ fecha: period_month, ...resto }));
  const largoRango = rangoDias ? rangoDias.dias : meses;
  const puntos = fuente.slice(-largoRango);
  const previos =
    clave !== "todo" && fuente.length >= largoRango * 2
      ? fuente.slice(-largoRango * 2, -largoRango).map((p) => p.net_worth_cents)
      : null;
  const granularidad = rangoDias ? ("dia" as const) : ("mes" as const);

  // Lo que valía cada cuenta al cierre del mes pasado.
  const valorPrevio = new Map(
    (porCuentaMes ?? [])
      .filter((f) => f.period_month === mesPrevio)
      .map((f) => [f.account_id, f.worth_cents]),
  );
  const nombreMesPrevio = new Intl.DateTimeFormat("es-ES", { month: "long", timeZone: "UTC" }).format(
    new Date(`${mesPrevio}T00:00:00Z`),
  );
  // Dónde está el dinero: cada cuenta por lo que vale (el valor de mercado en
  // las de inversión, no su saldo contable), de más a menos.
  const valorPorCuenta = valorDeCadaCuenta(saldos ?? [], valores ?? []);
  const valorDe = (id: string) => valorPorCuenta.get(id) ?? 0;
  const cuentas = [...(saldos ?? [])].sort((a, b) => valorDe(b.account_id) - valorDe(a.account_id));

  const anterior = serie.length >= 2 ? serie[serie.length - 2].net_worth_cents : null;
  const deltaMes = anterior !== null ? percentChange(total, anterior) : null;
  // «En el año»: contra el cierre de hace once meses, el primero de una ventana de doce.
  const deltaAno =
    serie.length >= 12 ? percentChange(total, serie[serie.length - 12].net_worth_cents) : null;

  const positivo = cuentas
    .map((c) => valorDe(c.account_id))
    .filter((v) => v > 0)
    .reduce((a, b) => a + b, 0);

  const hayDatos = cuentas.length > 0;

  // Lo que suma el patrimonio, parte a parte. La deuda (≤ 0) es el saldo de las
  // cuentas de préstamo; v_net_worth ya la separa de la caja.
  const partes = [
    { etiqueta: "En cuentas", valor: patrimonio?.cash_cents ?? 0 },
    { etiqueta: "Invertido", valor: patrimonio?.invested_cents ?? 0 },
    { etiqueta: "Sin desplegar", valor: patrimonio?.idle_cents ?? 0 },
    { etiqueta: "Deuda", valor: patrimonio?.debt_cents ?? 0 },
  ].filter((parte) => parte.valor !== 0);

  return (
    <>
      <PageHeader title="Patrimonio" />

      <PageBody>
        {!hayDatos ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="trending-up" size={26} />
            </span>
            <h2 className="text-[17px] leading-[22px] font-semibold">Aún no hay patrimonio</h2>
            <p className="max-w-sm text-[15px] leading-5 text-muted">
              El patrimonio se deriva de tus cuentas. Crea la primera y aquí verás cuánto tienes y
              cómo evoluciona mes a mes.
            </p>
            <ButtonLink href="/cuentas">Ir a Cuentas</ButtonLink>
          </Card>
        ) : (
          <>
            {/*
              La portada: la cifra que lo resume todo va A PELO —como la héroe del
              resto de pantallas; una cifra sola no se mete en caja— y debajo, su
              curva en una tarjeta a todo el ancho, con sitio de sobra para el
              detalle. La cifra ES la lectura de la curva: al recorrerla da el
              patrimonio de ese mes y cuánto cambió desde el principio, por eso van
              envueltas juntas.
            */}
            <LecturaCompartida>
              <div className="flex animate-rise flex-col gap-4 lg:gap-6">
                <div>
                  <Eyebrow className="text-accent-text">Patrimonio neto</Eyebrow>
                  <CifraLectora className="mt-2" claseCifra="cifra-hero">
                    <p className="cifra-hero">{formatCents(total)}</p>
                    <p className="mt-2 text-[14px] leading-5 text-muted tabular-nums">
                      {deltaMes !== null ? `${formatPercent(deltaMes)} frente al mes pasado` : null}
                      {deltaMes !== null && deltaAno !== null ? " · " : ""}
                      {deltaAno !== null ? `${formatPercent(deltaAno)} en el año` : null}
                      {deltaMes === null && deltaAno === null
                        ? "Todo lo que tienes menos lo que debes."
                        : null}
                    </p>
                  </CifraLectora>

                  {/* Las partes, para que la cifra no sea un número sin explicar:
                      caja + invertido + sin desplegar + deuda = el total. Una tira
                      bajo la cifra, como el reparto de las otras pantallas. En
                      móvil, con cuatro, van de dos en dos: en fila no caben. */}
                  <div
                    className={cn(
                      "mt-5 hair-t border-hairline pt-4 lg:mt-6",
                      partes.length > 3 || (partes.length === 3 && (patrimonio?.debt_cents ?? 0) !== 0)
                        ? "grid grid-cols-2 gap-x-4 gap-y-3 lg:flex lg:gap-10"
                        : "flex gap-4 lg:gap-10",
                    )}
                  >
                    {partes.map((parte) => (
                      <div key={parte.etiqueta} className="flex min-w-0 flex-1 flex-col lg:flex-none">
                        <span className="text-[13px] leading-[18px] text-muted lg:text-[14px]">
                          {parte.etiqueta}
                        </span>
                        <span
                          className={cn(
                            "cifra mt-1 text-[19px] leading-6 font-medium lg:text-[22px] lg:leading-7",
                            parte.valor < 0 && "text-expense",
                          )}
                        >
                          {formatCents(parte.valor)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* La curva, en su tarjeta a todo el ancho: más sitio para el detalle. */}
                <Card>
                  <CardHeader title="Evolución" />
                  <NetWorthChart
                    puntos={puntos.map((p) => ({ fecha: p.fecha, net_worth_cents: p.net_worth_cents }))}
                    previos={previos}
                    granularidad={granularidad}
                  />
                  <div className="px-[18px] pb-4">
                    <RangeToggle rango={clave} />
                  </div>
                </Card>
              </div>
            </LecturaCompartida>

            {/*
              Todo a una columna, a lo ancho. Antes era una rejilla de dos
              columnas colocada a mano (`col-start`/`row-span`): según qué
              tarjetas existieran, alguna se quedaba descolocada con un hueco
              negro al lado (una tarjeta corta en una columna que abarcaba dos
              filas). Apiladas, los gráficos se ven más grandes y ninguna tarjeta
              cambia de sitio porque falte otra.
            */}
            <div
              className="flex animate-rise flex-col gap-4 lg:gap-6"
              style={{ animationDelay: "80ms" }}
            >
              {/* De qué está hecho el patrimonio, en el mismo rango que la curva
                  de arriba: justo debajo de ella. */}
              {puntos.length >= 2 &&
              puntos.some((p) => p.invested_cents !== 0 || p.idle_cents !== 0 || p.debt_cents !== 0) ? (
                <Card>
                  <CardHeader
                    title={
                      puntos.some((p) => p.debt_cents !== 0)
                        ? "Caja, invertido y deuda"
                        : "Caja frente a invertido"
                    }
                  />
                  <CajaInvertido puntos={puntos} granularidad={granularidad} />
                </Card>
              ) : null}

              <div className="flex flex-col gap-4 lg:gap-6">
                <Card>
                  <CardHeader title="Lo que sumas cada mes" />
                  <SavingsBars meses={ahorro ?? []} />
                </Card>

                {anios && anios.length > 0 ? (
                  <Card>
                    <CardHeader title="Cierre por año" />
                    <YearlyClose anios={anios} />
                  </Card>
                ) : null}
              </div>

              <Card>
                <CardHeader title="Dónde está" />
                {/*
                  La proporción, en barra en vez de en cifra. «31 %» hay que
                  leerlo y compararlo a mano; una barra se compara de un
                  vistazo, que es justo la pregunta de esta lista. Cada fila
                  lleva a los movimientos de su cuenta.
                */}
                <BarrasRanking
                  etiquetaAccesible="Dónde está el dinero, cuenta a cuenta"
                  filas={cuentas.map((cuenta) => {
                    const valor = valorDe(cuenta.account_id);
                    const parte = positivo > 0 && valor > 0 ? (valor / positivo) * 100 : 0;
                    const antes = valorPrevio.get(cuenta.account_id);
                    // Frente al cierre del mes pasado: la muesca marca dónde
                    // estaba, y la variación lo dice con números. Subir es bueno.
                    const cambio =
                      antes !== undefined && antes !== valor ? variacionImporte(antes, valor) : null;
                    return {
                      id: cuenta.account_id,
                      nombre: cuenta.name,
                      subtitulo: `${ACCOUNT_TYPE_LABELS[cuenta.type]}${cuenta.archived ? " · archivada" : ""}`,
                      icono: ACCOUNT_TYPE_ICONS[cuenta.type],
                      color: cuenta.color,
                      valor,
                      texto: formatCents(valor),
                      share: parte > 0 ? formatShare(parte) : undefined,
                      negativo: valor < 0,
                      previo: antes !== undefined && antes > 0 ? antes : null,
                      // Solo el importe: el mes ya lo dice el pie, y un texto
                      // largo aquí trunca el nombre de la cuenta.
                      variacion: cambio
                        ? { texto: formatSignedDelta(valor - (antes ?? 0)), tono: cambio.tono }
                        : undefined,
                      href: `/movimientos?mes=todo&cuenta=${cuenta.account_id}`,
                    };
                  })}
                />

                <p className="hair-t border-separator px-[18px] py-3 text-[13px] leading-[18px] text-muted">
                  La muesca marca dónde estaba cada cuenta a final de {nombreMesPrevio}. Las
                  archivadas siguen contando: el dinero sigue ahí aunque no las uses. Y las de
                  inversión valen por su valor de mercado, no por lo que pusiste.
                  </p>
              </Card>
            </div>

            <p className="px-1 text-[13px] leading-[18px] text-muted">
              ¿Quieres ver cómo van tus inversiones?{" "}
              <Link href="/inversiones" className="font-semibold text-accent-text">
                Ir a Inversiones
              </Link>
            </p>
          </>
        )}
      </PageBody>
    </>
  );
}
