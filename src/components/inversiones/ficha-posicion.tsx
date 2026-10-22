import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { shortDate } from "@/lib/dates";
import {
  NOMBRE_TIPO,
  formatCambio,
  formatParticipaciones,
  formatPrecio,
  type TipoInstrumento,
} from "@/lib/mercado";
import { formatCents, formatPercent, formatShare, formatSignedDelta } from "@/lib/money";

/**
 * Lo que la ficha enseña de una posición. Viene de `v_position_market`, con
 * participaciones, precio y cambio pedidos como TEXTO (`::text`): numeric llega
 * como doble por JSON y aquí se enseñan tal cual los guarda la base.
 */
export type DatosFicha = {
  position_id: string;
  name: string;
  color: string;
  seguida: boolean;
  instrumento: string | null;
  simbolo: string | null;
  tipo: TipoInstrumento | null;
  divisa: string | null;
  mercado: string | null;
  unidades: string | null;
  unidadesEstimadas: boolean;
  precio: string | null;
  precioFecha: string | null;
  cambio: string | null;
  cambioFecha: string | null;
  value_cents: number;
  fuente: "MERCADO" | "RESPALDO" | "MANUAL";
  valuedOn: string | null;
  sinPrecio: boolean;
  sinValorar: boolean;
  contributed_cents: number;
  gain_cents: number;
  return_pct: number | null;
  diasSinPrecio: number | null;
  desactualizado: boolean;
  /** Qué parte de la cartera es, en %. */
  parte: number;
};

/**
 * Una posición, como en Bolsa de Apple: el nombre y, discreto, qué sigue; lo
 * que vale en euros; lo que ha ganado en € y en %; participaciones × precio; a
 * qué fecha está; y su curva.
 *
 * La fecha se dice SIEMPRE, y lo raro con icono y palabras, no solo con color:
 * un precio que no llega, una valoración a mano que manda, un instrumento que
 * aún espera su primer precio. Una posición manual se lee igual que siempre.
 *
 * En escritorio la ficha se parte en dos: los datos a la izquierda y la curva a
 * la derecha, en el mismo orden del DOM que en móvil (datos, luego curva).
 */
export function FichaPosicion({
  datos: d,
  curva,
  acciones,
}: {
  datos: DatosFicha;
  /** La curva de la posición (PerformanceChart), ya montada. */
  curva: ReactNode;
  /** Los botones de la ficha: ajustar, valorar, seguir, editar. */
  acciones: ReactNode;
}) {
  const respaldo = d.fuente === "RESPALDO";
  const hayCoste = d.contributed_cents > 0;
  const enEuros = d.divisa === null || d.divisa === "EUR";

  return (
    <Card className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="flex min-w-0 flex-col gap-3 px-4 pt-4 pb-4 lg:px-5 lg:pt-5 lg:pb-5">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-[3px] size-[14px] shrink-0 rounded-full"
            style={{ background: d.color }}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <h3 className="text-[17px] leading-[22px] font-semibold">{d.name}</h3>
            <p className="text-[13px] leading-[18px] text-muted">
              {d.seguida && d.instrumento ? (
                <>
                  <span className="break-words">{d.instrumento}</span>
                  <span className="tabular-nums">
                    {" · "}
                    {d.simbolo}
                    {d.tipo ? ` · ${NOMBRE_TIPO[d.tipo]}` : ""}
                  </span>
                </>
              ) : (
                "Valoración a mano"
              )}
              <span className="tabular-nums"> · {formatShare(d.parte)} de la cartera</span>
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="cifra text-[32px] leading-[38px] lg:text-[36px] lg:leading-[42px]">
              {formatCents(d.value_cents)}
            </span>
            {respaldo ? (
              <span className="inline-flex items-center gap-1 rounded-xs bg-surface-2 px-[6px] py-[1px] text-[13px] leading-[18px] font-semibold text-muted">
                <Icon name="pencil" size={12} />a mano
              </span>
            ) : null}
          </p>
          <p className="text-[14px] leading-5 tabular-nums">
            {hayCoste ? (
              <>
                <span
                  className={cn(
                    "font-semibold",
                    d.gain_cents > 0 ? "text-income" : d.gain_cents < 0 ? "text-expense" : "",
                  )}
                >
                  {formatSignedDelta(d.gain_cents)}
                  {d.return_pct !== null ? ` · ${formatPercent(Number(d.return_pct), 2)}` : ""}
                </span>
                <span className="text-muted"> sobre {formatCents(d.contributed_cents)} aportados</span>
              </>
            ) : (
              <span className="text-muted">Sin aportaciones apuntadas: no hay ganancia que medir.</span>
            )}
          </p>
        </div>

        {d.seguida && d.unidades ? (
          <p className="flex flex-col text-[14px] leading-5 text-muted tabular-nums">
            <span>
              {formatParticipaciones(d.unidades, d.tipo)}
              {d.precio && d.divisa ? ` × ${formatPrecio(d.precio, d.divisa)}` : ""}
            </span>
            {!enEuros && d.cambio && d.divisa ? (
              <span>
                {formatCambio(d.cambio, d.divisa)}
                {d.cambioFecha ? ` · BCE, ${shortDate(d.cambioFecha)}` : " · BCE"}
              </span>
            ) : null}
          </p>
        ) : null}

        <Estado d={d} />

        <div className="mt-1 flex flex-wrap items-center gap-2">{acciones}</div>
      </div>

      <div className="hair-t border-hairline pt-4 lg:border-t-0 lg:hair-l lg:pt-5">{curva}</div>
    </Card>
  );
}

