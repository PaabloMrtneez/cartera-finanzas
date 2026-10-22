import { PageBody, PageHeader } from "@/components/app/page-header";
import { FichaPrestamo, type DatosPrestamo } from "@/components/prestamos/ficha-prestamo";
import { PrestamoDialog, type PrestamoGestion } from "@/components/prestamos/prestamo-dialog";
import { Button } from "@/components/ui/button";
import { Card, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { listaNombres } from "@/lib/graficos";
import { formatCents, formatCentsPlain } from "@/lib/money";
import { fechaCuota, formatTipo, tipoParaCampo, type FilaCuadro } from "@/lib/prestamos-vista";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Préstamos" };

/**
 * PRÉSTAMOS. Arriba, sin caja, la cifra que lo resume: lo que debes. Debajo, en
 * una tira con filete, lo que cada mes sale por ellos, cuándo es la próxima
 * cuota y lo que aún te queda por pagar en intereses. Y una ficha por préstamo.
 *
 * Todo sale de la base: `v_loan_status` (pendiente REAL, derivado de los
 * movimientos de la cuenta del préstamo; intereses; próxima cuota) y
 * `loan_schedule` (el cuadro con el estado de cada cuota). Aquí no se calcula
 * ninguna cifra de un préstamo: se suman y se pintan.
 */
export default async function PrestamosPage() {
  const supabase = await createClient();

  const [{ data: estados }, { data: cuentas }] = await Promise.all([
    supabase
      .from("v_loan_status")
      // Los tipos, además, como TEXTO: numeric llega como doble por JSON y se
      // enseñan (y se vuelven a escribir en el formulario) tal cual los guarda la base.
      .select(
        "*, tin_texto:tin_pct::text, tae_texto:tae_pct::text, tae_efectiva_texto:tae_effective_pct::text, tae_calc_texto:tae_calc_pct::text",
      )
      .order("start_on", { ascending: false }),
    supabase.from("account").select("id, name, type, archived").order("name"),
  ]);

  const prestamos = estados ?? [];
  const cuadros = await Promise.all(
    prestamos.map((p) => supabase.rpc("loan_schedule", { p_loan_id: p.loan_id })),
  );
  const cuadroDe = new Map<string, FilaCuadro[]>(
    prestamos.map((p, i) => [p.loan_id, (cuadros[i].data ?? []) as FilaCuadro[]]),
  );

  const nombreCuenta = new Map((cuentas ?? []).map((c) => [c.id, c.name]));
  // Desde dónde se puede pagar un préstamo: ni una archivada ni la de otro préstamo.
  const elegibles = (cuentas ?? [])
    .filter((c) => !c.archived && c.type !== "PRESTAMO")
    .map((c) => ({ id: c.id, name: c.name }));

  const activos = prestamos
    .filter((p) => p.status === "ACTIVO")
    .sort((a, b) => (a.next_due_on ?? "9999").localeCompare(b.next_due_on ?? "9999"));
  const cerrados = prestamos.filter((p) => p.status !== "ACTIVO");

  // La deuda es la de todos: uno que dejaste de seguir sigue debiéndose.
  const deuda = prestamos.reduce((s, p) => s + p.principal_pending_cents, 0);
  const cuotaMes = activos.reduce((s, p) => s + p.payment_cents, 0);
  const interesesPendientes = activos.reduce((s, p) => s + p.interest_pending_cents, 0);
  const proximaFecha = activos
    .map((p) => p.next_due_on)
    .filter((f): f is string => f !== null)
    .sort()[0];
  const delDia = activos.filter((p) => p.next_due_on === proximaFecha);
  const proximaImporte = delDia.reduce((s, p) => s + (p.next_payment_cents ?? 0), 0);

  function datos(p: (typeof prestamos)[number]): DatosPrestamo {
    return {
      loan_id: p.loan_id,
      name: p.name,
      status: p.status,
      principal_cents: p.principal_cents,
      term_months: p.term_months,
      tin_texto: p.tin_texto,
      tae_efectiva_texto: p.tae_efectiva_texto,
      tae_es_contrato: p.tae_texto !== null,
      opening_fee_cents: p.opening_fee_cents,
      charge_day: p.charge_day,
      start_on: p.start_on,
      payment_cents: p.payment_cents,
      paid_count: p.paid_count,
      principal_pending_cents: p.principal_pending_cents,
      schedule_pending_cents: p.schedule_pending_cents,
      principal_paid_cents: p.principal_paid_cents,
      interest_total_cents: p.interest_total_cents,
      interest_paid_cents: p.interest_paid_cents,
      interest_pending_cents: p.interest_pending_cents,
      fees_paid_cents: p.fees_paid_cents,
      total_cost_cents: p.total_cost_cents,
      next_period: p.next_period,
      next_due_on: p.next_due_on,
      next_payment_cents: p.next_payment_cents,
      end_on: p.end_on,
      closed_on: p.closed_on,
    };
  }

  function gestion(p: (typeof prestamos)[number]): PrestamoGestion {
    const filas = cuadroDe.get(p.loan_id) ?? [];
    const ultimaCobrada = filas.filter((f) => f.state === "COBRADA").at(-1)?.due_on ?? null;
    return {
      id: p.loan_id,
      name: p.name,
      taeContrato: tipoParaCampo(p.tae_texto),
      taeCalculada: formatTipo(p.tae_calc_texto),
      activo: p.status === "ACTIVO",
      puedeCambiarCondiciones: p.paid_count < p.tracked_from_period,
      pendienteCents: p.principal_pending_cents,
      cuentaPago: nombreCuenta.get(p.payment_account_id) ?? "tu cuenta",
      liquidarDesde: ultimaCobrada && ultimaCobrada > p.start_on ? ultimaCobrada : p.start_on,
      condiciones: {
        payment_account_id: p.payment_account_id,
        principal: formatCentsPlain(p.principal_cents),
        plazo: String(p.term_months),
        tin: tipoParaCampo(p.tin_texto),
        comision: p.opening_fee_cents > 0 ? formatCentsPlain(p.opening_fee_cents) : "",
        charge_day: p.charge_day,
        start_on: p.start_on,
        first_charge_on: p.first_charge_on,
        disbursed: p.disbursed,
      },
    };
  }

  const nuevo = (trigger: React.ReactNode) => (
    <PrestamoDialog cuentas={elegibles} trigger={trigger} />
  );

  const ficha = (p: (typeof prestamos)[number], heroe: boolean) => (
    <li key={p.loan_id}>
      <FichaPrestamo
        p={datos(p)}
        filas={cuadroDe.get(p.loan_id) ?? []}
        cuentaPago={nombreCuenta.get(p.payment_account_id) ?? "—"}
        heroe={heroe}
        enTira={activos.length === 1 && p.status === "ACTIVO"}
        acciones={
          <PrestamoDialog
            prestamo={gestion(p)}
            cuentas={elegibles}
            trigger={
              <Button variant="ghost" size="icon" aria-label={`Editar ${p.name}`}>
                <Icon name="pencil" size={18} />
              </Button>
            }
          />
        }
      />
    </li>
  );

  return (
    <>
      <PageHeader
        title="Préstamos"
        actions={nuevo(
          <Button size="compact" aria-label="Nuevo préstamo">
            <Icon name="plus" size={15} />
            <span className="hidden lg:inline">Nuevo préstamo</span>
          </Button>,
        )}
      />

      <PageBody>
        {prestamos.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="hand-coins" size={26} />
            </span>
            <h2 className="text-[17px] leading-[22px] font-semibold">Aún no sigues ningún préstamo</h2>
            <p className="max-w-md text-[15px] leading-5 text-muted">
              El del coche, uno personal, la hipoteca. Con el importe, el plazo y el TIN se calcula la cuota,
              se cobra sola cada mes y ves cuánto te queda y cuánto pagas en intereses.
            </p>
            {nuevo(<Button>Añadir un préstamo</Button>)}
          </Card>
        ) : (
          <>
            {/* La cifra héroe, sin caja: una cifra sola no se agrupa con nada. */}
            <section className="flex animate-rise flex-col">
              <Eyebrow className="text-accent-text">Deuda pendiente</Eyebrow>
              <p
                className="mt-2 cifra-hero"
                data-testid="deuda-pendiente"
              >
                {formatCents(deuda)}
              </p>
              <p className="mt-2 text-[14px] leading-5 text-muted">
                {activos.length === 0
                  ? "Lo que queda por devolver de tus préstamos."
                  : `Lo que queda por devolver de ${activos.length === 1 ? "tu préstamo" : `tus ${activos.length} préstamos`}. Las cuotas se cobran solas el día que toca.`}
              </p>

              {activos.length > 0 ? (
                <div className="mt-5 flex hair-t hair-b border-hairline lg:mt-6">
                  {[
                    {
                      rotulo: "Cuota al mes",
                      cifra: formatCents(cuotaMes),
                      pie:
                        activos.length === 1
                          ? `el día ${activos[0].charge_day}`
                          : `entre los ${activos.length}`,
                    },
                    {
                      rotulo: "Próxima cuota",
                      cifra: proximaFecha ? formatCents(proximaImporte) : "—",
                      pie: proximaFecha
                        ? `${fechaCuota(proximaFecha)} · ${listaNombres(delDia.map((p) => p.name), 1)}`
                        : "",
                    },
                    {
                      rotulo: "Intereses",
                      cifra: formatCents(interesesPendientes),
                      pie: "por pagar",
                    },
                  ].map((c, i) => (
                    <div
                      key={c.rotulo}
                      className={cn(
                        "flex min-w-0 flex-1 flex-col py-3 lg:py-4",
                        i > 0 && "hair-l border-hairline pl-3 lg:pl-6",
                      )}
                    >
                      <span className="text-[13px] leading-[18px] text-muted lg:text-[14px]">{c.rotulo}</span>
                      <span className="cifra mt-1 text-[19px] leading-7 font-medium lg:text-[26px] lg:leading-8">
                        {c.cifra}
                      </span>
                      <span className="text-[13px] leading-[18px] break-words text-muted tabular-nums">
                        {c.pie}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            {activos.length > 0 ? (
              <section className="flex animate-rise flex-col gap-2" style={{ animationDelay: "80ms" }}>
                {cerrados.length > 0 ? <Eyebrow className="px-1">En curso</Eyebrow> : null}
                <ul className="flex flex-col gap-4 lg:gap-6">{activos.map((p, i) => ficha(p, i === 0))}</ul>
              </section>
            ) : null}

            {cerrados.length > 0 ? (
              <section className="flex flex-col gap-2">
                <Eyebrow className="px-1">Terminados</Eyebrow>
                <ul className="flex flex-col gap-4 lg:gap-6">
                  {cerrados.map((p, i) => ficha(p, activos.length === 0 && i === 0))}
                </ul>
              </section>
            ) : null}

            <p className="px-1 text-[13px] leading-[18px] text-muted">
              Cada cuota se apunta sola el día de cobro en dos partes: los intereses, como gasto (categoría
              Intereses), y el capital, como traspaso a la cuenta del préstamo, que es lo que baja la deuda.
            </p>
          </>
        )}
      </PageBody>
    </>
  );
}
