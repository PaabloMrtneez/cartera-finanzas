"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  createIngestDevice,
  revokeIngestDevice,
  setDefaultIngestAccount,
} from "@/app/(app)/ajustes/actions";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { Grupo } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { shortDateTime } from "@/lib/dates";
import { llamarAccion } from "@/lib/llamar-accion";

type Device = {
  id: string;
  name: string;
  token_prefix: string;
  last_used_at: string | null;
  request_count: number;
  rejected_count: number;
};

type Rechazo = {
  received_at: string;
  reason: string;
  payload: unknown;
};

/** El motivo en castellano, y qué hacer. */
const MOTIVOS: Record<string, string> = {
  invalid_amount: "el importe no se entendía",
  invalid_payload: "faltaba algún campo",
  currency_not_supported: "la moneda no era euro",
  NO_ACCOUNT: "no se supo a qué cuenta iba",
  invalid_date: "la fecha no era válida",
  BAD_DATE: "la fecha no era válida",
  invalid_card: "los dígitos de la tarjeta no eran válidos",
  BAD_CARD: "los dígitos de la tarjeta no eran válidos",
  DB_ERROR: "no se pudo guardar; se ha quedado aquí para revisarlo",
};

/**
 * Copia un texto al portapapeles y lo confirma.
 *
 * Existe porque el token se enseñaba cortado en la línea que había que copiar,
 * con puntos suspensivos incluidos. Se copió incompleto, y un token incompleto
 * respondía «importe no válido»: dos errores encadenados que costaron dos pagos
 * perdidos y un buen rato de búsqueda.
 */
function CopiarBoton({ texto }: { texto: string }) {
  const [copiado, setCopiado] = useState(false);

  return (
    <Button
      variant="secondary"
      size="compact"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(texto);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        } catch {
          // Sin permiso de portapapeles queda el `select-all` de arriba.
          setCopiado(false);
        }
      }}
    >
      <Icon name={copiado ? "check" : "clipboard"} size={14} />
      {copiado ? "Copiado" : "Copiar «Bearer + token»"}
    </Button>
  );
}

/**
 * Una variable del atajo, pintada como la pinta iOS: una pastilla de color.
 *
 * Antes se escribía «[Importe]» y era ambiguo entre «inserta la variable» y
 * «teclea esto». Alguien lo tecleó, llegó la palabra en lugar de la cifra y se
 * perdieron dos pagos. Con la pastilla no hay confusión posible.
 */
function VariableChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-xs bg-accent-soft px-[5px] py-[1px] text-[13px] font-semibold text-accent-text">
      {children}
    </span>
  );
}

