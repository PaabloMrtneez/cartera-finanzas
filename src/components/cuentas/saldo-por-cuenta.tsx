import { Card, CardHeader } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { monthShortLabel } from "@/lib/dates";
import { CIFRA_LECTURA, lecturasNivel } from "@/lib/graficos";
import { formatCents, formatSignedDelta } from "@/lib/money";
import type { AccountType } from "@/lib/supabase/database.types";
import { ACCOUNT_TYPE_ICONS } from "@/lib/types";

export type SaldoMes = {
  account_id: string;
  name: string;
  color: string;
  type: AccountType;
  archived: boolean;
  period_month: string;
  /** El valor de la cuenta al cierre del mes: su saldo, o efectivo + fondos si es de inversión. */
  worth_cents: number;
};

const MES_LARGO = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const largo = (iso: string) => MES_LARGO.format(new Date(`${iso}T00:00:00Z`));

/**
 * Una línea POR CUENTA, en múltiplos pequeños: cada cuenta activa con su
 * propia curva de los últimos meses (`account_balance_monthly`). La curva es
 * el VALOR de la cuenta —la misma cifra que su fila de la lista—: para una
 * cuenta de dinero, su saldo; para una de inversión, el efectivo más lo que
 * valían sus fondos ese mes. Con el saldo a secas, una cuenta cuyo dinero está
 * entero en fondos salía plana en 0.
 *
 * Separadas y no encima de un mismo eje: una cuenta de 300 € al lado de otra
 * de 30.000 € saldría plana y parecería que no se mueve. Cada una usa su
 * propia escala y se ve lo que de verdad ha hecho; la comparación entre ellas
 * se conserva en la cifra de la derecha.
 *
 * La cifra de cada fila NO es el valor —ese ya está en la lista de arriba—:
 * es cuánto ha cambiado en el periodo. Al recorrer la línea, pasa a ser el
 * valor de ese mes y lo que cambió desde el principio.
 */
export function SaldoPorCuenta({ filas }: { filas: SaldoMes[] }) {
  const porCuenta = new Map<string, SaldoMes[]>();
  for (const f of filas) {
    if (f.archived) continue;
    const lista = porCuenta.get(f.account_id) ?? [];
    lista.push(f);
    porCuenta.set(f.account_id, lista);
  }
  const cuentas = [...porCuenta.values()]
    .map((serie) => serie.sort((a, b) => a.period_month.localeCompare(b.period_month)))
    .filter((serie) => serie.length >= 2);
  // La tarjeta va AQUÍ y no en la página: quien sabe si hay algo que pintar
  // es este componente, y con la tarjeta fuera se quedaba vacía, con solo su
  // título, cuando ninguna cuenta activa tenía dos meses de historia.
  if (cuentas.length === 0) return null;

  return (
    <Card>
      <CardHeader title="Cada cuenta, mes a mes" />
      <ul className="lg:grid lg:grid-cols-2 lg:gap-x-8 lg:px-5">
        {cuentas.map((serie) => {
          const c = serie[0];
          const valores = serie.map((p) => p.worth_cents);
          const cambio = valores[valores.length - 1] - valores[0];
          const inicio = (
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span
                className="relative flex size-[30px] shrink-0 items-center justify-center rounded-full"
                style={{ color: c.color }}
              >
                <span
                  className="absolute inset-0 rounded-full opacity-16"
                  style={{ background: c.color }}
                />
                <Icon name={ACCOUNT_TYPE_ICONS[c.type]} size={16} className="relative" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{c.name}</span>
            </span>
          );
          return (
            <li key={c.account_id} className="hair-t border-separator px-4 py-4 lg:px-0">
              <LineaInteractiva
                tamano="fila"
                inicio={inicio}
                altoBase={56}
                claseAlto="h-[56px] lg:h-[64px]"
                ejeX={serie.map((p) => monthShortLabel(p.period_month).split(" ")[0])}
                lecturas={lecturasNivel(
                  valores,
                  serie.map((p) => largo(p.period_month)),
                  { desdeRotulo: largo(serie[0].period_month) },
                )}
                etiquetaAccesible={`${c.type === "INVERSION" ? "Valor" : "Saldo"} de ${c.name}, mes a mes. Recórrelo con las flechas.`}
                series={[
                  {
                    id: c.account_id,
                    nombre: c.name,
                    valores,
                    textos: valores.map(formatCents),
                  },
                ]}
              >
                <span className={CIFRA_LECTURA.fila}>{formatSignedDelta(cambio)}</span>
                <span className="block text-[13px] leading-[18px] text-muted">
                  en {serie.length} meses
                </span>
              </LineaInteractiva>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
