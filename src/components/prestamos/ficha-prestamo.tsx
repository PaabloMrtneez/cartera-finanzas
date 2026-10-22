import type { ReactNode } from "react";
import { CuadroAmortizacion } from "@/components/prestamos/cuadro-amortizacion";
import { AreaApilada, type CapaArea } from "@/components/ui/area-apilada";
import { Card } from "@/components/ui/card";
import { ArcoAnillo } from "@/components/ui/donut-aurora";
import { Icon } from "@/components/ui/icon";
import { LineaInteractiva, type SerieLinea } from "@/components/ui/linea-interactiva";
import { CIFRA_LECTURA, type LecturaPunto } from "@/lib/graficos";
import { formatCents, formatShare } from "@/lib/money";
import {
  fechaCuota,
  formatTipo,
  mesEje,
  mesLargo,
  parteDevuelta,
  puntosPasados,
  serieCapital,
  textoCuotas,
  type FilaCuadro,
} from "@/lib/prestamos-vista";
import type { LoanStatus } from "@/lib/types";

/** Lo que la ficha enseña de un préstamo: la fila de `v_loan_status`, con los tipos como texto. */
export type DatosPrestamo = {
  loan_id: string;
  name: string;
  status: LoanStatus;
  principal_cents: number;
  term_months: number;
  tin_texto: string | null;
  /** La TAE del contrato si la hay; si no, la calculada. */
  tae_efectiva_texto: string | null;
  tae_es_contrato: boolean;
  opening_fee_cents: number;
  charge_day: number;
  start_on: string;
  payment_cents: number;
  paid_count: number;
  principal_pending_cents: number;
  schedule_pending_cents: number;
  principal_paid_cents: number;
  interest_total_cents: number;
  interest_paid_cents: number;
  interest_pending_cents: number;
  fees_paid_cents: number;
  total_cost_cents: number;
  next_period: number | null;
  next_due_on: string | null;
  next_payment_cents: number | null;
  end_on: string;
  closed_on: string | null;
};

/**
 * Un préstamo en su ficha, con la gramática de Bolsa y Salud.
 *
 *  · Arriba, lo que es: el nombre, de dónde se paga y cuándo, y el PROGRESO
 *    en un anillo (cuánto capital llevas devuelto), con lo que lo explica.
 *  · La CURVA DEL CAPITAL PENDIENTE del inicio al fin: lo pagado en sólido y
 *    lo que queda, en discontinua, como proyección del cuadro. Al tocarla, la
 *    cifra de la cabecera pasa a ser la de esa cuota.
 *  · «Lo que pagas de más»: el coste total y, cuota a cuota, cuánto es interés
 *    y cuánto capital. Se ve que al principio casi todo es interés.
 *  · El cuadro de amortización, desplegable.
 *
 * En escritorio la ficha se parte en dos —los datos a la izquierda, las curvas
 * a la derecha, el cuadro debajo de todo— con el mismo orden del DOM que en
 * móvil: las columnas se colocan con `col-start`.
 */
