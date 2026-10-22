import { NextResponse } from "next/server";
import { monthLabel, monthStart, todayIso } from "@/lib/dates";
import { nombreFichero } from "@/lib/export";
import { formatCents, formatPercent, formatShare, percentChange } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

/**
 * Informe mensual en Markdown.
 *
 * Pensado para DOS lectores: tú, y un asistente al que le pidas «¿qué límites
 * ajusto para ahorrar más?». Por eso Markdown y no PDF: un LLM lo parsea sin
 * perder la estructura, y se lee igual de bien. Trae justo lo que hace falta para
 * esa pregunta —el gasto por categoría frente a tu media, y qué límites hay y
 * cuáles faltan— sin volcar datos crudos.
 *
 * Todo se DERIVA (nada de saldos almacenados) y sale con la sesión del usuario,
 * así que la RLS ya devuelve solo lo suyo.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cur = (c: number | null | undefined) => formatCents(c ?? 0);

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No has iniciado sesión." }, { status: 401 });
  }

  const mesParam = new URL(request.url).searchParams.get("mes");
  const month =
    mesParam && /^\d{4}-\d{2}-\d{2}$/.test(mesParam) ? monthStart(mesParam) : monthStart(todayIso());
  const esMesActual = month === monthStart(todayIso());

  const [
    { data: resumen },
    { data: medias },
    { data: limites },
    { data: suscripciones },
    { data: ingresos },
    { data: forecast },
    { data: ingresoPendiente },
  ] = await Promise.all([
    supabase.from("v_month_summary").select("*").eq("period_month", month).maybeSingle(),
    supabase.rpc("category_avg_6m", { p_month: month }),
    supabase.rpc("budget_status", { p_month: month }),
    supabase.from("v_subscription_summary").select("*").eq("active", true),
    supabase.from("v_recurring_income_summary").select("*").eq("active", true),
    supabase.rpc("month_forecast", { p_month: month }),
    supabase.rpc("pending_recurring_income", { p_month: month }),
  ]);

  const ingresosMes = resumen?.income_cents ?? 0;
  const gastoMes = resumen?.net_expense_cents ?? 0;
  const balanceMes = resumen?.month_balance_cents ?? 0;

  // Gasto por categoría con la media de 6 meses, de mayor a menor gasto.
  const categorias = (medias ?? [])
    .filter((m) => m.current_cents > 0)
    .sort((a, b) => b.current_cents - a.current_cents);

  const conLimite = new Set((limites ?? []).map((l) => l.category_id));
  const sinLimite = categorias.filter((c) => c.category_id && !conLimite.has(c.category_id));

  const L = [`# Informe de ${monthLabel(month)} — Cartera`, ""];
  L.push(
    `_Generado el ${todayIso()} para ${user.email}. Importes en euros.${
      esMesActual ? " El mes está EN CURSO: las cifras son hasta hoy." : ""
    }_`,
    "",
  );

  L.push("## Resumen del mes", "");
  L.push(`- Ingresos: ${cur(ingresosMes)}`);
  L.push(`- Gasto neto: ${cur(gastoMes)}`);
  L.push(`- Balance: ${balanceMes >= 0 ? "+" : ""}${cur(balanceMes)}`);
  if (esMesActual && forecast?.[0] && forecast[0].dias_transcurridos >= 4) {
    const f = forecast[0];
    const balancePrevisto = f.ingresos_real_cents + (ingresoPendiente ?? 0) - f.prevision_cents;
    L.push(
      `- Previsión de cierre: gasto ~${cur(f.prevision_cents)}, balance ~${
        balancePrevisto >= 0 ? "+" : ""
      }${cur(balancePrevisto)}`,
    );
  }
  L.push("");

  L.push("## Gasto por categoría", "");
  if (categorias.length === 0) {
    L.push("_Sin gasto registrado este mes._", "");
  } else {
    L.push("| Categoría | Gastado | % del gasto | Media 6 meses | Frente a tu media |");
    L.push("| --- | ---: | ---: | ---: | ---: |");
    for (const c of categorias) {
      const share = gastoMes > 0 ? formatShare((c.current_cents / gastoMes) * 100, 0) : "—";
      const delta =
        c.months_with_data > 0 ? percentChange(c.current_cents, c.avg_cents) : null;
      const vsMedia =
        c.months_with_data === 0
          ? "sin histórico"
          : delta === null
            ? "—"
            : formatPercent(delta, 0);
      const media = c.months_with_data > 0 ? cur(c.avg_cents) : "—";
      L.push(`| ${c.name} | ${cur(c.current_cents)} | ${share} | ${media} | ${vsMedia} |`);
    }
    L.push("");
  }

  L.push("## Límites", "");
  if ((limites ?? []).length === 0) {
    L.push("_No hay ningún límite definido todavía._", "");
  } else {
    L.push("| Categoría | Tope | Gastado | Consumo | Estado |");
    L.push("| --- | ---: | ---: | ---: | --- |");
    for (const l of limites ?? []) {
      const pct = l.pct === null ? "—" : formatShare(l.pct, 0);
      const estado =
        l.spent_cents > l.effective_cap_cents
          ? "PASADO"
          : (l.pct ?? 0) >= 80
            ? "al límite"
            : "holgado";
      L.push(
        `| ${l.name} | ${cur(l.effective_cap_cents)} | ${cur(l.spent_cents)} | ${pct} | ${estado} |`,
      );
    }
    L.push("");
  }
  if (sinLimite.length > 0) {
    L.push(
      `**Categorías con gasto pero SIN límite** (candidatas a ponerles uno): ${sinLimite
        .map((c) => `${c.name} (${cur(c.current_cents)})`)
        .join(", ")}.`,
      "",
    );
  }

  L.push("## Compromisos fijos", "");
  const susMensual = (suscripciones ?? []).reduce((s, x) => s + x.monthly_cents, 0);
  const ingMensual = (ingresos ?? []).reduce((s, x) => s + x.monthly_cents, 0);
  L.push(
    `- Gastos fijos: ${cur(susMensual)}/mes${
      (suscripciones ?? []).length ? ` (${(suscripciones ?? []).map((x) => x.description).join(", ")})` : ""
    }`,
  );
  L.push(
    `- Ingresos fijos: ${cur(ingMensual)}/mes${
      (ingresos ?? []).length ? ` (${(ingresos ?? []).map((x) => x.description).join(", ")})` : ""
    }`,
  );
  L.push("");

  L.push("---", "");
  L.push(
    "Para ahorrar más: mira las categorías muy por encima de tu media y las que no tienen límite.",
    "El margen de ahorro del mes es el balance; bajar el gasto de las categorías infladas lo sube.",
    "",
  );

  const md = L.join("\n");

  return new NextResponse(md, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nombreFichero("informe", "md", month)}"`,
      "Cache-Control": "no-store",
    },
  });
}
