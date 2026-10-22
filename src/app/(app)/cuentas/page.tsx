import { AccountSpend } from "@/components/cuentas/account-spend";
import { BalanceSpark } from "@/components/cuentas/balance-spark";
import { SaldoPorCuenta } from "@/components/cuentas/saldo-por-cuenta";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SubNav } from "@/components/app/sub-nav";
import Link from "next/link";
import { AccountDialog } from "@/components/cuentas/account-dialog";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { monthStart, shiftMonth, todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { explicacionValor, totalPorMes, valoresPorCuenta, type ValorCuenta } from "@/lib/valor-cuentas";
import { createClient } from "@/lib/supabase/server";
import type { Account, AccountBalance, Card as CardRow } from "@/lib/supabase/database.types";
import { ACCOUNT_TYPE_ICONS, ACCOUNT_TYPE_LABELS, type LoanStatus } from "@/lib/types";

export const metadata = { title: "Cuentas" };

export default async function CuentasPage() {
  const supabase = await createClient();
  const mes = monthStart(todayIso());
  const mesPrevio = shiftMonth(mes, -1);

  // El saldo sale de la vista, no de la tabla: se deriva de los movimientos. Las
  // tarjetas se leen de `card` (varias por cuenta), ya no de `account.card_last4`.
  const [
    { data: balances },
    { data: worths },
    { data: posiciones },
    { data: gastoActual },
    { data: gastoPrevio },
    { data: cards },
    { data: saldosMes },
    { data: prestamos },
  ] = await Promise.all([
    supabase.from("v_account_balance").select("*").order("archived").order("name"),
    // Lo que VALE cada cuenta: el saldo para las de dinero; para las de
    // inversión, el efectivo sin invertir más lo que valen sus fondos. Es la
    // cifra de cada fila y la del total (ver src/lib/valor-cuentas.ts).
    supabase.from("v_account_worth").select("account_id, worth_cents"),
    // Los fondos activos de cada cuenta, para decir cuántos hay detrás de la cifra.
    supabase.from("v_position_value").select("account_id, value_cents").eq("archived", false),
    // El gasto neto por cuenta y tarjeta, este mes y el anterior (la muesca).
    supabase.rpc("account_card_spend", { p_month: mes }),
    supabase.rpc("account_card_spend", { p_month: mesPrevio }),
    supabase.from("card").select("*").order("created_at"),
    // El valor de cada cuenta al cierre de los doce últimos meses: una línea por
    // cuenta y, sumadas las activas, la curva del total.
    supabase.rpc("account_balance_monthly", { p_months: 12 }),
    // De qué préstamo es cada cuenta-pasivo, para decir por qué cuota va.
    supabase
      .from("v_loan_status")
      .select("loan_id, liability_account_id, paid_count, term_months, status"),
  ]);

  const rows = balances ?? [];
  // Las cuentas de un préstamo van en su propio grupo: su saldo es lo que
  // debes, no dinero que tengas, y se gestionan desde Préstamos.
  const active = rows.filter((r) => !r.archived && r.type !== "PRESTAMO");
  const deudas = rows.filter((r) => !r.archived && r.type === "PRESTAMO");
  const archived = rows.filter((r) => r.archived);
  const prestamoDe = new Map((prestamos ?? []).map((p) => [p.liability_account_id, p]));
  const valores = valoresPorCuenta(rows, worths ?? [], posiciones ?? []);
  const valorDe = (id: string, saldo: number) => valores.get(id)?.valorCents ?? saldo;
  // Lo que valen las cuentas activas. Con las archivadas sumadas es exactamente
  // el patrimonio (v_net_worth): las dos vistas usan la misma fórmula por cuenta.
  // La deuda de los préstamos resta: así el total más las archivadas sigue
  // siendo, céntimo a céntimo, el patrimonio.
  const total = [...active, ...deudas].reduce((sum, r) => sum + valorDe(r.account_id, r.balance_cents), 0);
  const deudaTotal = deudas.reduce((sum, r) => sum + r.balance_cents, 0);
  // Su curva: el mismo total al cierre de cada uno de los seis últimos meses.
  const historico = totalPorMes(saldosMes ?? [], 6);

  // Las tarjetas de cada cuenta, agrupadas por su id para pintarlas en su fila y
  // pasárselas al diálogo de edición.
  const cardsByAccount = new Map<string, CardRow[]>();
  for (const card of cards ?? []) {
    const lista = cardsByAccount.get(card.account_id);
    if (lista) lista.push(card);
    else cardsByAccount.set(card.account_id, [card]);
  }

  return (
    <>
      <PageHeader
        title="Cuentas"
        actions={
          <AccountDialog
            trigger={
              <Button size="compact">
                <Icon name="plus" size={15} />
                Nueva cuenta
              </Button>
            }
          />
        }
      />

      <PageBody>
        {/*
          El total, sin caja: una cifra sola no se agrupa con nada.

          En escritorio, su curva de seis meses va DEBAJO, a todo el ancho: el
          título y la cifra encabezan en una fila, y la tendencia —que antes
          vivía en una tarjeta al final de la pantalla— se estira en la fila
          siguiente. Apiladas y no en dos columnas, porque enfrentadas la
          cabecera de la curva subía por encima del título y la jerarquía se
          leía al revés.
        */}
        {/* Sin cuentas activas no hay total que dar: el estado vacío de abajo ya
            lo explica, y un «0,00 €» encima lo contradecía. */}
        <div
          className={cn(
            "flex animate-rise flex-col gap-5 lg:gap-6",
            active.length === 0 && "hidden",
          )}
        >
          <div>
            <Eyebrow className="text-accent-text">Total en cuentas activas</Eyebrow>
            <p className="mt-2 cifra-hero">
              {formatCents(total)}
            </p>
            <p className="mt-2 text-[14px] leading-5 text-muted tabular-nums">
              {deudaTotal !== 0
                ? `El saldo de cada cuenta, lo que valen hoy los fondos y, restados, los ${formatCents(-deudaTotal)} que debes de tus préstamos.`
                : "El saldo de cada cuenta y, en las de inversión, lo que valen hoy sus fondos."}
            </p>
          </div>

          {historico.length > 1 ? (
            <div className="hidden min-w-0 lg:block">
              <BalanceSpark puntos={historico} className="lg:px-0 lg:pb-0" />
            </div>
          ) : null}
        </div>

        {rows.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="wallet" size={26} />
            </span>
            <h2 className="text-[17px] leading-[22px] font-semibold">Aún no hay ninguna cuenta</h2>
            <p className="max-w-sm text-[15px] leading-5 text-muted">
              Crea la primera para poder empezar a registrar movimientos. Si la asocias a una
              tarjeta, el Atajo del iPhone sabrá dónde meter cada pago.
            </p>
            <AccountDialog trigger={<Button>Crear la primera cuenta</Button>} />
          </Card>
        ) : (
          <div className="animate-rise" style={{ animationDelay: "80ms" }}>
            <AccountList
              accounts={active}
              cardsByAccount={cardsByAccount}
              valores={valores}
              prestamoDe={prestamoDe}
            />
          </div>
        )}

        {deudas.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Eyebrow className="px-1">Préstamos</Eyebrow>
            <AccountList
              accounts={deudas}
              cardsByAccount={cardsByAccount}
              valores={valores}
              prestamoDe={prestamoDe}
            />
            <p className="px-1 text-[13px] leading-[18px] text-muted">
              Su saldo es lo que debes. Baja solo con cada cuota, y se gestionan desde{" "}
              <Link href="/prestamos" className="font-semibold text-accent-text">
                Préstamos
              </Link>
              .
            </p>
          </div>
        ) : null}

        {archived.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Eyebrow className="px-1">Archivadas</Eyebrow>
            <p className="px-1 text-[13px] leading-[18px] text-muted">
              Siguen contando en el patrimonio, pero no aparecen al registrar movimientos.
            </p>
            <AccountList
              accounts={archived}
              cardsByAccount={cardsByAccount}
              valores={valores}
              prestamoDe={prestamoDe}
            />
          </div>
        ) : null}

        {/* Gasto por cuenta y, dentro, por tarjeta, con la muesca del mes pasado. */}
        <AccountSpend
          actual={gastoActual ?? []}
          previo={gastoPrevio ?? []}
          mesIso={mes}
          mesPrevioIso={mesPrevio}
        />

        {/* Una línea por cuenta, cada una con su escala. */}
        <SaldoPorCuenta filas={saldosMes ?? []} />

        {/* En móvil la curva se queda donde estaba, en su tarjeta al final. */}
        {historico.length > 1 ? (
          <Card className="lg:hidden">
            <CardHeader title="Total en cuentas" />
            <BalanceSpark puntos={historico} />
          </Card>
        ) : null}

        <SubNav parent="/cuentas" />
      </PageBody>
    </>
  );
}

