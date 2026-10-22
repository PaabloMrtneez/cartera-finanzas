import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { GoalCard } from "@/components/metas/goal-card";
import { GoalDialog } from "@/components/metas/goal-dialog";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Metas" };

export default async function MetasPage() {
  const supabase = await createClient();

  const [{ data: metas }, { data: accounts }, { data: proyecciones }, { data: valores }] =
    await Promise.all([
      // En curso primero, alcanzadas al final; dentro, por antigüedad.
      supabase
        .from("v_savings_goal_progress")
        .select("*")
        .order("reached", { ascending: true })
        .order("created_at", { ascending: true }),
      // Cualquier cuenta activa vale para una meta: hay quien ahorra en su cuenta
      // principal, en efectivo, o cuyo objetivo es tener X invertido. El progreso
      // lo resuelve v_account_worth según el tipo —saldo para las de dinero, caja
      // sin desplegar + valor de las posiciones para las de inversión—.
      // Una meta no ahorra en la cuenta de un préstamo (su saldo es la deuda).
      supabase.from("account").select("*").eq("archived", false).neq("type", "PRESTAMO").order("name"),
      // Hacia dónde va cada meta al ritmo de los seis últimos meses, y lo que
      // valía cada cuenta al cierre de los doce últimos (el trazo del pasado).
      supabase.rpc("savings_goal_projection", { p_months: 6 }),
      supabase.rpc("account_balance_monthly", { p_months: 12 }),
    ]);
  const proyeccionDe = new Map((proyecciones ?? []).map((p) => [p.goal_id, p]));

  const lista = metas ?? [];
  const cuentas = accounts ?? [];
  const sinCuentas = cuentas.length === 0;

  return (
    <>
      <PageHeader
        title="Metas"
        subtitle={lista.length > 0 ? `${lista.length} ${lista.length === 1 ? "meta" : "metas"}` : undefined}
        actions={
          !sinCuentas ? (
            <GoalDialog
              accounts={cuentas}
              trigger={
                <Button size="compact" aria-label="Nueva meta">
                  <Icon name="plus" size={15} />
                  <span className="hidden lg:inline">Nueva meta</span>
                </Button>
              }
            />
          ) : undefined
        }
      />

      <PageBody>
        {lista.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="piggy-bank" size={26} />
            </span>
            <h2 className="text-[17px] leading-[22px] font-semibold">Todavía no hay metas</h2>
            {sinCuentas ? (
              <>
                <p className="max-w-sm text-[15px] leading-5 text-muted">
                  Una meta se apoya en una cuenta: el progreso sale de lo que hay en ella. Primero
                  crea una cuenta y luego vuelve.
                </p>
                <ButtonLink href="/cuentas">Ir a Cuentas</ButtonLink>
              </>
            ) : (
              <>
                <p className="max-w-sm text-[15px] leading-5 text-muted">
                  Un objetivo con nombre y, si quieres, fecha —un viaje, un colchón de emergencia—.
                  El progreso sale solo de lo que hay en la cuenta que elijas: no hay nada que
                  apuntar a mano.
                </p>
                <GoalDialog accounts={cuentas} trigger={<Button>Crear la primera</Button>} />
              </>
            )}
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {lista.map((meta, i) => (
              // Entran en cascada, como los bloques héroe de Resumen. El retardo
              // se topa a los seis primeros: más abajo ya no se ve entrar y un
              // retardo largo solo haría esperar. Con movimiento reducido degrada
              // a un fundido sin recorrido.
              <div
                key={meta.id}
                className="animate-rise"
                style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}
              >
                <GoalCard
                  meta={meta}
                  accounts={cuentas}
                  proyeccion={proyeccionDe.get(meta.id)}
                  historia={(valores ?? [])
                    .filter((v) => v.account_id === meta.account_id)
                    .map((v) => ({
                      period_month: v.period_month,
                      worth_cents: v.worth_cents,
                    }))}
                />
              </div>
            ))}
          </div>
        )}

        {/* Si tienes metas pero ninguna cuenta de dinero (raro: las archivaste
            todas), al menos que sepas por qué no puedes crear más. */}
        {lista.length > 0 && sinCuentas ? (
          <p className="px-1 text-[13px] leading-[18px] text-muted">
            No tienes ninguna cuenta activa.{" "}
            <Link href="/cuentas" className="font-semibold text-accent-text">
              Crea una
            </Link>{" "}
            para añadir metas.
          </p>
        ) : null}
      </PageBody>
    </>
  );
}