/** Días desde la última vez que el atajo mandó algo. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export function ShortcutSettings({
  devices,
  baseUrl,
  accounts,
  tarjetas,
  defaultAccountId,
  rechazos,
}: {
  devices: Device[];
  baseUrl: string;
  accounts: { id: string; name: string }[];
  /**
   * Las tarjetas del usuario, de la tabla `card`, con el nombre de su cuenta. El
   * ejemplo usa una real para poder pegarlo tal cual, y la nota las lista todas
   * —una automatización por cada una—.
   */
  tarjetas: { name: string; last4: string }[];
  defaultAccountId: string | null;
  /** Los últimos envíos que se rechazaron, con lo que llegó de verdad. */
  rechazos: Rechazo[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("iPhone");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorRevocar, setErrorRevocar] = useState<string | null>(null);
  const [errorCuenta, setErrorCuenta] = useState<string | null>(null);
  const [reinicioCuenta, setReinicioCuenta] = useState(0);
  const [pending, startTransition] = useTransition();

  const digitos = tarjetas[0]?.last4 ?? "4412";

  function onCreate() {
    setError(null);
    startTransition(async () => {
      const result = await llamarAccion(() => createIngestDevice(name), "conectado");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setToken(result.token ?? null);
    });
  }

  return (
    <Grupo titulo="El Atajo del iPhone">
      <p className="px-[18px] pt-4 pb-2 text-[13px] leading-[18px] text-muted">
        Cuando pagas con Apple Pay, un Atajo manda el cargo aquí y entra solo. Si una regla de
        comercio acierta la categoría, se confirma sin preguntarte; si no, espera en pendientes.
      </p>
      <p className="px-[18px] pb-3 text-[13px] leading-[18px]">
        <Link href="/atajo" className="toque relative font-semibold text-accent-text">
          Ver la guía para montarlo
        </Link>
      </p>

      {devices.map((device) => {
        const days = daysSince(device.last_used_at);
        const quiet = days !== null && days >= 5;

        return (
          <div
            key={device.id}
            className="flex min-h-[60px] items-center gap-3 hair-t border-separator px-[18px] py-2"
          >
            <span
              className={cn(
                "flex size-[38px] shrink-0 items-center justify-center rounded-full",
                quiet ? "bg-surface-2 text-warning" : "bg-accent-soft text-accent",
              )}
            >
              <Icon name="smartphone" size={19} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[15px] font-semibold">{device.name}</span>
              <span className="truncate text-[13px] leading-[18px] text-muted tabular-nums">
                {/*
                  Distinguir «no llega nada» de «llega y se rechaza» es la
                  diferencia entre revisar la automatización y revisar los
                  campos. Antes las dos cosas decían «0 envíos».
                */}
                {device.last_used_at === null
                  ? "Todavía no ha mandado nada"
                  : device.request_count === 0 && device.rejected_count > 0
                    ? `Está llegando, pero se rechaza · ${device.rejected_count} ${device.rejected_count === 1 ? "intento" : "intentos"}`
                    : days === 0
                      ? `Activo hoy · ${envios(device.request_count)}${device.rejected_count > 0 ? ` · ${device.rejected_count} ${device.rejected_count === 1 ? "rechazado" : "rechazados"}` : ""}`
                      : `Lleva ${days} ${days === 1 ? "día" : "días"} callado · ${envios(device.request_count)}`}
              </span>
            </span>
            {/* Revocar deja el Atajo de ese iPhone sin acceso al momento: pide un
                segundo toque, y si falla lo dice (antes se ignoraba). */}
            <BotonConfirmar
              variant="ghost"
              size="compact"
              confirmar="Sí, revocar"
              disabled={pending}
              className="text-expense"
              onConfirm={() =>
                startTransition(async () => {
                  setErrorRevocar(null);
                  const r = await llamarAccion(() => revokeIngestDevice(device.id), "revocado");
                  if (!r.ok) {
                    setErrorRevocar(r.error);
                    return;
                  }
                })
              }
            >
              Revocar
            </BotonConfirmar>
          </div>
        );
      })}
      {errorRevocar ? (
        <div className="px-[18px] pb-3">
          <FieldError>{errorRevocar}</FieldError>
        </div>
      ) : null}

      {/*
        Los últimos envíos rechazados, con lo que llegó de verdad. Esto existe
        porque dos pagos reales se perdieron y hubo que rebuscar en la base de
        datos para descubrir que el atajo mandaba el texto «[Importe]» en lugar
        de la variable. Con el valor delante, se ve sin salir de aquí.
      */}
      {rechazos.length > 0 ? (
        <div className="flex flex-col gap-2 hair-t border-separator bg-surface-2 px-[18px] py-3">
          <span className="flex items-center gap-2">
            <span className="text-warning">
              <Icon name="triangle-alert" size={15} />
            </span>
            <span className="text-[13px] font-semibold">
              {rechazos.length === 1
                ? "Un envío rechazado"
                : `Los ${rechazos.length} últimos envíos rechazados`}
            </span>
          </span>

          <ul className="flex flex-col gap-2">
            {rechazos.map((r) => {
              const datos = (r.payload ?? {}) as Record<string, unknown>;
              const importe = String(datos.amount ?? "");
              return (
                <li key={r.received_at} className="flex flex-col text-[13px] leading-[18px]">
                  <span className="text-muted tabular-nums">
                    {shortDateTime(r.received_at)} · {MOTIVOS[r.reason] ?? r.reason}
                  </span>
                  <span className="font-mono">
                    importe: {importe === "" ? "(vacío)" : `«${importe}»`}
                    {datos.merchant ? ` · comercio: «${String(datos.merchant)}»` : ""}
                  </span>
                </li>
              );
            })}
          </ul>

          <p className="text-[13px] leading-[18px] text-muted">
            Si el importe llega vacío o con el nombre de la variable escrito, el campo del atajo
            lleva texto en lugar de la variable.{" "}
            <Link href="/atajo" className="font-semibold text-accent-text">
              Cómo arreglarlo
            </Link>
          </p>
        </div>
      ) : null}

      {/*
        A qué cuenta va un cargo cuya tarjeta no reconoce ninguna. Sin esto, un
        pago con una tarjeta no dada de alta se rechazaría y no habría manera de
        arreglarlo desde la app.
      */}
      <div className="flex flex-col gap-2 hair-t border-separator px-[18px] py-3">
        <Label htmlFor="default-account">Si no reconoce la tarjeta, apuntar en</Label>
        {/* Si no llega a guardarse (sin red), el `key` devuelve el desplegable a
            lo que había: no puede quedarse enseñando una cuenta que no se guardó. */}
        <Select
          key={reinicioCuenta}
          id="default-account"
          defaultValue={defaultAccountId ?? "__rechazar"}
          disabled={pending}
          onValueChange={(v) =>
            startTransition(async () => {
              setErrorCuenta(null);
              const r = await llamarAccion(() =>
                setDefaultIngestAccount(v === "__rechazar" ? null : v),
              );
              if (!r.ok) {
                setErrorCuenta(r.error);
                setReinicioCuenta((n) => n + 1);
              }
            })
          }
        >
          <SelectItem value="__rechazar">Rechazar el cargo</SelectItem>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.name}
            </SelectItem>
          ))}
        </Select>
        <p className="text-[13px] leading-[18px] text-muted">
          Lo normal es que cada cuenta lleve sus cuatro dígitos y el cargo vaya solo al sitio
          correcto. Esto es la red de seguridad para el resto.
        </p>
        <FieldError>{errorCuenta}</FieldError>
      </div>

      <div className="hair-t border-separator p-3">
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) {
              setToken(null);
              setError(null);
            }
          }}
        >
          <DialogTrigger asChild>
            <Button variant="secondary" size="compact" className="w-full">
              <Icon name="plus" size={15} />
              Conectar un dispositivo
            </Button>
          </DialogTrigger>

          <DialogContent
            size="cierre"
            title={token ? "Guarda este token ahora" : "Conectar el iPhone"}
            description={
              token
                ? "No se puede volver a ver. Si lo pierdes, genera otro."
                : "Se creará un token que solo puede registrar movimientos: no puede leer nada."
            }
          >
            {token ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-3">
                  <span className="text-[13px] leading-[18px] font-semibold tracking-[0.03em] text-muted uppercase">
                    Token
                  </span>
                  <code className="font-mono text-[13px] leading-5 break-all select-all">
                    {token}
                  </code>
                  {/*
                    Copiar «Bearer + token» de una vez, que es exactamente lo que
                    va en el campo. Seleccionar setenta caracteres a dedo en un
                    móvil se corta a la primera, y un token cortado responde
                    «importe no válido», que manda a mirar el sitio equivocado.
                  */}
                  <CopiarBoton texto={`Bearer ${token}`} />
                </div>

                <ol className="flex list-decimal flex-col gap-2 pl-5 text-[15px] leading-5">
                  <li>Abre <b>Atajos</b> en el iPhone y ve a <b>Automatización</b>.</li>
                  <li>
                    Crea una nueva y elige <b>Wallet</b> (en iOS 17 y 18 se llama{" "}
                    <b>Transacción</b>). Selecciona tu tarjeta.
                  </li>
                  <li>Marca <b>Ejecutar inmediatamente</b>, para que no te pregunte cada vez.</li>
                  <li>
                    Añade la acción <b>Obtener contenido de URL</b> con estos datos:
                  </li>
                </ol>

                <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-3 text-[13px] leading-5">
                  <p className="break-all font-mono">
                    <b>URL:</b> {baseUrl}/api/ingest
                  </p>
                  <p className="font-mono">
                    <b>Método:</b> POST
                  </p>

                  {/*
                    iOS no pide «la cabecera», pide una Clave y un Texto. Escrito
                    como `Authorization: Bearer X` hay que deducir que se parte en
                    dos, y es facilísimo dejar los dos puntos dentro de la clave o
                    poner el token sin la palabra Bearer delante.
                  */}
                  <p className="pt-1">
                    <b>Cabecera</b> · pulsa «Añadir cabecera nueva»
                  </p>
                  <p className="font-mono">
                    Clave: Authorization
                    <br />
                    Texto: <span className="text-muted">el botón «Copiar» de arriba</span>
                  </p>

                  <p className="pt-1">
                    <b>Cuerpo</b> · JSON, tres campos de tipo Texto
                  </p>
                  <p className="font-mono">
                    Clave: merchant · Texto: <VariableChip>Comercio</VariableChip>
                    <br />
                    Clave: amount · Texto: <VariableChip>Importe</VariableChip>
                    <br />
                    Clave: card · Texto: {digitos}
                  </p>
                </div>

                <div className="flex flex-col gap-2 text-[13px] leading-[18px] text-muted">
                  <p>
                    Lo que va en <span className="rounded-xs bg-accent-soft px-[5px] py-[1px] font-semibold text-accent-text">cian</span>{" "}
                    son <b>variables</b>: se eligen tocando el nombre en la barra de sugerencias del
                    teclado. <b>No se escriben.</b> Si teclas «Importe» a mano, llega la palabra en
                    lugar de la cifra y el cargo se rechaza.
                  </p>
                  <p>
                    Y el botón de <b>probar</b> del editor de Atajos siempre va a fallar: sin un
                    pago real el disparador no tiene importe que dar. Se comprueba pagando algo
                    pequeño.
                  </p>
                  <p>
                    <b>La tarjeta no.</b> Son los <b>cuatro dígitos escritos a mano</b>, no el token
                    ni el nombre. Sirven para llevar el cargo a su cuenta; si no casan con ninguna,
                    va a la de respaldo que hayas elegido arriba.
                    {tarjetas.length > 1
                      ? ` Cada automatización es de UNA tarjeta: monta una por cada una cambiando solo este campo — ${tarjetas
                          .map((t) => `${t.name} ${t.last4}`)
                          .join(", ")}.`
                      : tarjetas.length === 1
                        ? ` Los de ${tarjetas[0].name} son ${tarjetas[0].last4}.`
                        : ""}
                  </p>
                  <p>
                    No hace falta un identificador único: si no lo mandas, el servidor se lo inventa
                    con el comercio, el importe, la tarjeta y el minuto, así que un reintento por
                    tiempo agotado tampoco duplica el cargo.
                  </p>
                  <p>
                    <Link href="/atajo" className="font-semibold text-accent-text">
                      La guía completa, paso a paso
                    </Link>
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-[6px]">
                  <Label htmlFor="device-name">Nombre del dispositivo</Label>
                  <Input
                    id="device-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={40}
                    placeholder="iPhone de Pablo"
                  />
                </div>
                <FieldError>{error}</FieldError>
                <DialogFooter>
                  <Button block onClick={onCreate} disabled={pending}>
                    {pending ? "Creando…" : "Crear el token"}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </Grupo>
  );
}

/** «1 envío», «3 envíos». */
function envios(n: number) {
  return `${n} ${n === 1 ? "envío" : "envíos"}`;
}