/** A qué fecha está la cifra, y lo raro con icono y palabras. */
function Estado({ d }: { d: DatosFicha }) {
  const linea = (icono: "clock" | "hourglass" | "pencil", texto: ReactNode) => (
    <p className="flex items-start gap-2 text-[13px] leading-[18px] text-muted tabular-nums">
      <span className="mt-[1px] shrink-0">
        <Icon name={icono} size={14} />
      </span>
      <span>{texto}</span>
    </p>
  );

  if (!d.seguida) {
    return linea(
      "clock",
      d.valuedOn
        ? `Valorada a mano el ${shortDate(d.valuedOn)}`
        : "Sin valorar todavía: cuenta lo aportado.",
    );
  }

  if (d.sinPrecio) {
    return linea(
      "hourglass",
      <>
        <span className="font-semibold text-fg">Esperando el primer precio.</span> Hasta que llegue,
        se valora como una posición manual.
      </>,
    );
  }

  const estimadas = d.unidadesEstimadas ? (
    <p className="text-[13px] leading-[18px] text-muted">
      Alguna aportación lleva las participaciones estimadas con el precio de su día. Puedes
      corregirlas en «Ajustar».
    </p>
  ) : null;

  if (d.fuente === "RESPALDO") {
    return (
      <>
        {linea(
          "pencil",
          <>
            <span className="font-semibold text-fg">
              Valoración a mano del {d.valuedOn ? shortDate(d.valuedOn) : "—"}.
            </span>{" "}
            Manda hasta que llegue un precio de Yahoo de ese día o posterior
            {d.precioFecha ? `; el último es del ${shortDate(d.precioFecha)}` : ""}.
          </>,
        )}
        {estimadas}
      </>
    );
  }

  if (d.desactualizado && d.precioFecha) {
    return (
      <>
        <div
          role="status"
          className="flex items-start gap-3 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px]"
        >
          <span className="mt-[1px] shrink-0 text-warning">
            <Icon name="triangle-alert" size={16} />
          </span>
          <span className="flex flex-col gap-1">
            <span className="font-semibold text-fg">
              Precio sin actualizar desde el {shortDate(d.precioFecha)}
            </span>
            <span className="text-muted tabular-nums">
              {d.diasSinPrecio !== null ? `Lleva ${d.diasSinPrecio} días hábiles sin llegar. ` : ""}
              Si sabes lo que vale, mete una valoración a mano: mandará hasta que vuelva el precio.
            </span>
          </span>
        </div>
        {estimadas}
      </>
    );
  }

  return (
    <>
      {linea("clock", d.precioFecha ? `Actualizado al ${shortDate(d.precioFecha)}` : "Sin fecha")}
      {estimadas}
    </>
  );
}
