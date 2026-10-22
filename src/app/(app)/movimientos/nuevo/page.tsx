import { PageBody, PageHeader } from "@/components/app/page-header";
import { TransactionForm } from "@/components/movimientos/transaction-form";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Nuevo movimiento" };

/**
 * En el prototipo esto es una pantalla completa en móvil y un cuadro de 840 px
 * en escritorio. Aquí es una ruta propia en ambos casos, presentada como panel
 * centrado a partir de 1024 px: se ve igual, y además se puede enlazar y
 * recargar, cosa que un cuadro superpuesto no permitiría.
 */
export default async function NuevoMovimientoPage() {
  const supabase = await createClient();

  const [{ data: accounts }, { data: categories }, { data: posiciones }] = await Promise.all([
    supabase.from("account").select("*").eq("archived", false).order("name"),
    supabase.from("category").select("*").order("name"),
    // Para poder decir a qué posición va un traspaso a una cuenta de inversión,
    // y si sigue un instrumento (entonces se piden sus participaciones).
    supabase
      .from("v_position_value")
      .select("position_id, name, account_id, instrument_id")
      .eq("archived", false)
      .order("name"),
  ]);

  // Sin cuentas no hay de dónde sacar ni dónde meter dinero.
  if (!accounts || accounts.length === 0) {
    return (
      <>
        <PageHeader title="Nuevo movimiento" />
        <PageBody>
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="wallet" size={26} />
            </span>
            <h2 className="text-[17px] leading-[22px] font-semibold">Antes hace falta una cuenta</h2>
            <p className="max-w-sm text-[15px] leading-5 text-muted">
              Todo movimiento sale o entra de algún sitio. Crea tu primera cuenta y vuelve.
            </p>
            <ButtonLink href="/cuentas">Ir a Cuentas</ButtonLink>
          </Card>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Nuevo movimiento" />
      <PageBody className="lg:max-w-[840px]">
        <Card className="p-4 lg:p-6">
          <TransactionForm
            accounts={accounts}
            categories={categories ?? []}
            positions={posiciones ?? []}
          />
        </Card>
      </PageBody>
    </>
  );
}
