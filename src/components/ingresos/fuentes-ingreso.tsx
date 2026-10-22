import { DonutAurora, type SectorDonut } from "@/components/ui/donut-aurora";
import { COLOR_OTROS, ESPECTRO_AURORA, MAX_SEGMENTOS } from "@/lib/aurora";
import { variacionImporte } from "@/lib/graficos";
import { formatCents, formatShare, formatSignedDelta } from "@/lib/money";

export type Fuente = {
  category_id: string | null;
  name: string;
  income_cents: number;
  previo_cents: number;
  recurrente_cents: number;
  cuantos: number;
};

const ingresosTexto = (n: number) => `${n} ${n === 1 ? "ingreso" : "ingresos"}`;

/**
 * DE DÓNDE ENTRA EL DINERO: el ingreso real del mes por fuente (categoría), en
 * el donut Aurora. Pocas partes y un total que importa —es el caso del donut—:
 * el total en el centro y, al tocar un sector, esa fuente.
 *
 * Es ingreso REAL (`income_breakdown`): un reembolso no es un ingreso —abarata
 * un gasto— y un traspaso tampoco. La suma es el ingreso del mes de Resumen.
 *
 * La lista de debajo es la leyenda, con la MUESCA del mes anterior y lo que ha
 * cambiado: una nómina que llegó más corta se ve sin buscarla. Cuánto de cada
 * fuente es fijo (generado por un ingreso recurrente) se lee al tocarla.
 */
export function FuentesIngreso({
  fuentes,
  mes,
  mesPrevio,
  mesIso,
}: {
  fuentes: Fuente[];
  mes: string;
  mesPrevio: string;
  mesIso: string;
}) {
  const conAlgo = fuentes.filter((f) => f.income_cents > 0 || f.previo_cents > 0);
  const total = conAlgo.reduce((s, f) => s + Math.max(f.income_cents, 0), 0);
  const totalPrevio = conAlgo.reduce((s, f) => s + Math.max(f.previo_cents, 0), 0);

  if (total <= 0) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        {totalPrevio > 0
          ? `En ${mes} no hay ingresos apuntados; en ${mesPrevio} entraron ${formatCents(totalPrevio)}.`
          : `Ni en ${mes} ni en ${mesPrevio} hay ingresos apuntados. Cuando entre el primero, aquí verás de dónde viene cada euro.`}
      </p>
    );
  }

  const orden = [...conAlgo].sort(
    (a, b) => b.income_cents - a.income_cents || b.previo_cents - a.previo_cents,
  );
  const visibles = orden.length <= MAX_SEGMENTOS ? orden : orden.slice(0, MAX_SEGMENTOS - 1);
  const resto = orden.length <= MAX_SEGMENTOS ? [] : orden.slice(MAX_SEGMENTOS - 1);

  const sector = (
    id: string,
    nombre: string,
    color: string,
    f: Omit<Fuente, "category_id" | "name">,
  ): SectorDonut => {
    const share = formatShare((Math.max(f.income_cents, 0) / total) * 100);
    const cambio = variacionImporte(f.previo_cents, f.income_cents);
    // El centro es estrecho: dos líneas cortas. Lo fijo (generado por un
    // ingreso recurrente) se dice con una palabra; el detalle, en la lista.
    const fijo =
      f.recurrente_cents > 0
        ? f.recurrente_cents === f.income_cents
          ? "fijo"
          : "en parte fijo"
        : ingresosTexto(f.cuantos);
    const delta = f.income_cents - f.previo_cents;
    return {
      id,
      nombre,
      color,
      valor: Math.max(f.income_cents, 0),
      texto: formatCents(f.income_cents),
      share,
      previo: f.previo_cents > 0 ? f.previo_cents : null,
      variacion:
        f.income_cents === f.previo_cents
          ? { texto: "Sin cambio", tono: "neutro" }
          : {
              texto: formatSignedDelta(f.income_cents - f.previo_cents),
              tono: cambio.tono,
            },
      href: id === "otras" ? undefined : `/movimientos?mes=${mesIso}&tipo=INCOME&categoria=${id}`,
      lectura: {
        rotulo: nombre,
        cifra: formatCents(f.income_cents),
        lineas: [
          { texto: `${share} · ${fijo}` },
          delta === 0
            ? { texto: `Igual que en ${mesPrevio}` }
            : { texto: `${formatSignedDelta(delta)} frente a ${mesPrevio}`, tono: cambio.tono },
        ],
      },
    };
  };

  const sectores = visibles.map((f, i) =>
    sector(f.category_id ?? "sin", f.name, ESPECTRO_AURORA[i], f),
  );
  if (resto.length > 0) {
    const suma = (k: "income_cents" | "previo_cents" | "recurrente_cents" | "cuantos") =>
      resto.reduce((s, f) => s + f[k], 0);
    sectores.push(
      sector("otras", `Otras · ${resto.length}`, COLOR_OTROS, {
        income_cents: suma("income_cents"),
        previo_cents: suma("previo_cents"),
        recurrente_cents: suma("recurrente_cents"),
        cuantos: suma("cuantos"),
      }),
    );
  }

  const cambioTotal = variacionImporte(totalPrevio, total);
  const n = conAlgo.filter((f) => f.income_cents > 0).length;

  return (
    <DonutAurora
      sectores={sectores}
      etiquetaAccesible={`Ingresos de ${mes} por fuente.`}
      centro={{
        rotulo: `${n} ${n === 1 ? "fuente" : "fuentes"}`,
        cifra: formatCents(total),
        lineas:
          totalPrevio > 0 ? [{ texto: `${cambioTotal.texto}`, tono: cambioTotal.tono }] : undefined,
      }}
    />
  );
}