type PrestamoDeCuenta = {
  loan_id: string;
  paid_count: number;
  term_months: number;
  status: LoanStatus;
};

/** «Préstamo · 12 de 60 cuotas», o cómo terminó. */
function subtituloPrestamo(p: PrestamoDeCuenta | undefined): string {
  if (!p) return "Préstamo";
  if (p.status === "LIQUIDADO") return "Préstamo liquidado";
  const cuotas = `${p.paid_count} de ${p.term_months} ${p.term_months === 1 ? "cuota" : "cuotas"}`;
  return p.status === "CANCELADO" ? `Préstamo · ya no se sigue · ${cuotas}` : `Préstamo · ${cuotas}`;
}

function AccountList({
  accounts,
  cardsByAccount,
  valores,
  prestamoDe,
}: {
  accounts: AccountBalance[];
  cardsByAccount: Map<string, CardRow[]>;
  valores: Map<string, ValorCuenta>;
  prestamoDe: Map<string, PrestamoDeCuenta>;
}) {
  if (accounts.length === 0) return null;

  return (
    <Card>
      <ul>
        {accounts.map((account) => {
          const cards = cardsByAccount.get(account.account_id) ?? [];
          const valor = valores.get(account.account_id);
          const cifra = valor?.valorCents ?? account.balance_cents;
          // Una cuenta con fondos no se describe por sus movimientos sino por lo
          // que hay detrás de su cifra: que es el valor de sus fondos y, si
          // queda efectivo fuera de ellos, cuánto.
          const explicacion = valor ? explicacionValor(valor) : null;
          const esPrestamo = account.type === "PRESTAMO";
          const prestamo = esPrestamo ? prestamoDe.get(account.account_id) : undefined;
          return (
            <li key={account.account_id}>
              <div className="flex min-h-[60px] items-center gap-3 hair-t border-separator px-4 py-[9px] first:border-t-0 lg:px-5">
                <span
                  className="flex size-[38px] shrink-0 items-center justify-center rounded-full"
                  style={{
                    background: `color-mix(in srgb, ${account.color} 14%, transparent)`,
                    color: account.color,
                  }}
                >
                  <Icon name={ACCOUNT_TYPE_ICONS[account.type]} size={19} />
                </span>

                {/*
                  Nombre y saldo comparten un contenedor que puede partirse en
                  dos líneas (hallazgo M-2). El nombre tiene un mínimo
                  garantizado (7ch); si con él no cabe el saldo —importes de
                  siete u ocho cifras en un móvil estrecho—, el saldo baja a la
                  línea siguiente, alineado a la derecha, en vez de dejar el
                  nombre en «E» o en nada.
                */}
                <span className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3">
                <span className="flex min-w-[7ch] flex-1 basis-0 flex-col">
                  <span
                    className={cn(
                      "text-[17px] leading-[22px] font-semibold lg:text-[15px]",
                      // «Préstamo · Coche» al lado de una deuda de seis cifras
                      // no cabe en un móvil: baja de línea en vez de cortarse.
                      esPrestamo ? "break-words" : "truncate",
                    )}
                  >
                    {account.name}
                  </span>
                  {/* Sin truncar: es lo que explica la cifra, y cortado en un
                      móvil («Incluye 120,00 € s…») ya no explica nada. Si no
                      cabe, baja de línea. */}
                  {esPrestamo ? (
                    <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                      {subtituloPrestamo(prestamo)}
                    </span>
                  ) : explicacion ? (
                    <>
                      <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                        {explicacion.que}
                      </span>
                      {explicacion.sinInvertir ? (
                        <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                          {explicacion.sinInvertir}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="truncate text-[13px] leading-[18px] text-muted tabular-nums">
                      {ACCOUNT_TYPE_LABELS[account.type]}
                      {` · ${account.movement_count} ${
                        account.movement_count === 1 ? "movimiento" : "movimientos"
                      }`}
                    </span>
                  )}
                  {cards.length > 0 ? (
                    <span className="truncate text-[13px] leading-[18px] text-muted tabular-nums">
                      {tarjetasTexto(cards)}
                    </span>
                  ) : null}
                </span>

                <span
                  className={cn(
                    "shrink-0 text-[17px] leading-[22px] font-semibold tabular-nums lg:text-[15px]",
                    cifra < 0 && "text-expense",
                  )}
                >
                  {formatCents(cifra)}
                </span>
                </span>

                {/* La cuenta de un préstamo no se edita aquí (su nombre, su tipo
                    y su saldo los lleva el préstamo): lleva a él. */}
                {esPrestamo ? (
                  <ButtonLink
                    href={prestamo ? `/prestamos#prestamo-${prestamo.loan_id}` : "/prestamos"}
                    variant="ghost"
                    size="icon"
                    aria-label={`Ver el préstamo de ${account.name}`}
                  >
                    <Icon name="chevron-right" size={18} />
                  </ButtonLink>
                ) : (
                  <AccountDialog
                    account={toAccount(account)}
                    cards={cards}
                    trigger={
                      <Button variant="ghost" size="icon" aria-label={`Editar ${account.name}`}>
                        <Icon name="pencil" size={18} />
                      </Button>
                    }
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * Las tarjetas de una cuenta, en corto, para su propia línea bajo el subtítulo.
 * Van aparte —no pegadas al tipo y el recuento de movimientos— para que la línea
 * no se quede sin sitio y trunque «movimientos». Hasta dos se muestran por sus
 * dígitos; con más, un recuento. El llamador solo la pinta si hay alguna.
 */
function tarjetasTexto(cards: CardRow[]): string {
  if (cards.length <= 2) return cards.map((c) => `···${c.last4}`).join(" · ");
  return `${cards.length} tarjetas`;
}

/** La vista no trae todas las columnas de la tabla; el diálogo solo usa estas. */
function toAccount(row: AccountBalance): Account {
  return {
    id: row.account_id,
    user_id: row.user_id,
    name: row.name,
    type: row.type,
    initial_balance_cents: row.initial_balance_cents,
    color: row.color,
    archived: row.archived,
    archived_at: null,
    created_at: "",
    updated_at: "",
  };
}
