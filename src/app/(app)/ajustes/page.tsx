import { PageBody, PageHeader } from "@/components/app/page-header";
import { ExportSettings } from "@/components/ajustes/export-settings";
import { InvitarSettings } from "@/components/ajustes/invitar-settings";
import { LosaCuenta } from "@/components/ajustes/losa-cuenta";
import { SeguridadSettings } from "@/components/ajustes/seguridad-settings";
import { SubNav } from "@/components/app/sub-nav";
import { PushSettings } from "@/components/ajustes/push-settings";
import { ShortcutSettings } from "@/components/ajustes/shortcut-settings";
import { ThemeSettings } from "@/components/ajustes/theme-settings";
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
    { data: tarjetasCartera },
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
    // Las tarjetas de Cartera y su cuenta: el aviso las nombra, no da dígitos.
    supabase.from("wallet_card").select("id, name, account_id").order("name"),
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
      <PageHeader title="Ajustes" />

      {/*
        El ancho alinea el cuerpo con la cabecera a 1440 px, y cada sección lleva
        su fila (ver `SeccionAjustes`): nada de repartir bloques de alturas
        distintas en dos columnas, que deja un hueco al lado de cada uno corto.
      */}
      <PageBody className="lg:max-w-[1200px] lg:gap-8">
        <LosaCuenta
          email={user.user?.email ?? ""}
          conDosPasos={factores.some((f) => f.status === "verified")}
          accesos={[
            { href: "/cuentas", label: "Cuentas", count: accounts },
            { href: "/categorias", label: "Categorías", count: categories },
            { href: "/reglas", label: "Reglas de comercio", count: rules },
          ]}
        />

        <SubNav parent="/ajustes" />

        <ThemeSettings />

        <ShortcutSettings
          devices={devices ?? []}
          baseUrl={baseUrl}
          accounts={accountList ?? []}
          tarjetas={tarjetas}
          defaultAccountId={profile?.default_ingest_account_id ?? null}
          rechazos={rechazos ?? []}
          tarjetasCartera={tarjetasCartera ?? []}
        />

        <PushSettings
          publicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null}
          suscripciones={suscripciones ?? []}
        />

        <ExportSettings />

        <SeguridadSettings factores={factores} />

        {puedeInvitar ? <InvitarSettings /> : null}

        <p className="px-1 text-center text-[13px] leading-[18px] text-muted lg:hair-t lg:border-hairline lg:pt-6">
          Cartera · datos en Supabase (Frankfurt) · aislados por usuario
        </p>
      </PageBody>
    </>
  );
}
