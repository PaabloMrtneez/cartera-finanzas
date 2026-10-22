import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { AjustarDialog } from "@/components/inversiones/ajustar-dialog";
import { AportadoValor, carteraPorFecha } from "@/components/inversiones/aportado-valor";
import { DonutPosiciones } from "@/components/inversiones/donut-posiciones";
import { FichaPosicion, type DatosFicha } from "@/components/inversiones/ficha-posicion";
import { PerformanceChart } from "@/components/inversiones/performance-chart";
import { PositionDialog } from "@/components/inversiones/position-dialog";
import { RangoInversion } from "@/components/inversiones/range-toggle";
import { SeguirDialog, type PosicionConvertible } from "@/components/inversiones/seguir-dialog";
import { ValuationDialog } from "@/components/inversiones/valuation-dialog";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { addDays, monthLabel, monthStart, shortDate, todayIso } from "@/lib/dates";
import { NOMBRE_TIPO } from "@/lib/mercado";
import { formatCents, formatPercent, formatShare } from "@/lib/money";
import {
  desdeRango,
  etiquetaPeriodo,
  leerRangoInversion,
} from "@/lib/rangos-inversion";
import { leerTodo } from "@/lib/supabase/paginar";
import { createClient } from "@/lib/supabase/server";
import { baseDeValoracion } from "@/lib/valoracion";

type AportePosicion = { position_id: string | null; occurred_on: string; amount_cents: number };

/** Agrupa filas por posición (las que no tienen posición se descartan). */
function agrupar<T extends { position_id: string | null }>(filas: readonly T[]): Map<string, T[]> {
  const mapa = new Map<string, T[]>();
  for (const fila of filas) {
    if (!fila.position_id) continue;
    const lista = mapa.get(fila.position_id);
    if (lista) lista.push(fila);
    else mapa.set(fila.position_id, [fila]);
  }
  return mapa;
}

export const metadata = { title: "Inversiones" };

