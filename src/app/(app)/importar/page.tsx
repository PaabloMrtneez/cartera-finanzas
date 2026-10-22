import { PageBody, PageHeader } from "@/components/app/page-header";
import { ImportWizard } from "@/components/importar/import-wizard";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Importar del banco" };

export default async function ImportarPage() {
  const supabase = await createClient();
  const { data: cuentas } = await supabase
    .from("account")
    .select("id, name, type")
    .eq("archived", false)
    // Un extracto del banco no se importa a la cuenta de un préstamo.
    .neq("type", "PRESTAMO")
    .order("name");

  return (
    <>
      <PageHeader
        title="Importar del banco"
        subtitle="Un extracto en CSV, una vez"
      />
      <PageBody className="lg:max-w-[760px]">
        <ImportWizard cuentas={cuentas ?? []} />
      </PageBody>
    </>
  );
}
