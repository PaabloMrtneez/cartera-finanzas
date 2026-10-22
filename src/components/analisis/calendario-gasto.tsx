import { CalendarioCalor, type DiaCalor } from "@/components/ui/calendario-calor";
import { toIso, parseIsoDate } from "@/lib/dates";
import { CIFRA_LECTURA, contraMedia, diferenciasDiarias, mediaEntera } from "@/lib/graficos";
import { formatCents, formatSignedDelta } from "@/lib/money";

export type PuntoRitmo = { dia: number; actual_cents: number | null };

const DIA_LARGO = new Intl.DateTimeFormat("es-ES", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const largo = (iso: string) => DIA_LARGO.format(new Date(`${iso}T00:00:00Z`));

/**
 * El mes en un CALENDARIO DE CALOR: qué días gastas más.
 *
 * El gasto de cada día sale del acumulado de `month_pace` —el mismo que dibuja
 * el ritmo de Resumen—, restando el del día anterior (`diferenciasDiarias`):
 * enteros, y la suma de los días es exactamente el gasto neto del mes. Un día
 * en que una devolución supera a lo gastado sale en negativo: se pinta como
 * «nada» y la lectura lo explica.
 *
 * La cabecera, en reposo, da el día más caro; al tocar un día, el suyo contra
 * tu media diaria del mes.
 */
export function CalendarioGasto({
  puntos,
  mesIso,
  mes,
  hoy,
}: {
  puntos: PuntoRitmo[];
  /** «2026-10-01». */
  mesIso: string;
  /** «octubre». */
  mes: string;
  /** «2026-10-05». */
  hoy: string;
}) {
  const diarios = diferenciasDiarias(puntos.map((p) => p.actual_cents));
  const { year, month } = parseIsoDate(mesIso);
  const fechas = puntos.map((p) => toIso(year, month, p.dia));
  const conDato = diarios.filter((v): v is number => v !== null);

  if (conDato.length === 0 || conDato.every((v) => v === 0)) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        Todavía no hay gasto en {mes}. En cuanto lo haya, aquí verás qué días gastas más.
      </p>
    );
  }

  // La media de los días que ya han pasado, contando los de cero: un día sin
  // gastar también es un día del mes.
  const media = mediaEntera(conDato) ?? 0;
  let iMax = 0;
  diarios.forEach((v, i) => {
    if (v !== null && v >= (diarios[iMax] ?? 0)) iMax = i;
  });

  const dias: DiaCalor[] = puntos.map((p, i) => {
    const v = diarios[i];
    const rotulo = largo(fechas[i]);
    if (v === null) {
      return {
        fecha: fechas[i],
        valor: null,
        lectura: { rotulo, cifra: "—", detalle: "Aún no ha llegado" },
      };
    }
    if (v < 0) {
      return {
        fecha: fechas[i],
        valor: v,
        lectura: {
          rotulo,
          cifra: formatSignedDelta(v),
          detalle: "Te devolvieron más de lo que gastaste",
          tono: "bien",
        },
      };
    }
    const frente = media > 0 ? contraMedia(v, media) : null;
    return {
      fecha: fechas[i],
      valor: v,
      lectura: {
        rotulo,
        cifra: formatCents(v),
        detalle: v === 0 ? "Sin gasto" : frente?.texto,
        tono: v === 0 ? "bien" : frente?.tono,
      },
    };
  });

  const iHoy = fechas.indexOf(hoy);

  return (
    <div className="px-4 pb-4 lg:px-5">
      <CalendarioCalor
        dias={dias}
        hoy={iHoy === -1 ? undefined : iHoy}
        etiquetaAccesible={`Gasto de cada día de ${mes}.`}
        className="lg:max-w-[440px]"
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            Tu día más caro
          </span>
          <span className={CIFRA_LECTURA.compacto}>{formatCents(diarios[iMax] ?? 0)}</span>
          <span className="text-[14px] leading-5 text-muted tabular-nums first-letter:uppercase">
            {largo(fechas[iMax])} · media de {formatCents(media)} al día
          </span>
        </div>
      </CalendarioCalor>
    </div>
  );
}
