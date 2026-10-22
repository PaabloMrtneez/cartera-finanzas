import { PageBody, PageHeader } from "@/components/app/page-header";
import { DeleteRuleButton } from "@/components/reglas/delete-rule-button";
import { RuleDialog } from "@/components/reglas/rule-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { shortDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Reglas de comercio" };

export default async function ReglasPage() {
  const supabase = await createClient();

  const [{ data: rules }, { data: categories }, { data: suggestions }] = await Promise.all([
    supabase.from("merchant_rule").select("*").order("match_norm"),
    supabase.from("category").select("*").neq("type", "TRANSFER").order("name"),
    supabase.from("v_rule_suggestions").select("*").order("occurrences", { ascending: false }).limit(8),
  ]);

  const byId = new Map((categories ?? []).map((c) => [c.id, c]));
  const existing = new Set((rules ?? []).map((r) => r.match_norm));

  return (
    <>
      <PageHeader
        title="Reglas de comercio"
        subtitle={`${rules?.length ?? 0} ${rules?.length === 1 ? "regla" : "reglas"}`}
        actions={
          <RuleDialog
            categories={categories ?? []}
            trigger={
              <Button size="compact" aria-label="Nueva regla">
                <Icon name="plus" size={15} />
                <span className="hidden lg:inline">Nueva regla</span>
              </Button>
            }
          />
        }
      />

      <PageBody className="lg:max-w-[680px]">
        <p className="px-1 text-[13px] leading-[18px] text-muted">
          Cuando llega un pago del Atajo, se busca cuál de tus reglas encaja con el nombre del
          comercio. Si alguna acierta, el gasto entra ya clasificado; si ninguna lo hace, espera en
          pendientes.
        </p>

        {rules && rules.length > 0 ? (
          <Card>
            <ul>
              {rules.map((rule) => {
                const category = byId.get(rule.category_id);
                return (
                  <li
                    key={rule.id}
                    className="flex min-h-[60px] items-center gap-3 hair-t border-separator px-4 py-2 first:border-t-0 lg:px-5"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-mono text-[15px] font-semibold">
                        {rule.match_text}
                      </span>
                      <span className="flex items-center gap-[6px] truncate text-[13px] leading-[18px] text-muted">
                        <Icon name="arrow-right" size={13} />
                        {category?.name ?? "Categoría eliminada"}
                        {rule.hit_count > 0
                          ? ` · ${rule.hit_count} ${rule.hit_count === 1 ? "acierto" : "aciertos"}`
                          : ""}
                      </span>
                    </span>
                    {category ? (
                      <span
                        className="flex size-[30px] shrink-0 items-center justify-center rounded-full"
                        style={{
                          background: `color-mix(in srgb, ${category.color} 16%, transparent)`,
                          color: category.color,
                        }}
                      >
                        <Icon name={category.icon} size={16} />
                      </span>
                    ) : null}
                    <DeleteRuleButton id={rule.id} matchText={rule.match_text} />
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : (
          <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Icon name="repeat" size={26} />
            </span>
            <h2 className="text-[17px] leading-[22px] font-semibold">Todavía no hay reglas</h2>
            <p className="max-w-sm text-[15px] leading-5 text-muted">
              Con unas pocas se clasifica casi todo solo. Puedes crearlas a mano o esperar a que la
              app te sugiera las que se repiten.
            </p>
            <RuleDialog
              categories={categories ?? []}
              trigger={<Button>Crear la primera regla</Button>}
            />
          </Card>
        )}

        {/* Comercios que se repiten sin clasificar: las reglas que faltan. */}
        {suggestions && suggestions.filter((s) => !existing.has(s.merchant.toLowerCase())).length > 0 ? (
          <Card>
            <CardHeader title="Te faltan estas reglas" />
            <p className="px-[18px] pb-3 text-[13px] leading-[18px] text-muted">
              Comercios que se repiten y siguen sin categoría.
            </p>
            <ul>
              {suggestions
                .filter((s) => !existing.has(s.merchant.toLowerCase()))
                .map((suggestion) => (
                  <li
                    key={suggestion.merchant}
                    className="flex min-h-[60px] items-center gap-3 hair-t border-separator px-4 py-2 lg:px-5"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-mono text-[15px] font-semibold">
                        {suggestion.merchant}
                      </span>
                      <span className="truncate text-[13px] leading-[18px] text-muted tabular-nums">
                        {suggestion.occurrences} pagos · {formatCents(suggestion.total_cents)} ·
                        último {shortDate(suggestion.last_seen)}
                      </span>
                    </span>
                    <RuleDialog
                      categories={categories ?? []}
                      initialText={suggestion.merchant}
                      trigger={
                        <Button variant="secondary" size="compact">
                          Crear regla
                        </Button>
                      }
                    />
                  </li>
                ))}
            </ul>
          </Card>
        ) : null}

        <Eyebrow className="px-1">Cómo se desempatan</Eyebrow>
        <p className="px-1 text-[13px] leading-[18px] text-muted">
          Si dos reglas encajan con el mismo comercio, gana la del texto más largo. Así{" "}
          <span className="font-mono">CARREFOUR EXPRESS</span> se impone a{" "}
          <span className="font-mono">CARREFOUR</span>, y puedes afinar sin borrar la general.
        </p>
      </PageBody>
    </>
  );
}
