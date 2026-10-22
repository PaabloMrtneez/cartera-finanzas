import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { ExportSettings } from "@/components/ajustes/export-settings";
import { InvitarSettings } from "@/components/ajustes/invitar-settings";
import { SeguridadSettings } from "@/components/ajustes/seguridad-settings";
import { SubNav } from "@/components/app/sub-nav";
import { PushSettings } from "@/components/ajustes/push-settings";
import { ShortcutSettings } from "@/components/ajustes/shortcut-settings";
import { ThemeSettings } from "@/components/ajustes/theme-settings";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Grupo } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { getBaseUrl } from "@/lib/base-url";
import { esAdministrador } from "@/lib/invitacion";
import { contarCuentas } from "@/lib/supabase/consultas-compartidas";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Ajustes" };

export default async function AjustesPage() {
  const supabase = await createClient();
  // La de producción, no la del despliegue que estés mirando: el Atajo se monta
  // una vez y tiene que seguir funcionando.
  const baseUrl = await getBaseUrl();

  const [
    { data: user },
    counts,
    { data: devices },
    { data: accountList },
    { data: profile },
    { data: rechazos },
    { data: cardList },
    { data: suscripciones },
  ] = await Promise.all([
    supabase.auth.getUser(),
    Promise.all([
      supabase.from("category").select("*", { count: "exact", head: true }),
      // La misma cuenta que hace el armazón: memorizada por petición.
      contarCuentas().then((count) => ({ count })),
      supabase
        .from("merchant_rule")
        .select("*", { count: "exact", head: true }),
    ]),
    supabase
      .from("ingest_device")
      .select(
        "id, name, token_prefix, last_used_at, request_count, rejected_count",
      )
      .is("revoked_at", null)
      .order("created_at"),
    supabase
      .from("account")
      .select("id, name")
      .eq("archived", false)
      // El Atajo no apunta pagos en la cuenta de un préstamo.
      .neq("type", "PRESTAMO")
      .order("name"),
    supabase.from("profile").select("default_ingest_account_id").maybeSingle(),
    // Los últimos envíos rechazados, con lo que llegó de verdad. Es lo que
    // convierte «no me entra el pago» en «mira, el importe venía vacío».
    supabase
      .from("ingest_dead_letter")
      .select("received_at, reason, payload")
      .order("received_at", { ascending: false })
      .limit(3),
    // Las tarjetas, de la tabla `card` (varias por cuenta), para el ejemplo del
    // token y la nota de «una automatización por tarjeta».
    supabase.from("card").select("account_id, last4"),
    // Los dispositivos con avisos. Antes se pedían DESPUÉS de todo lo demás:
    // una ida y vuelta más a la base sin depender de nada.
    supabase
      .from("push_subscription")
      .select("id, user_agent, created_at")
      .is("failed_at", null)
      .order("created_at"),
  ]);

  const [categories, accounts, rules] = counts.map((c) => c.count ?? 0);

  // Invitar solo lo ve quien administra (la acción lo vuelve a comprobar por su
  // cuenta). El id viene de getUser(), validado; la lista, del servidor.
  const puedeInvitar = esAdministrador(user.user?.id, process.env.CARTERA_ADMIN_IDS);
  const factores = (user.user?.factors ?? []).map((f) => ({
    id: f.id,
    factor_type: f.factor_type,
    status: f.status,
    friendly_name: f.friendly_name ?? null,
    created_at: f.created_at,
  }));

  // Las tarjetas con el nombre de su cuenta (solo cuentas activas). Ordenadas por
  // cuenta y dígitos, como en la guía del Atajo.
  const nombrePorCuenta = new Map((accountList ?? []).map((a) => [a.id, a.name]));
  const tarjetas = (cardList ?? [])
    .flatMap((c) => {
      const name = nombrePorCuenta.get(c.account_id);
      return name ? [{ name, last4: c.last4 }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es") || a.last4.localeCompare(b.last4));

  return (
    <>
      <PageHeader title="Ajustes" subtitle={user.user?.email ?? undefined} />

      {/*
        Dos columnas en escritorio.

        Con una sola de 680 px había que desplazarse por seis grupos para llegar
        a «Sesión», y los cinco primeros dejaban media pantalla en blanco a la
        derecha. Los grupos son independientes entre sí —ninguno explica al
        siguiente—, así que reparten bien en dos columnas.
      */}
      <PageBody className="lg:grid lg:max-w-[1080px] lg:grid-cols-2 lg:items-start">
        <SubNav parent="/ajustes" />

        <ThemeSettings />

        <Grupo titulo="Organización" className="hidden lg:block">
          {[
            {
              href: "/categorias",
              label: "Categorías",
              icon: "tags",
              count: categories,
            },
            {
              href: "/cuentas",
              label: "Cuentas",
              icon: "wallet",
              count: accounts,
            },
            {
              href: "/reglas",
              label: "Reglas de comercio",
              icon: "repeat",
              count: rules,
            },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="fila-pulsable flex min-h-[52px] items-center gap-3 hair-t border-separator px-[18px] py-2 text-fg first:border-t-0"
            >
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                <Icon name={item.icon} size={16} />
              </span>
              <span className="flex-1 text-[15px] font-semibold">
                {item.label}
              </span>
              <span className="text-[15px] text-muted tabular-nums">
                {item.count}
              </span>
              <Icon name="chevron-right" size={18} />
            </Link>
          ))}
        </Grupo>

        <ShortcutSettings
          devices={devices ?? []}
          baseUrl={baseUrl}
          accounts={accountList ?? []}
          tarjetas={tarjetas}
          defaultAccountId={profile?.default_ingest_account_id ?? null}
          rechazos={rechazos ?? []}
        />

        <PushSettings
          publicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null}
          suscripciones={suscripciones ?? []}
        />

        <ExportSettings />

        <SeguridadSettings factores={factores} />

        {puedeInvitar ? <InvitarSettings /> : null}

        <Grupo titulo="Sesión">
          <div className="flex min-h-[60px] items-center gap-3 px-[18px] py-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[15px] font-semibold">
                {user.user?.email}
              </span>
              <span className="text-[13px] leading-[18px] text-muted">
                {factores.some((f) => f.status === "verified")
                  ? "Con verificación en dos pasos"
                  : "Solo con contraseña"}
              </span>
            </span>
            <SignOutButton />
          </div>
        </Grupo>

        <p className="px-1 text-center text-[13px] leading-[18px] text-muted lg:col-span-2">
          Cartera · datos en Supabase (Frankfurt) · aislados por usuario
        </p>
      </PageBody>
    </>
  );
}
