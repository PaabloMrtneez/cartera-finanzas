import { AreaApilada, type CapaArea } from "@/components/ui/area-apilada";
import {
  rotuloCorto,
  rotuloLargo,
  type Granularidad,
} from "@/components/patrimonio/net-worth-chart";
import { CIFRA_LECTURA, type LecturaPunto } from "@/lib/graficos";
import { formatCents, formatShare } from "@/lib/money";

export type PuntoPartes = {
  fecha: string;
  net_worth_cents: number;
  cash_cents: number;
  invested_cents: number;
  idle_cents: number;
  /** La deuda de los préstamos (≤ 0): el saldo de sus cuentas. */
  debt_cents: number;
};

/**
 * Lo que TIENES, sin restar lo que debes: la suma de las capas positivas. Es
 * la base de los porcentajes. Contra el patrimonio NETO, quien arrastra una
 * tarjeta en rojo leería «240 % invertido», que no significa nada.
 */
function activos(p: PuntoPartes): number {
  return Math.max(p.cash_cents, 0) + Math.max(p.invested_cents, 0) + Math.max(p.idle_cents, 0);
}

/** Qué parte de lo que tienes está invertida, o null si no tienes nada. */
function parteDe(valor: number, p: PuntoPartes): number | null {
  const base = activos(p);
  if (base <= 0) return null;
  return (Math.max(valor, 0) / base) * 100;
}
const parteInvertida = (p: PuntoPartes) => parteDe(p.invested_cents, p);

const textoParte = (v: number | null) => (v === null ? "—" : formatShare(v));

/**
 * CAJA FRENTE A INVERTIDO: de qué está hecho el patrimonio a lo largo del
 * mismo rango que la curva de arriba. Las capas apiladas —en cuentas,
 * invertido, la caja sin desplegar de las cuentas de inversión y, por debajo
 * del cero, la deuda de los préstamos— suman exactamente el patrimonio neto
 * de cada punto (`net_worth_daily` y `net_worth_monthly` lo garantizan).
 *
 * La curva de arriba ya dice CUÁNTO; esta dice CÓMO. Por eso su cifra no es un
 * importe —ese ya está en la losa— sino la parte invertida, que es la pregunta
 * de este gráfico: ¿cuánto de lo que tengo está trabajando? Se mide sobre lo
 * que TIENES (las capas positivas), no sobre el neto. Al leer un punto, la
 * cabecera da esa parte y la leyenda, el importe de cada capa.
 *
 * Una capa siempre a cero no se dibuja; sin nada invertido en todo el rango,
 * no hay gráfico (sería la misma curva de arriba pintada otra vez).
 */
export function CajaInvertido({
  puntos,
  granularidad,
}: {
  puntos: PuntoPartes[];
  granularidad: Granularidad;
}) {
  const g = granularidad;
  const hayInversion = puntos.some((p) => p.invested_cents !== 0 || p.idle_cents !== 0);
  const hayDeuda = puntos.some((p) => p.debt_cents !== 0);
  if (puntos.length < 2 || (!hayInversion && !hayDeuda)) {
    return null;
  }

  const ultimo = puntos[puntos.length - 1];
  const primero = puntos[0];
  const ahora = parteInvertida(ultimo);
  const antes = parteInvertida(primero);

  const todas: (CapaArea & { usada: boolean })[] = [
    {
      id: "caja",
      nombre: "En cuentas",
      color: "var(--aurora-3)",
      valores: puntos.map((p) => p.cash_cents),
      textos: puntos.map((p) => formatCents(p.cash_cents)),
      reposo: textoParte(parteDe(ultimo.cash_cents, ultimo)),
      usada: true,
    },
    {
      id: "invertido",
      nombre: "Invertido",
      color: "var(--aurora-1)",
      valores: puntos.map((p) => p.invested_cents),
      textos: puntos.map((p) => formatCents(p.invested_cents)),
      reposo: textoParte(ahora),
      usada: puntos.some((p) => p.invested_cents !== 0),
    },
    {
      id: "sin-desplegar",
      nombre: "Sin desplegar",
      color: "var(--aurora-otros)",
      valores: puntos.map((p) => p.idle_cents),
      textos: puntos.map((p) => formatCents(p.idle_cents)),
      reposo: textoParte(parteDe(ultimo.idle_cents, ultimo)),
      usada: puntos.some((p) => p.idle_cents !== 0),
    },
    {
      // La deuda de los préstamos crece HACIA ABAJO desde el cero (`apilar`):
      // no se come lo que tienes, se ve debajo. En el coral del gasto.
      id: "deuda",
      nombre: "Deuda",
      color: "var(--expense)",
      valores: puntos.map((p) => p.debt_cents),
      textos: puntos.map((p) => formatCents(p.debt_cents)),
      reposo: formatCents(ultimo.debt_cents),
      usada: hayDeuda,
    },
  ];
  const capas = todas.filter((c) => c.usada);

  /*
    Sin nada invertido, la pregunta de este gráfico deja de ser «cuánto está
    trabajando» y pasa a ser «cuánto debo frente a lo que tengo»: la cifra es
    entonces la deuda sobre lo que tienes.
  */
  const parteDeuda = (p: PuntoPartes) => {
    const base = activos(p);
    return base > 0 ? (Math.abs(p.debt_cents) / base) * 100 : null;
  };
  const lecturas: LecturaPunto[] = puntos.map((p) => ({
    rotulo: rotuloLargo(p.fecha, g),
    cifra: textoParte(hayInversion ? parteInvertida(p) : parteDeuda(p)),
    detalle: hayInversion
      ? `invertido de ${formatCents(activos(p))} que tienes`
      : `debes ${formatCents(Math.abs(p.debt_cents))} de ${formatCents(activos(p))} que tienes`,
    tono: "neutro",
  }));
  const ahoraCifra = hayInversion ? ahora : parteDeuda(ultimo);
  const antesCifra = hayInversion ? antes : parteDeuda(primero);

  const n = puntos.length;
  const marcasX =
    g === "dia" ? [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1] : undefined;

  return (
    <div className="px-[18px] pb-4 lg:px-5">
      <AreaApilada
        capas={capas}
        lecturas={lecturas}
        ejeX={puntos.map((p) => rotuloCorto(p.fecha, g))}
        marcasX={marcasX}
        altoBase={150}
        claseAlto="h-[150px] lg:h-[200px]"
        etiquetaAccesible={`Patrimonio por partes, de ${rotuloLargo(primero.fecha, g)} a ${rotuloLargo(ultimo.fecha, g)}.`}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            {hayInversion ? "Invertido, de lo que tienes" : "Deuda, frente a lo que tienes"}
          </span>
          <span className={CIFRA_LECTURA.compacto}>{textoParte(ahoraCifra)}</span>
          <span className="text-[14px] leading-5 text-muted tabular-nums">
            {antesCifra !== null && ahoraCifra !== null
              ? `${textoParte(antesCifra)} al principio del periodo`
              : hayInversion
                ? "Lo que está trabajando, frente a lo que espera."
                : "Lo que debes de tus préstamos, frente a lo que tienes."}
          </span>
        </div>
      </AreaApilada>
    </div>
  );
}
