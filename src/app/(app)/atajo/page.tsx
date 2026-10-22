import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { getBaseUrl } from "@/lib/base-url";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/server";
import { CARD_TYPE_LABELS } from "@/lib/types";

export const metadata = { title: "El Atajo del iPhone" };

/**
 * Cómo montar el Atajo en el iPhone, paso a paso.
 *
 * Estaba enlazada desde Ajustes en el prototipo («Ver la guía») pero no
 * existía, así que el token se creaba y nadie decía qué hacer con él.
 *
 * También dice lo que el Atajo NO puede hacer. El disparador de Wallet solo se
 * activa con Apple Pay: ni tarjeta física ni compras online tecleando el
 * número. Descubrir eso a las tres semanas, viendo que faltan gastos, es peor
 * que saberlo desde el principio.
 */
export default async function AtajoPage() {
  const endpoint = `${await getBaseUrl()}/api/ingest`;

  // Las tarjetas del usuario, de la tabla `card` (varias por cuenta). Se listan
  // para que sepa qué poner en el campo `card` de CADA automatización: una por
  // tarjeta. Se cruzan con la cuenta para dar su nombre y descartar las de
  // cuentas archivadas —esas no enrutan, la ingesta las excluye—.
  const supabase = await createClient();
  const [{ data: cards }, { data: accounts }] = await Promise.all([
    supabase.from("card").select("id, account_id, last4, type, nickname"),
    supabase.from("account").select("id, name, archived"),
  ]);

  const cuentas = new Map((accounts ?? []).map((a) => [a.id, a]));
  const tarjetas = (cards ?? [])
    .flatMap((c) => {
      const cuenta = cuentas.get(c.account_id);
      if (!cuenta || cuenta.archived) return [];
      return [{ ...c, cuentaNombre: cuenta.name }];
    })
    .sort(
      (a, b) =>
        a.cuentaNombre.localeCompare(b.cuentaNombre, "es") || a.last4.localeCompare(b.last4),
    );

  return (
    <>
      <PageHeader title="El Atajo del iPhone" subtitle="Cómo montarlo" />

      <PageBody className="lg:max-w-[680px]">
        <Card className="p-4 lg:px-5">
          <Eyebrow>Antes de empezar</Eyebrow>
          <p className="mt-2 text-[15px] leading-5 text-muted">
            Necesitas un token de dispositivo. Se crea en{" "}
            <Link href="/ajustes" className="font-semibold text-accent-text">
              Ajustes
            </Link>{" "}
            y se enseña <b>una sola vez</b>: cópialo antes de cerrar la ventana, porque después ya
            no se puede recuperar. Se guarda cifrado, así que ni la app puede volver a leerlo.
          </p>
        </Card>

        <Card>
          <CardHeader title="Los cinco pasos" />
          <ol className="flex flex-col">
            {[
              {
                titulo: "Atajos › Automatización › +",
                detalle:
                  "Busca «Transacción». En iOS 26 se llama «Wallet». Es la que salta al pagar con Apple Pay.",
              },
              {
                titulo: "Elige la tarjeta y «Ejecutar inmediatamente»",
                detalle:
                  "Selecciona la tarjeta que usas con Apple Pay. Si dejas «Preguntar antes de ejecutar», el cargo no entrará solo: te pedirá permiso cada vez.",
              },
              {
                titulo: "Añade «Obtener contenido de la URL» y pon esta dirección",
                detalle: endpoint,
                monospace: true,
              },
              {
                titulo: "Despliega la acción y pon el método en POST",
                detalle:
                  "La flecha de «Mostrar más» abre Método, Cabeceras y Cuerpo de la solicitud. Los tres hay que tocarlos.",
              },
              {
                titulo: "Paga algo pequeño y míralo entrar",
                detalle:
                  "Si una regla de comercio acierta la categoría, entra confirmado. Si no, te espera en pendientes.",
              },
            ].map((paso, i) => (
              <li
                key={paso.titulo}
                className="flex gap-3 hair-t border-separator px-4 py-3 first:border-t-0 lg:px-5"
              >
                <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-text tabular-nums">
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="text-[15px] font-semibold">{paso.titulo}</span>
                  <span
                    className={
                      paso.monospace
                        ? "break-all rounded-sm bg-surface-2 px-2 py-1 font-mono text-[13px] leading-[18px]"
                        : "text-[13px] leading-[18px] text-muted"
                    }
                  >
                    {paso.detalle}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </Card>

        {/*
          Lo que costaba adivinar: iOS no pide «la cabecera», pide una Clave y un
          Texto. Sin decirlo así, hay que deducir que `Authorization: Bearer X`
          se parte en dos campos, y es fácil meter los dos puntos dentro de la
          clave o el token sin la palabra Bearer.
        */}
        <Card>
          <CardHeader title="Cabeceras" />
          <p className="px-4 pb-3 text-[13px] leading-[18px] text-muted lg:px-5">
            Pulsa <b>Añadir cabecera nueva</b>. iOS pide una <b>Clave</b> y un <b>Texto</b>: es un
            par, no una línea. Solo hace falta una cabecera.
          </p>
          <ParesTabla
            filas={[
              { clave: "Authorization", valor: "Bearer + tu token", nota: "Con «Bearer », espacio incluido, delante del token." },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Cuerpo de la solicitud" />
          <p className="px-4 pb-3 text-[13px] leading-[18px] text-muted lg:px-5">
            Elige <b>JSON</b> y pulsa <b>Añadir campo nuevo</b> tres veces, del tipo{" "}
            <b>Texto</b>. Cada campo vuelve a pedir <b>Clave</b> y <b>Texto</b>.
          </p>
          <ParesTabla
            filas={[
              {
                clave: "merchant",
                valor: "Comercio",
                variable: true,
                nota: "VARIABLE: se elige tocándola en la barra de sugerencias del teclado. Si escribes «Comercio» a mano, llega la palabra en lugar del nombre del sitio.",
              },
              {
                clave: "amount",
                valor: "Importe",
                variable: true,
                nota: "VARIABLE también. Da igual que llegue como «23,45 €» o «€23.45»: se convierte en el servidor. Pero si la escribes a mano, el cargo se rechaza por importe no válido.",
              },
              {
                clave: "card",
                valor: "los 4 dígitos",
                nota: "Escrito a mano, no una variable. Es de una tarjeta concreta; si pagas con varias, monta una automatización por cada una (los dígitos de las tuyas, más abajo).",
              },
            ]}
          />
          <p className="px-4 pt-1 pb-2 text-[13px] leading-[18px] text-warning lg:px-5">
            El botón de <b>probar</b> del editor de Atajos siempre dará «importe no válido»: sin un
            pago real el disparador no tiene importe que dar. No es un fallo tuyo. Se comprueba
            pagando algo pequeño.
          </p>
          <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
            Y nada más: <b>no hace falta un identificador único</b>. Si no lo mandas, el servidor se
            lo inventa a partir de comercio, importe, tarjeta y minuto, así que un reintento por
            tiempo agotado tampoco duplica el cargo.
          </p>
        </Card>

        {/* Multi-tarjeta: una automatización por cada tarjeta, cambiando solo `card`. */}
        <Card>
          <CardHeader title="Una automatización por tarjeta" />
          <p className="px-4 pb-3 text-[13px] leading-[18px] text-muted lg:px-5">
            Cada automatización es de una tarjeta concreta. Si pagas con varias, monta{" "}
            <b>una por cada una</b>: idénticas, cambiando solo los 4 dígitos del campo{" "}
            <span className="font-mono">card</span>. El mismo token vale para todas.
          </p>
          {tarjetas.length > 0 ? (
            <ul>
              {tarjetas.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-3 hair-t border-separator px-4 py-2 lg:px-5"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px] font-semibold">{t.cuentaNombre}</span>
                    <span className="truncate text-[13px] leading-[18px] text-muted">
                      {CARD_TYPE_LABELS[t.type]}
                      {t.nickname ? ` · ${t.nickname}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[14px] font-semibold tabular-nums">
                    card: {t.last4}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-[13px] leading-[18px] text-muted lg:px-5">
              Aún no has asociado los 4 dígitos a ninguna cuenta.{" "}
              <Link href="/cuentas" className="font-semibold text-accent-text">
                Hazlo en Cuentas
              </Link>{" "}
              y aquí verás qué poner en el campo <span className="font-mono">card</span> de cada
              automatización.
            </p>
          )}
        </Card>

        <Card className="p-4 lg:px-5">
          <span className="flex items-center gap-2">
            <span className="text-warning">
              <Icon name="triangle-alert" size={16} />
            </span>
            <span className="text-[15px] font-semibold">Lo que el Atajo no puede capturar</span>
          </span>
          <p className="mt-2 text-[15px] leading-5 text-muted">
            El disparador solo se activa con <b>Apple Pay</b>: con la tarjeta en Wallet, por NFC o
            en apps y webs que lo admitan. <b>No</b> captura los pagos con la tarjeta física ni las
            compras online tecleando el número.
          </p>
          <p className="mt-2 text-[15px] leading-5 text-muted">
            Esos hay que apuntarlos a mano, o traerlos de una vez con el{" "}
            <Link href="/importar" className="font-semibold text-accent-text">
              importador de extractos
            </Link>
            .
          </p>
        </Card>

        <Card className="p-4 lg:px-5">
          <Eyebrow>Si algo no llega</Eyebrow>
          <ul className="mt-2 flex flex-col gap-2 text-[15px] leading-5 text-muted">
            <li>
              · Comprueba en{" "}
              <Link href="/ajustes" className="font-semibold text-accent-text">
                Ajustes
              </Link>{" "}
              cuántos envíos lleva el dispositivo. Si dice cero, el Atajo no está llegando.
            </li>
            <li>
              · El disparador de Wallet tiene tiempos de espera y reintenta. Por eso cada envío
              lleva su propio identificador: un reintento no duplica el cargo.
            </li>
            <li>
              · Si el cargo entra pero sin categoría, créale una{" "}
              <Link href="/reglas" className="font-semibold text-accent-text">
                regla de comercio
              </Link>{" "}
              y podrás aplicarla a los anteriores de golpe.
            </li>
          </ul>
        </Card>
      </PageBody>
    </>
  );
}

/**
 * Los pares clave/valor tal y como los pide iOS.
 *
 * Con dos columnas rotuladas «Clave» y «Texto» no hay que traducir nada: se
 * copia lo de la izquierda en el primer campo y lo de la derecha en el segundo.
 */
function ParesTabla({
  filas,
}: {
  filas: { clave: string; valor: string; nota?: string; variable?: boolean }[];
}) {
  return (
    <ul className="flex flex-col">
      {filas.map((f) => (
        <li key={f.clave} className="flex flex-col gap-1 hair-t border-separator px-4 py-3 lg:px-5">
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="flex flex-col">
              <span className="text-[13px] leading-[18px] font-semibold text-muted">Clave</span>
              <span className="font-mono text-[13px] font-semibold">{f.clave}</span>
            </span>
            <span className="flex flex-col">
              <span className="text-[13px] leading-[18px] font-semibold text-muted">Texto</span>
              <span
                className={
                  f.variable
                    ? "rounded-xs bg-accent-soft px-[6px] py-[1px] font-mono text-[13px] font-semibold text-accent-text"
                    : "font-mono text-[13px] font-semibold"
                }
              >
                {f.valor}
              </span>
            </span>
          </span>
          {f.nota ? (
            <span className="text-[13px] leading-[18px] text-muted">{f.nota}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
