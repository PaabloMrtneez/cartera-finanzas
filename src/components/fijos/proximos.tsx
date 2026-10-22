import { Card, CardHeader } from "@/components/ui/card";
import { LineaTiempo, type HitoTiempo, type MarcaTiempo } from "@/components/ui/linea-tiempo";
import { cn } from "@/lib/cn";
import { addDays, groupHeading, monthStart, shiftMonth } from "@/lib/dates";
import { CIFRA_LECTURA, listaNombres } from "@/lib/graficos";
import { formatCents } from "@/lib/money";
import { diasEntre } from "@/lib/rangos";

/** Un cargo o un ingreso que viene: lo que devuelven `upcoming_charges` y
 *  `upcoming_income`, ya con los nombres de campo comunes. */
export type Proximo = {
  id: string;
  description: string;
  amount_cents: number;
  fecha: string;
};

const PALABRAS = {
  gasto: { uno: "cargo", varios: "cargos", Varios: "Cargos" },
  ingreso: { uno: "ingreso", varios: "ingresos", Varios: "Ingresos" },
} as const;

const DIA = new Intl.DateTimeFormat("es-ES", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const DIA_CORTO = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const MES_CORTO = new Intl.DateTimeFormat("es-ES", {
  month: "short",
  timeZone: "UTC",
});
const fecha = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * Lo que viene en una LÍNEA DE TIEMPO de 60 días: cada día con cargos (o con
 * ingresos) es una marca cuya altura es lo que se mueve ese día. Se ve de un
 * vistazo si los cargos se amontonan a primeros de mes o están repartidos, y si
 * caen antes o después de la nómina, que es lo que decide si un mes va justo.
 *
 * Sirve a los dos grupos de Fijos: los cargos de los gastos fijos y los
 * ingresos fijos que van a entrar. Lo del mismo día va en UNA marca (la suma),
 * y su lectura dice cuáles son. El total de los 60 días es la cifra en reposo.
 */
export function ProximosFijos({
  proximos,
  tipo,
  hoy,
  dias = 60,
}: {
  proximos: Proximo[];
  tipo: "gasto" | "ingreso";
  hoy: string;
  dias?: number;
}) {
  const palabra = PALABRAS[tipo];
  const porDia = new Map<string, Proximo[]>();
  for (const c of proximos) {
    const lista = porDia.get(c.fecha) ?? [];
    lista.push(c);
    porDia.set(c.fecha, lista);
  }
  const fechas = [...porDia.keys()].sort();
  if (fechas.length === 0) {
    return (
      <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
        No hay {palabra.varios} en los próximos {dias} días.
      </p>
    );
  }

  const cuando = (iso: string) => {
    const d = diasEntre(hoy, iso);
    const base = DIA.format(fecha(iso));
    return d === 0 ? `Hoy, ${base}` : d === 1 ? `Mañana, ${base}` : base;
  };

  const marcas: MarcaTiempo[] = fechas.map((iso) => {
    const lista = porDia.get(iso) ?? [];
    const suma = lista.reduce((s, c) => s + c.amount_cents, 0);
    return {
      clave: iso,
      dia: diasEntre(hoy, iso),
      valor: suma,
      lectura: {
        rotulo: cuando(iso),
        cifra: formatCents(suma),
        detalle: listaNombres(lista.map((c) => c.description)),
        tono: "neutro",
      },
    };
  });

  // Los comienzos de mes dentro del tramo, con su nombre. El que cae pegado a
  // hoy no se rotula: pisaría «HOY».
  const hitos: HitoTiempo[] = [];
  for (let m = shiftMonth(monthStart(hoy), 1); diasEntre(hoy, m) <= dias; m = shiftMonth(m, 1)) {
    const d = diasEntre(hoy, m);
    if (d >= 6)
      hitos.push({
        dia: d,
        texto: MES_CORTO.format(fecha(m)).replace(".", ""),
      });
  }

  const total = proximos.reduce((s, c) => s + c.amount_cents, 0);
  const primero = porDia.get(fechas[0]) ?? [];

  return (
    <div className="px-4 pb-4 lg:px-5">
      <LineaTiempo
        dias={dias}
        marcas={marcas}
        hitos={hitos}
        altoBase={96}
        claseAlto="h-[96px] lg:h-[120px]"
        etiquetaAccesible={`${palabra.Varios} de los próximos ${dias} días, hasta el ${DIA_CORTO.format(fecha(addDays(hoy, dias)))}.`}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-[18px] font-semibold text-muted">
            En los próximos {dias} días
          </span>
          <span className={CIFRA_LECTURA.compacto}>{formatCents(total)}</span>
          <span className="text-[14px] leading-5 text-muted tabular-nums">
            {proximos.length} {proximos.length === 1 ? palabra.uno : palabra.varios} · el próximo,{" "}
            {listaNombres(
              primero.map((c) => c.description),
              1,
            )}{" "}
            el {DIA_CORTO.format(fecha(fechas[0])).replace(".", "")}
          </span>
        </div>
      </LineaTiempo>
    </div>
  );
}

/**
 * La tarjeta de lo que viene: la línea de tiempo en las dos anchuras y, en
 * escritorio, donde cabe, la lista día a día debajo.
 */
export function TarjetaProximos({
  titulo,
  proximos,
  tipo,
  hoy,
}: {
  titulo: string;
  proximos: Proximo[];
  tipo: "gasto" | "ingreso";
  hoy: string;
}) {
  return (
    <Card>
      <CardHeader title={titulo} />
      <ProximosFijos proximos={proximos} tipo={tipo} hoy={hoy} />
      <ul className="hidden lg:block">
        {proximos.map((p, index) => (
          <li
            key={`${p.id}-${p.fecha}-${index}`}
            className="flex min-h-12 items-center gap-3 hair-t border-separator px-[18px] py-2"
          >
            <span className="w-48 shrink-0 truncate text-[14px] text-muted tabular-nums">
              {groupHeading(p.fecha)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
              {p.description}
            </span>
            <span
              className={cn(
                "text-[15px] font-semibold tabular-nums",
                tipo === "ingreso" && "text-income",
              )}
            >
              {formatCents(p.amount_cents)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
