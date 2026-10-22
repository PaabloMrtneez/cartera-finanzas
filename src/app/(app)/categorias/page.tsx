import { PageBody, PageHeader } from "@/components/app/page-header";
import { CategoryBrowser } from "@/components/categorias/category-browser";
import { createClient } from "@/lib/supabase/server";
import type { Category } from "@/lib/supabase/database.types";
import { TRANSACTION_TYPES, type TransactionType } from "@/lib/types";

export const metadata = { title: "Categorías" };

export default async function CategoriasPage() {
  const supabase = await createClient();
  const { data } = await supabase.from("category").select("*").order("name");
  const categories = data ?? [];

  // Agrupadas por tipo en el servidor; el navegador cliente solo elige cuál ve.
  const groups = Object.fromEntries(
    TRANSACTION_TYPES.map((type) => [type, categories.filter((c) => c.type === type)]),
  ) as Record<TransactionType, Category[]>;

  return (
    <>
      <PageHeader title="Categorías" subtitle={`${categories.length} en total`} />

      <PageBody>
        <CategoryBrowser groups={groups} />
      </PageBody>
    </>
  );
}