export function FichaPrestamo({
  p,
  filas,
  cuentaPago,
  heroe,
  enTira = false,
  acciones,
}: {
  p: DatosPrestamo;
  filas: FilaCuadro[];
  cuentaPago: string;
  /** La curva héroe de la pantalla: dibuja su trazo al entrar. Solo una. */
  heroe: boolean;
  /** La tira de la cabecera ya enseña su cuota y su próxima (es el único activo). */
  enTira?: boolean;
  acciones: ReactNode;
}) {
  const activo = p.status === "ACTIVO";
  const devuelto = parteDevuelta(p.principal_paid_cents, p.principal_cents);
  const descuadre = p.status !== "LIQUIDADO" && p.principal_pending_cents !== p.schedule_pending_cents;

  return (
    <Card
      id={`prestamo-${p.loan_id}`}
      aria-label={p.name}
      className="scroll-mt-20 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
    >
      <div className="flex min-w-0 flex-col gap-4 px-[18px] pt-4 pb-4 lg:col-start-1 lg:row-start-1 lg:px-5 lg:pt-5">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <h3 className="text-[17px] leading-[22px] font-semibold break-words">{p.name}</h3>
            <p className="text-[13px] leading-[18px] text-muted tabular-nums">
              {activo
                ? `Se paga desde ${cuentaPago}, el día ${p.charge_day} de cada mes`
                : p.status === "LIQUIDADO"
                  ? `Liquidado${p.closed_on ? ` el ${fechaCuota(p.closed_on)}` : ""} · se pagaba desde ${cuentaPago}`
                  : `Ya no se sigue${p.closed_on ? ` desde el ${fechaCuota(p.closed_on)}` : ""} · se pagaba desde ${cuentaPago}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">{acciones}</div>
        </div>

        <Progreso p={p} devuelto={devuelto} />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          {/* Con un solo préstamo, la tira de arriba ya dice su cuota y su
              próxima: aquí serían las mismas cifras otra vez. */}
          {enTira ? null : (
            <>
              <Dato rotulo="Cuota al mes" valor={formatCents(p.payment_cents)} />
              <Dato
                rotulo={activo ? "Próxima cuota" : "Cuotas cobradas"}
                valor={
                  activo && p.next_due_on
                    ? fechaCuota(p.next_due_on)
                    : activo
                      ? "—"
                      : textoCuotas(p.paid_count, p.term_months)
                }
                detalle={
                  activo && p.next_payment_cents !== null && p.next_payment_cents !== p.payment_cents
                    ? formatCents(p.next_payment_cents)
                    : undefined
                }
              />
            </>
          )}
          <Dato rotulo="TIN" valor={formatTipo(p.tin_texto)} />
          <Dato
            rotulo={p.tae_es_contrato ? "TAE" : "TAE calculada"}
            valor={formatTipo(p.tae_efectiva_texto)}
          />
        </dl>

        {descuadre ? (
          <div role="status" className="flex items-start gap-3 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px]">
            <span className="mt-[1px] shrink-0 text-warning">
              <Icon name="triangle-alert" size={16} />
            </span>
            <span className="flex flex-col gap-1">
              <span className="font-semibold text-fg tabular-nums">
                Debes {formatCents(p.principal_pending_cents)}, y el cuadro dice{" "}
                {formatCents(p.schedule_pending_cents)}
              </span>
              <span className="text-muted">
                Alguien ha movido dinero a mano en la cuenta del préstamo, o se ha cambiado una cuota (una
                amortización parcial, por ejemplo). Las cuotas siguen el cuadro original; la deuda, lo
                apuntado.
              </span>
            </span>
          </div>
        ) : null}
      </div>

      <div className="hair-t border-hairline px-[18px] pt-4 pb-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-t-0 lg:hair-l lg:px-5 lg:pt-5">
        <CurvaCapital p={p} filas={filas} heroe={heroe} />
      </div>

      <div className="hair-t border-hairline px-[18px] pt-4 pb-4 lg:col-start-1 lg:row-start-2 lg:px-5">
        <Intereses p={p} filas={filas} />
      </div>

      <div className="hair-t border-hairline lg:col-span-2 lg:row-start-3">
        <CuadroAmortizacion filas={filas} nombre={p.name} proxima={activo ? p.next_period : null} />
      </div>
    </Card>
  );
}

function Dato({ rotulo, valor, detalle }: { rotulo: string; valor: string; detalle?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[13px] leading-[18px] text-muted">{rotulo}</dt>
      <dd className="text-[15px] leading-5 font-semibold tabular-nums">
        {valor}
        {detalle ? <span className="font-normal text-muted"> · {detalle}</span> : null}
      </dd>
    </div>
  );
}

/**
 * El anillo de lo devuelto: el capital pagado sobre el prestado, como los de
 * Actividad (el carril del mismo color, apagado). La lectura va en el centro y
 * lo que la explica, al lado: nada de rótulos alrededor del anillo.
 */
function Progreso({ p, devuelto }: { p: DatosPrestamo; devuelto: number }) {
  return (
    <div className="flex items-center gap-4">
      <div className="relative size-[104px] shrink-0">
        <svg viewBox="0 0 200 200" className="block size-full" aria-hidden>
          <circle cx={100} cy={100} r={86} fill="none" stroke="var(--accent)" strokeOpacity={0.16} strokeWidth={20} />
          <ArcoAnillo radio={86} grosor={20} desde={0} largo={Math.max(devuelto, devuelto > 0 ? 1 : 0)} color="var(--accent)" />
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="cifra text-[22px] leading-7 font-medium">{formatShare(devuelto)}</span>
          <span className="text-[13px] leading-[18px] text-muted">devuelto</span>
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-[2px]">
        <span className="text-[17px] leading-[22px] font-semibold tabular-nums">
          {textoCuotas(p.paid_count, p.term_months)}
        </span>
        <span className="text-[13px] leading-[18px] text-muted tabular-nums">
          {formatCents(p.principal_paid_cents)} devueltos de {formatCents(p.principal_cents)}
        </span>
        <span className="text-[13px] leading-[18px] text-muted">
          {p.status === "ACTIVO" ? `Termina en ${mesLargo(p.end_on)}` : `Iba hasta ${mesLargo(p.end_on)}`}
        </span>
      </div>
    </div>
  );
}

/**
 * EL CAPITAL PENDIENTE, del día de la firma al de la última cuota. Lo que ya
 * pasó va en el trazo del espectro; lo que queda, en la discontinua de la
 * proyección, que arranca en el último punto real. MÁX y HOY en oro.
 *
 * La cifra de la cabecera es la deuda REAL (el saldo de la cuenta del
 * préstamo); la curva es la del cuadro. Si no cuadran, la ficha lo avisa.
 */
function CurvaCapital({ p, filas, heroe }: { p: DatosPrestamo; filas: FilaCuadro[]; heroe: boolean }) {
  const puntos = serieCapital(p.principal_cents, p.start_on, filas);
  const pasados = Math.max(puntosPasados(puntos), 1);
  const activo = p.status === "ACTIVO";
  const n = p.term_months;

  const principal: SerieLinea = {
    id: "pagado",
    nombre: "Capital pendiente",
    valores: puntos.map((pt, i) => (i < pasados ? pt.pendiente : null)),
    textos: puntos.map((pt) => formatCents(pt.pendiente)),
  };
  const series: SerieLinea[] = [principal];
  if (activo && pasados < puntos.length) {
    series.push({
      id: "queda",
      nombre: "Lo que queda, según el cuadro",
      valores: puntos.map((pt, i) => (i >= pasados - 1 ? pt.pendiente : null)),
      textos: principal.textos,
      proyeccion: true,
    });
  }

  const lecturas: LecturaPunto[] = puntos.map((pt, i) => ({
    rotulo: pt.periodo === 0 ? `La firma · ${fechaCuota(pt.fecha)}` : `Cuota ${pt.periodo} de ${n} · ${fechaCuota(pt.fecha)}`,
    cifra: formatCents(pt.pendiente),
    detalle:
      pt.periodo === 0
        ? "Todo por devolver"
        : `${i < pasados ? "Devueltos" : "Habrás devuelto"} ${formatCents(p.principal_cents - pt.pendiente)}`,
    tono: "neutro",
  }));

  return (
    <LineaInteractiva
      series={series}
      lecturas={lecturas}
      ejeX={puntos.map((pt) => mesEje(pt.fecha))}
      altoBase={150}
      claseAlto="h-[150px] lg:h-[300px]"
      anotaciones
      heroe={heroe}
      leyendaProyeccion={series.length > 1 ? "Lo que queda por devolver, según el cuadro" : undefined}
      etiquetaAccesible={`Capital pendiente de ${p.name}, de ${fechaCuota(p.start_on)} a ${fechaCuota(p.end_on)}. Recórrelo con las flechas.`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-[13px] leading-[18px] font-semibold text-muted">Capital pendiente</span>
        <span className={CIFRA_LECTURA.normal}>{formatCents(p.principal_pending_cents)}</span>
        <span className="text-[14px] leading-5 text-muted tabular-nums">
          {p.principal_pending_cents === 0
            ? "No queda nada por devolver."
            : `De ${formatCents(p.principal_cents)} que te prestaron.`}
        </span>
      </div>
    </LineaInteractiva>
  );
}

/**
 * «LO QUE PAGAS DE MÁS»: el coste del préstamo (intereses y comisiones) y, en
 * un área apilada cuota a cuota, cuánto de cada una es interés y cuánto
 * capital. La cuota es la misma todos los meses, pero al principio casi toda
 * es interés: es lo que se ve. Lo que aún no ha pasado se apaga.
 */
function Intereses({ p, filas }: { p: DatosPrestamo; filas: FilaCuadro[] }) {
  const pagadas = filas.filter((f) => f.state === "COBRADA" || f.state === "PREVIA").length;
  const parteIntereses =
    p.interest_total_cents > 0 ? Math.min((p.interest_paid_cents / p.interest_total_cents) * 100, 100) : 0;
  const comisiones = p.fees_paid_cents;

  const cabecera = (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] leading-[18px] font-semibold text-muted">Lo que pagas de más</span>
      <span className={CIFRA_LECTURA.compacto}>{formatCents(p.total_cost_cents)}</span>
      <span className="text-[14px] leading-5 text-muted tabular-nums">
        {p.status === "ACTIVO"
          ? `En intereses${comisiones > 0 ? " y comisiones" : ""}, si lo pagas hasta el final.`
          : `En intereses${comisiones > 0 ? " y comisiones" : ""}.`}
      </span>
    </div>
  );

  const barra = (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] leading-[18px] text-muted tabular-nums">
        <span className="font-semibold text-fg">{formatCents(p.interest_paid_cents)}</span> de intereses
        pagados, de {formatCents(p.interest_total_cents)} del cuadro
        {comisiones > 0 ? ` · ${formatCents(comisiones)} de comisiones` : ""}
      </p>
      <span className="relative block h-[6px] overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <span
          className="absolute inset-y-0 left-0 origin-left animate-bar-fill rounded-full bg-expense"
          style={{ width: `${parteIntereses}%` }}
        />
      </span>
    </div>
  );

  if (p.interest_total_cents === 0 || filas.length < 2) {
    return (
      <div className="flex flex-col gap-4">
        {cabecera}
        {p.interest_total_cents === 0 ? (
          <p className="text-[13px] leading-[18px] text-muted">Con un TIN del 0 % no pagas intereses.</p>
        ) : (
          barra
        )}
      </div>
    );
  }

  const capas: CapaArea[] = [
    {
      id: "intereses",
      nombre: "Intereses",
      color: "var(--expense)",
      valores: filas.map((f) => f.interest_cents),
      textos: filas.map((f) => formatCents(f.interest_cents)),
      reposo: formatCents(p.interest_total_cents),
    },
    {
      id: "capital",
      nombre: "Capital",
      color: "var(--aurora-3)",
      valores: filas.map((f) => f.principal_cents),
      textos: filas.map((f) => formatCents(f.principal_cents)),
      reposo: formatCents(p.principal_cents),
    },
  ];
  const lecturas: LecturaPunto[] = filas.map((f) => ({
    rotulo: `Cuota ${f.period} · ${fechaCuota(f.due_on)}`,
    cifra: formatCents(f.payment_cents),
    detalle: `${formatCents(f.interest_cents)} de intereses (${formatShare(
      f.payment_cents > 0 ? (f.interest_cents / f.payment_cents) * 100 : 0,
    )})`,
    tono: "neutro",
  }));

  return (
    <div className="flex flex-col gap-4">
      <AreaApilada
        capas={capas}
        lecturas={lecturas}
        ejeX={filas.map((f) => mesEje(f.due_on))}
        altoBase={120}
        claseAlto="h-[120px] lg:h-[150px]"
        presente={p.status === "ACTIVO" ? pagadas - 1 : undefined}
        etiquetaAccesible={`Intereses y capital de cada cuota de ${p.name}.`}
      >
        {cabecera}
      </AreaApilada>
      {barra}
    </div>
  );
}