export default async function InversionesPage({
  searchParams,
}: {
  searchParams: Promise<{ rango?: string }>;
}) {
  const supabase = await createClient();
  const hoy = todayIso();
  const rango = leerRangoInversion((await searchParams).rango);

  // Lo que depende del periodo (rendimientos y curvas) necesita saber desde
  // cuándo se mira. Solo «Todo» depende de las posiciones (arranca en la más
  // antigua); los demás rangos son fechas fijas, así que esas tres consultas
  // salen YA, a la vez que todo lo demás. Antes iban siempre en una segunda
  // tanda, tras las posiciones: una ida y vuelta más a la base en cada visita.
  // Los constructores de PostgREST no consultan hasta que alguien los espera:
  // `Promise.all` es lo que los lanza.
  const delPeriodo = (desde: string) =>
    Promise.all([
      supabase.rpc("position_return", { p_from: desde, p_to: hoy }),
      supabase.rpc("portfolio_return", { p_from: desde, p_to: hoy }),
      // Por páginas: PostgREST corta a 1.000 filas sin avisar. La función ya da
      // un punto por semana o por mes en los rangos largos, así que casi siempre
      // cabe en una; paginar es la red para quien tenga muchos fondos.
      leerTodo((d, h) =>
        supabase.rpc("position_performance", { p_from: desde, p_to: hoy }).range(d, h),
      ),
    ]);
  const periodoAdelantado = rango === "todo" ? null : delPeriodo(desdeRango(rango, null, hoy));

  // Con las posiciones, las valoraciones de meses anteriores: son la base sobre
  // la que se aplica una valoración en porcentaje (ver baseDeValoracion).
  const [
    { data: posiciones },
    { data: valoracionesPrevias },
    { data: cuentas },
    { data: pendientes },
    { data: patrimonio },
    { data: mercado },
    { data: aportaciones },
  ] = await Promise.all([
    supabase.from("v_position_value").select("*").order("value_cents", { ascending: false }),
    supabase
      .from("valuation")
      .select("position_id, date, value_cents")
      .lt("date", monthStart(hoy)),
    supabase
      .from("account")
      .select("id, name")
      .eq("type", "INVERSION")
      .eq("archived", false)
      .order("name"),
    supabase.from("v_pending_valuation").select("*"),
    supabase.from("v_net_worth").select("*").maybeSingle(),
    // Lo de mercado de cada posición. Participaciones, precio y cambio como
    // TEXTO: numeric llega como doble por JSON, y se enseñan tal cual.
    supabase
      .from("v_position_market")
      .select(
        "position_id, seguida, yahoo_symbol, instrument_name, instrument_kind, currency, exchange, alta_date, anchor_date, units_estimadas, price_date, fx_date, value_cents, fuente, valued_on, sin_precio, contributed_cents, gain_cents, return_pct, dias_sin_precio, desactualizado, unidades:units::text, precio:price::text, cambio:fx_rate::text",
      )
      .eq("archived", false),
    // Todas las aportaciones (traspasos a una posición, sin descartar): las de
    // antes de la fecha pre-rellenan el «total aportado» al convertir una
    // posición, y las que no traen participaciones se pueden corregir.
    // Con los años pasan de 1.000: por páginas, con un orden total.
    leerTodo((d, h) =>
      supabase
        .from("transaction")
        .select(
          "id, position_id, occurred_on, amount_cents, description, unidades:position_units::text",
        )
        .not("position_id", "is", null)
        .eq("type", "TRANSFER")
        .neq("status", "DISCARDED")
        .order("occurred_on")
        .order("id")
        .range(d, h),
    ),
  ]);

  // Lo aportado después de la más antigua de esas «últimas valoraciones» basta
  // para todas las posiciones: lo de antes ya está dentro de su valoración.
  const ultimaPrevia = new Map<string, string>();
  for (const v of valoracionesPrevias ?? []) {
    const actual = ultimaPrevia.get(v.position_id);
    if (!actual || v.date > actual) ultimaPrevia.set(v.position_id, v.date);
  }
  const aportesDesde = [...ultimaPrevia.values()].sort()[0] ?? null;

  const primerDia = (posiciones ?? [])
    .filter((p) => !p.archived)
    .map((p) => p.since)
    .sort()[0];
  // Un día antes del primero, para que la aportación de ese mismo día quede
  // dentro del periodo: el cálculo cuenta los flujos con `> p_from`.
  const desde = desdeRango(rango, primerDia ? addDays(primerDia, -1) : null, hoy);

  const [
    [{ data: rendimientos }, { data: cartera }, { data: curvas }],
    { data: aportesPosteriores },
  ] = await Promise.all([
    periodoAdelantado ?? delPeriodo(desde),
    // Mismo filtro que v_position_contributions: traspasos a una posición que
    // no estén descartados.
    aportesDesde
      ? leerTodo((d, h) =>
          supabase
            .from("transaction")
            .select("position_id, occurred_on, amount_cents")
            .not("position_id", "is", null)
            .eq("type", "TRANSFER")
            .neq("status", "DISCARDED")
            .gt("occurred_on", aportesDesde)
            .lte("occurred_on", hoy)
            .order("occurred_on")
            .order("id")
            .range(d, h),
        )
      : Promise.resolve({ data: [] as AportePosicion[] }),
  ]);

  const valoracionesPorPosicion = agrupar(valoracionesPrevias ?? []);
  const aportesPorPosicion = agrupar(aportesPosteriores ?? []);

  const activas = (posiciones ?? []).filter((p) => !p.archived);
  const archivadas = (posiciones ?? []).filter((p) => p.archived);
  const invertido = activas.reduce((sum, p) => sum + p.value_cents, 0);
  const mercadoPorId = new Map((mercado ?? []).map((m) => [m.position_id, m]));
  /*
    El coste de una posición es el de `v_position_market`: lo traspasado MÁS el
    capital que declaraste al empezar a seguirla y que la app no vio entrar
    (migración 20261008090000). `v_position_value.contributed_cents` es solo lo
    traspasado —lo que el patrimonio resta del saldo— y se queda corto en una
    posición que nace sincronizada. La regla vive en la base; aquí solo se lee.
  */
  const costeDe = (p: (typeof activas)[number]) =>
    mercadoPorId.get(p.position_id)?.contributed_cents ?? p.contributed_cents;
  // Lo que has metido de tu bolsillo, que es una pregunta distinta de lo que
  // vale hoy. La diferencia entre las dos ES la ganancia de toda la vida.
  const aportado = activas.reduce((sum, p) => sum + costeDe(p), 0);
  const periodo = etiquetaPeriodo(rango, hoy);
  const total = patrimonio?.net_worth_cents ?? 0;
  // Solo se enseña la proporción cuando significa algo. Si tienes más
  // invertido que patrimonio neto —porque arrastras deuda— el porcentaje pasa
  // de 100 y se lee como un fallo, así que se dice con palabras.
  const parteDelPatrimonio =
    total > 0 && invertido <= total ? (invertido / total) * 100 : null;
  const invertidoSuperaPatrimonio = total > 0 && invertido > total;

  // Si una sola posición se come media cartera, hay que decirlo: es el riesgo
  // que no se ve mirando el rendimiento, que puede ser estupendo justo hasta
  // que deja de serlo.
  const mayor = activas.length > 1 ? activas.reduce((a, b) => (b.value_cents > a.value_cents ? b : a)) : null;
  const concentracion = mayor && invertido > 0 ? (mayor.value_cents / invertido) * 100 : 0;

  const rendimientoPorId = new Map((rendimientos ?? []).map((r) => [r.position_id, r]));
  const resumen = cartera?.[0];

  /*
    Sin ninguna aportación apuntada NO hay ganancia que calcular.

    Si creas la posición y escribes lo que vale, sin registrar el traspaso que
    la financió, el coste de partida es cero y la resta «valor − aportado» dice
    que has ganado justo lo que acabas de meter. La base de datos hace la misma
    cuenta —`fin − inicio − aportado`— y llega al mismo sitio, así que el filtro
    tiene que estar aquí: mejor un guion que un número falso.
  */
  const hayBase = aportado > 0;
  const ganancia = hayBase ? (resumen?.gain_cents ?? invertido - aportado) : null;
  const rendimientoLargo = aportado > 0 ? ((invertido - aportado) / aportado) * 100 : null;
  const rendimiento = hayBase ? (resumen?.return_pct ?? rendimientoLargo) : null;

  // Agrupadas por cuenta, como el prototipo.
  const porCuenta = new Map<string, typeof activas>();
  for (const posicion of activas) {
    const lista = porCuenta.get(posicion.account_id) ?? [];
    lista.push(posicion);
    porCuenta.set(posicion.account_id, lista);
  }
  const nombreCuenta = new Map((cuentas ?? []).map((c) => [c.id, c.name]));

  const aportacionesPorPosicion = agrupar(aportaciones ?? []);

  // Las posiciones manuales se pueden pasar a seguir una cotización, con lo que
  // ya llevan aportado para pre-rellenar el «total aportado».
  const manuales: PosicionConvertible[] = activas
    .filter((p) => !mercadoPorId.get(p.position_id)?.seguida)
    .map((p) => ({
      position_id: p.position_id,
      name: p.name,
      aportes: (aportacionesPorPosicion.get(p.position_id) ?? []).map((a) => ({
        fecha: a.occurred_on,
        cents: a.amount_cents,
      })),
    }));

  /** Lo que enseña la ficha, en texto y céntimos: nada de floats para dinero. */
  function datosFicha(p: (typeof activas)[number]): DatosFicha {
    const m = mercadoPorId.get(p.position_id);
    return {
      position_id: p.position_id,
      name: p.name,
      color: p.color,
      seguida: m?.seguida ?? false,
      instrumento: m?.instrument_name ?? null,
      simbolo: m?.yahoo_symbol ?? null,
      tipo: m?.instrument_kind ?? null,
      divisa: m?.currency ?? null,
      mercado: m?.exchange ?? null,
      unidades: m?.unidades ?? null,
      unidadesEstimadas: m?.units_estimadas ?? false,
      precio: m?.precio ?? null,
      precioFecha: m?.price_date ?? null,
      cambio: m?.cambio ?? null,
      cambioFecha: m?.fx_date ?? null,
      value_cents: p.value_cents,
      fuente: p.fuente,
      valuedOn: p.valued_on,
      sinPrecio: m?.sin_precio ?? false,
      sinValorar: p.sin_valorar,
      contributed_cents: costeDe(p),
      gain_cents: m?.gain_cents ?? p.value_cents - costeDe(p),
      return_pct: m?.return_pct ?? null,
      diasSinPrecio: m?.dias_sin_precio ?? null,
      desactualizado: m?.desactualizado ?? false,
      parte: invertido > 0 ? (p.value_cents / invertido) * 100 : 0,
    };
  }

  /** Lo que necesita «Ajustar»: los datos de mercado y las aportaciones estimadas. */
  function posicionSeguida(p: (typeof activas)[number], d: DatosFicha) {
    const m = mercadoPorId.get(p.position_id);
    const ancla = m?.anchor_date ?? null;
    return {
      position_id: p.position_id,
      name: p.name,
      instrumento: [d.instrumento, d.simbolo, d.tipo ? NOMBRE_TIPO[d.tipo] : null]
        .filter(Boolean)
        .join(" · "),
      tipo: d.tipo,
      unidades: d.unidades,
      precio: d.precio,
      divisa: d.divisa,
      cambio: d.cambio,
      alta: m?.alta_date ?? null,
      // Las que cuentan desde el último alta o ajuste y no traen las suyas: las
      // del mismo día del ancla se dan por incluidas en él.
      estimadas: (aportacionesPorPosicion.get(p.position_id) ?? [])
        .filter((a) => a.unidades === null && (ancla === null || a.occurred_on > ancla))
        .map((a) => ({
          id: a.id,
          fecha: a.occurred_on,
          importe: formatCents(a.amount_cents),
          descripcion: a.description,
        })),
    };
  }

  return (
    <>
      <PageHeader
        title="Inversiones"
        subtitle={activas.length > 0 ? formatCents(invertido) : undefined}
        actions={
          <div className="flex items-center gap-2">
            {/*
              El segmentado de rango son cinco pastillas: en la cabecera de
              móvil dejaba al título «Inversiones» sin sitio y lo cortaba. Aquí
              se queda solo en escritorio; en móvil baja al cuerpo, en su fila.
            */}
            {activas.length > 0 ? (
              <span className="hidden lg:block">
                <RangoInversion rango={rango} />
              </span>
            ) : null}
            {(cuentas ?? []).length > 0 ? (
              <SeguirDialog
                accounts={cuentas ?? []}
                manuales={manuales}
                trigger={
                  <Button variant="secondary" size="compact" aria-label="Seguir cotización">
                    <Icon name="refresh-cw" size={15} />
                    <span className="hidden lg:inline">Seguir cotización</span>
                  </Button>
                }
              />
            ) : null}
            <PositionDialog
              accounts={cuentas ?? []}
              trigger={
                <Button size="compact" aria-label="Nueva posición">
                  <Icon name="plus" size={15} />
                  <span className="hidden lg:inline">Nueva posición</span>
                </Button>
              }
            />
          </div>
        }
      />

      <PageBody>
        {(cuentas ?? []).length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="chart-line" size={26} />
            </span>
            <h2 className="text-[17px] leading-[22px] font-semibold">
              Primero, una cuenta de inversión
            </h2>
            <p className="max-w-sm text-[15px] leading-5 text-muted">
              Las posiciones cuelgan de una cuenta de tipo Inversión: tu bróker, tu gestor
              automatizado, tu plan de pensiones. Crea una y vuelve.
            </p>
            <ButtonLink href="/cuentas">Ir a Cuentas</ButtonLink>
          </Card>
        ) : activas.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="chart-line" size={26} />
            </span>
            <h2 className="text-[17px] leading-[22px] font-semibold">Todavía no hay posiciones</h2>
            <p className="max-w-sm text-[15px] leading-5 text-muted">
              Una posición es cada cosa en la que inviertes por separado: un fondo, una acción, un
              plan. Si cotiza, su valor se actualiza solo cada día; si no, la valoras tú una vez al
              mes. De ahí sale tu rendimiento real.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <SeguirDialog
                accounts={cuentas ?? []}
                manuales={[]}
                trigger={<Button>Seguir un fondo o una acción</Button>}
              />
              <PositionDialog
                accounts={cuentas ?? []}
                trigger={<Button variant="secondary">Valorarla a mano</Button>}
              />
            </div>
          </Card>
        ) : (
          <>
            {/*
              El rango en móvil, en su propia fila: en la cabecera no cabía junto
              al título. En escritorio vive arriba, en las acciones. `flex` hace
              que la pastilla se ajuste a su contenido en vez de estirarse.
            */}
            <div className="flex lg:hidden">
              <RangoInversion rango={rango} />
            </div>

            {/* Aviso de valoración pendiente: sin esto la curva se queda plana. */}
            {pendientes && pendientes.length > 0 ? (
              <div className="flex items-center gap-3 rounded-lg bg-accent-soft p-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink">
                  <Icon name="triangle-alert" size={20} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[15px] font-semibold">
                    {monthLabel(monthStart(hoy))} sin valorar
                  </span>
                  <span className="text-[13px] leading-[18px] text-muted">
                    {pendientes.length === 1
                      ? `Falta ${pendientes[0].name}.`
                      : `Faltan ${pendientes.length} posiciones.`}{" "}
                    Sin valorar, tu patrimonio se queda congelado.
                  </span>
                </span>
              </div>
            ) : null}

            {/*
              La cifra héroe es lo que VALE hoy. Debajo, separadas por filete,
              las tres que la explican: lo que metiste de tu bolsillo, lo que ha
              ganado o perdido en el periodo elegido, y en cuánto por ciento.

              Aportado y valor son preguntas distintas, y tenerlas juntas es lo
              que convierte «tengo 6.980 €» en «metí 6.500 y he ganado 480».
            */}
            <div className="flex animate-rise flex-col">
              <Eyebrow className="text-accent-text">Valor invertido</Eyebrow>
              <p className="mt-2 cifra-hero">
                {formatCents(invertido)}
              </p>
              <p className="mt-2 text-[14px] leading-5 text-muted tabular-nums">
                {parteDelPatrimonio !== null
                  ? `${formatShare(parteDelPatrimonio)} de tu patrimonio`
                  : invertidoSuperaPatrimonio
                    ? "Más que tu patrimonio neto, porque tienes deuda por medio."
                    : "Lo que valen hoy tus posiciones."}
              </p>

              <div className="mt-5 flex hair-t hair-b border-hairline lg:mt-6">
                <div className="flex min-w-0 flex-1 flex-col py-3 lg:py-4">
                  <span className="text-[13px] leading-[18px] text-muted lg:text-[14px]">
                    Aportado
                  </span>
                  <span className="cifra mt-1 text-[20px] leading-7 font-medium lg:text-[26px] lg:leading-8">
                    {formatCents(aportado)}
                  </span>
                </div>

                <div className="w-px bg-hairline" />
                <div className="flex min-w-0 flex-1 flex-col py-3 pl-4 lg:py-4 lg:pl-6">
                  <span className="text-[13px] leading-[18px] text-muted lg:text-[14px]">
                    Ganancia
                  </span>
                  <span
                    className={cn(
                      "cifra mt-1 text-[20px] leading-7 font-medium lg:text-[26px] lg:leading-8",
                      ganancia === null
                        ? "text-muted"
                        : ganancia >= 0
                          ? "text-income"
                          : "text-expense",
                    )}
                  >
                    {ganancia === null
                      ? "—"
                      : `${ganancia >= 0 ? "+" : "−"}${formatCents(Math.abs(ganancia))}`}
                  </span>
                </div>

                <div className="w-px bg-hairline" />
                <div className="flex min-w-0 flex-1 flex-col py-3 pl-4 lg:py-4 lg:pl-6">
                  <span className="text-[13px] leading-[18px] text-muted lg:text-[14px]">
                    Rendimiento
                  </span>
                  <span
                    className={cn(
                      "cifra mt-1 text-[20px] leading-7 font-medium lg:text-[26px] lg:leading-8",
                      rendimiento === null
                        ? "text-muted"
                        : rendimiento >= 0
                          ? "text-income"
                          : "text-expense",
                    )}
                  >
                    {rendimiento === null ? "—" : formatPercent(rendimiento)}
                  </span>
                </div>
              </div>

              {hayBase ? (
                <p className="mt-3 text-[13px] leading-[18px] text-muted">
                  Ganancia y rendimiento son {periodo}. El cálculo descuenta lo aportado y mide
                  el porcentaje sobre lo que has puesto: meter dinero no cuenta como ganar.
                </p>
              ) : (
                <p className="mt-3 text-[13px] leading-[18px] text-muted">
                  Falta apuntar el dinero que metiste. Sin eso no hay contra qué medir, y lo que
                  vale hoy contaría entero como ganancia. Registra el traspaso desde la cuenta que
                  lo pagó hacia la de inversión, con la posición elegida, y aparecerá.
                </p>
              )}
            </div>

            {concentracion >= 50 && mayor ? (
              <div className="flex items-start gap-3 rounded-lg bg-surface-2 p-4">
                <span className="mt-[2px] shrink-0 text-warning">
                  <Icon name="triangle-alert" size={18} />
                </span>
                <p className="text-[13px] leading-[18px] text-muted tabular-nums">
                  <span className="font-semibold text-fg">
                    {formatShare(concentracion)} está en una sola posición
                  </span>
                  : {formatCents(mayor.value_cents)} en {mayor.name}. No es un error, pero
                  conviene saberlo.
                </p>
              </div>
            ) : null}

            {/*
              El reparto de la cartera por posición, en el donut Aurora: pocas
              partes y un total que importa, que vive en el centro. Va aquí
              arriba —justo bajo la cifra— y en las dos anchuras: es el primer
              vistazo a «cuánto pesa cada cosa», antes de bajar a las curvas.
            */}
            {invertido > 0 ? (
              <Card className="animate-rise" style={{ animationDelay: "80ms" }}>
                <CardHeader title="Por posición" />
                <DonutPosiciones
                  posiciones={activas.map((p) => ({
                    position_id: p.position_id,
                    name: p.name,
                    value_cents: p.value_cents,
                    contributed_cents: costeDe(p),
                  }))}
                />
              </Card>
            ) : null}

            {/*
              La cartera entera: lo que vale frente a lo que has metido, con la
              ganancia sombreada entre las dos. Es el gráfico héroe de la
              pantalla; las curvas de cada posición, debajo, ya no dibujan.
            */}
            <Card className="animate-rise" style={{ animationDelay: "120ms" }}>
              <CardHeader title="Aportado frente a valor" />
              <AportadoValor puntos={carteraPorFecha(curvas ?? [])} periodo={periodo} />
            </Card>

            {/*
              Cada posición, en su ficha: lo que vale, lo que ha ganado, a qué
              fecha está y su curva. Agrupadas por cuenta, como el prototipo.

              UNA curva por posición, no todas encima de la misma: superpuestas,
              cada una se dibuja sobre la escala de la más movida y un fondo que
              se mueve un 2 % al lado de otro que se mueve un 40 % sale plano.
              La comparación se conserva en el porcentaje de cada cabecera, que
              mira el mismo periodo.
            */}
            {[...porCuenta.entries()].map(([cuentaId, lista]) => (
              <section key={cuentaId} className="flex flex-col gap-2">
                <Eyebrow className="px-1">{nombreCuenta.get(cuentaId) ?? "Cuenta"}</Eyebrow>
                <ul className="flex flex-col gap-4">
                  {lista.map((posicion) => {
                    const r = rendimientoPorId.get(posicion.position_id);
                    const datos = datosFicha(posicion);
                    const suyos = (curvas ?? []).filter(
                      (c) => c.position_id === posicion.position_id,
                    );
                    const editar = (
                      <PositionDialog
                        position={posicion}
                        accounts={cuentas ?? []}
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Editar ${posicion.name}`}
                          >
                            <Icon name="pencil" size={18} />
                          </Button>
                        }
                      />
                    );
                    // La base del «+5 %»: la valoración del cierre anterior más
                    // lo aportado desde entonces, al coste (v_position_value).
                    const base = baseDeValoracion(
                      hoy,
                      valoracionesPorPosicion.get(posicion.position_id) ?? [],
                      aportesPorPosicion.get(posicion.position_id) ?? [],
                    );

                    const acciones = datos.seguida ? (
                      <>
                        <AjustarDialog
                          posicion={posicionSeguida(posicion, datos)}
                          trigger={
                            <Button
                              variant="secondary"
                              size="compact"
                              aria-label={`Ajustar ${posicion.name}`}
                            >
                              Ajustar
                            </Button>
                          }
                        />
                        <ValuationDialog
                          positionId={posicion.position_id}
                          positionName={posicion.name}
                          base={base}
                          respaldo={{
                            ultimoPrecio: datos.precioFecha ? shortDate(datos.precioFecha) : null,
                          }}
                          trigger={
                            <Button
                              variant="secondary"
                              size="compact"
                              aria-label={`Valorar a mano ${posicion.name}`}
                            >
                              Valorar a mano
                            </Button>
                          }
                        />
                        {editar}
                      </>
                    ) : (
                      <>
                        <ValuationDialog
                          positionId={posicion.position_id}
                          positionName={posicion.name}
                          base={base}
                          trigger={
                            <Button
                              variant="secondary"
                              size="compact"
                              aria-label={`Valorar ${posicion.name}`}
                            >
                              <Icon name="trending-up" size={16} />
                              Valorar
                            </Button>
                          }
                        />
                        <SeguirDialog
                          accounts={cuentas ?? []}
                          manuales={manuales}
                          posicionId={posicion.position_id}
                          trigger={
                            <Button
                              variant="secondary"
                              size="compact"
                              aria-label={`Seguir la cotización de ${posicion.name}`}
                            >
                              <Icon name="refresh-cw" size={15} />
                              Seguir cotización
                            </Button>
                          }
                        />
                        {editar}
                      </>
                    );

                    return (
                      <li key={posicion.position_id}>
                        <FichaPosicion
                          datos={datos}
                          acciones={acciones}
                          curva={
                            <PerformanceChart
                              puntos={suyos}
                              periodo={periodo}
                              rendimiento={r?.return_pct ?? null}
                              sincronizada={datos.seguida}
                            />
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            {archivadas.length > 0 ? (
              <div className="flex flex-col gap-2">
                <Eyebrow className="px-1">Archivadas</Eyebrow>
                <Card>
                  <ul>
                    {archivadas.map((posicion) => (
                      <li
                        key={posicion.position_id}
                        className="flex min-h-[52px] items-center gap-3 hair-t border-separator px-4 py-2 first:border-t-0 lg:px-5"
                      >
                        <span
                          className="size-[30px] shrink-0 rounded-full opacity-50"
                          style={{ background: posicion.color }}
                        />
                        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-muted">
                          {posicion.name}
                        </span>
                        <PositionDialog
                          position={posicion}
                          accounts={cuentas ?? []}
                          trigger={
                            <Button variant="ghost" size="icon" aria-label={`Editar ${posicion.name}`}>
                              <Icon name="pencil" size={18} />
                            </Button>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            ) : null}

            <p className="px-1 text-[13px] leading-[18px] text-muted">
              Para aportar dinero, registra un traspaso desde tu cuenta hacia la de inversión.{" "}
              <Link href="/movimientos/nuevo" className="font-semibold text-accent-text">
                Añadir traspaso
              </Link>
            </p>
          </>
        )}
      </PageBody>
    </>
  );
}
