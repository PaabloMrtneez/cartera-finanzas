"use client";

import { useId, useState, useTransition } from "react";
import { buscarInstrumentos, seguirInstrumento } from "@/app/(app)/inversiones/mercado-actions";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { shortDate, todayIso } from "@/lib/dates";
import {
  NOMBRE_TIPO,
  aportadoHasta,
  formatParticipaciones,
  formatPrecio,
  valorEnCentimos,
} from "@/lib/mercado";
import { formatCents, formatCentsPlain } from "@/lib/money";
import { parseParticipaciones } from "@/lib/participaciones";
import type { Candidato } from "@/lib/precios/fuentes";
import { llamarAccion } from "@/lib/llamar-accion";

/** Una posición manual que se puede pasar a seguir una cotización. */
export type PosicionConvertible = {
  position_id: string;
  name: string;
  /** Los traspasos ya enlazados a ella: pre-rellenan el «total aportado». */
  aportes: { fecha: string; cents: number }[];
};

type Paso = "buscar" | "datos";
type Destino = "nueva" | "existente";

type Busqueda = { consulta: string; candidatos: Candidato[]; isin: string | null };

/** Errores de la búsqueda que significan «Yahoo no está», no «no existe». */
const YAHOO_CAIDO = /no responde|no se entiende/i;

/**
 * El cuerpo de «Seguir cotización». Dos pasos en la misma hoja:
 *
 *   1. BUSCAR por ISIN o por nombre y elegir la candidata. Un mismo fondo
 *      cotiza en varias clases (LC, LD, en dólares…) con precios distintos;
 *      cada candidata enseña su divisa, su mercado y su último precio con su
 *      fecha, que es lo que se compara con MyInvestor.
 *   2. LOS DATOS: posición nueva o una manual que ya tienes, participaciones
 *      exactas (texto con coma, nunca un float), total aportado y fecha. El %
 *      de ganancia no se pide: se deriva.
 *
 * Las candidatas son radios nativos: las flechas del teclado las recorren y el
 * lector de pantalla las anuncia como un grupo, sin reinventar nada.
 */
export default function SeguirDialogContent({
  accounts,
  manuales,
  posicionId,
  open,
  onOpenChange,
}: {
  accounts: { id: string; name: string }[];
  manuales: PosicionConvertible[];
  posicionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ids = useId();
  const preset = posicionId ? (manuales.find((m) => m.position_id === posicionId) ?? null) : null;

  const [paso, setPaso] = useState<Paso>("buscar");

  // Paso 1
  const [consulta, setConsulta] = useState("");
  const [busqueda, setBusqueda] = useState<Busqueda | null>(null);
  const [errorBusqueda, setErrorBusqueda] = useState<string | null>(null);
  const [elegido, setElegido] = useState<string | null>(null);
  const [buscando, startBuscar] = useTransition();

  // Paso 2
  const [destino, setDestino] = useState<Destino>(preset ? "existente" : "nueva");
  const [existenteId, setExistenteId] = useState(preset?.position_id ?? "");
  const [nombre, setNombre] = useState("");
  const [cuenta, setCuenta] = useState(accounts.length === 1 ? accounts[0].id : "");
  const [color, setColor] = useState("#6d4bc4");
  const [participaciones, setParticipaciones] = useState("");
  const [errorParticipaciones, setErrorParticipaciones] = useState<string | null>(null);
  const [fecha, setFecha] = useState(todayIso());
  // null: sin tocar, se deriva de lo ya aportado. Al escribir, manda lo escrito.
  const [aportadoEscrito, setAportadoEscrito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, startGuardar] = useTransition();

  const candidata = busqueda?.candidatos.find((c) => c.simbolo === elegido) ?? null;
  const existente =
    destino === "existente" ? (manuales.find((m) => m.position_id === existenteId) ?? null) : null;

  // Lo que ya está enlazado a la posición hasta esa fecha, en céntimos enteros.
  const aportadoDerivado = existente ? aportadoHasta(existente.aportes, fecha) : null;
  const aportado =
    aportadoEscrito ?? (aportadoDerivado !== null ? formatCentsPlain(aportadoDerivado) : "");

  const lectura = participaciones.trim() ? parseParticipaciones(participaciones) : null;
  const vistaPrevia =
    candidata?.ultimoPrecio && candidata.divisa === "EUR" && lectura?.ok
      ? valorEnCentimos(lectura.valor, candidata.ultimoPrecio)
      : null;

  function reiniciar() {
    setPaso("buscar");
    setConsulta("");
    setBusqueda(null);
    setErrorBusqueda(null);
    setElegido(null);
    setParticipaciones("");
    setErrorParticipaciones(null);
    setAportadoEscrito(null);
    setNombre("");
    setError(null);
  }

  function buscar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorBusqueda(null);
    const q = consulta.trim();
    startBuscar(async () => {
      const r = await llamarAccion(() => buscarInstrumentos(q), "cargado");
      if (!r.ok) {
        setBusqueda(null);
        setElegido(null);
        setErrorBusqueda(r.error);
        return;
      }
      setBusqueda({ consulta: q, candidatos: r.candidatos, isin: r.isin });
      // Con una sola candidata no hay nada que elegir.
      setElegido(r.candidatos.length === 1 ? r.candidatos[0].simbolo : null);
    });
  }

  function continuar() {
    if (!candidata) return;
    if (!nombre) setNombre(candidata.nombre.slice(0, 60));
    setError(null);
    setPaso("datos");
  }

  function guardar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!candidata) return;
    setError(null);

    const lecturaFinal = parseParticipaciones(participaciones);
    if (!lecturaFinal.ok) {
      setErrorParticipaciones(lecturaFinal.error);
      return;
    }

    startGuardar(async () => {
      const r = await llamarAccion(() =>
        seguirInstrumento({
          position_id: destino === "existente" ? existenteId || null : null,
          nueva:
            destino === "nueva" ? { name: nombre.trim(), account_id: cuenta, color } : null,
          simbolo: candidata.simbolo,
          isin: busqueda?.isin ?? null,
          // Tal cual se escribió: el servidor vuelve a leerlo y es quien manda.
          participaciones,
          aportado,
          fecha,
        }),
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onOpenChange(false);
      reiniciar();
    });
  }

  const n = busqueda?.candidatos.length ?? 0;
  const anuncio = buscando
    ? "Buscando…"
    : busqueda
      ? n === 0
        ? "Sin resultados."
        : `${n} ${n === 1 ? "candidata" : "candidatas"}.`
      : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(abierto) => {
        onOpenChange(abierto);
        if (!abierto) reiniciar();
      }}
    >
      <DialogContent
        size="buscar"
        title={preset ? `Seguir la cotización de ${preset.name}` : "Seguir un fondo o una acción"}
        description={
          paso === "buscar"
            ? "Su valor se actualizará solo cada día con el precio de Yahoo Finance."
            : "Lo que dice MyInvestor hoy. La ganancia y el % se calculan solos."
        }
      >
        {/* Una sola región viva para los dos pasos: se anuncia lo que cambia. */}
        <p aria-live="polite" className="sr-only">
          {anuncio}
        </p>

        {paso === "buscar" ? (
          <div className="flex flex-col gap-4">
            <form onSubmit={buscar} role="search" className="flex flex-col gap-[6px]">
              <Label htmlFor={`${ids}-q`}>ISIN o nombre</Label>
              <div className="flex gap-2">
                <Input
                  id={`${ids}-q`}
                  type="search"
                  autoComplete="off"
                  enterKeyHint="search"
                  required
                  minLength={2}
                  maxLength={80}
                  value={consulta}
                  onChange={(e) => setConsulta(e.target.value)}
                  placeholder="IE00BYX5NX33 o Fidelity MSCI World"
                  aria-describedby={`${ids}-q-ayuda`}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={buscando}
                  className="h-11 shrink-0 lg:h-[38px]"
                >
                  <Icon name="search" size={16} />
                  {buscando ? "Buscando…" : "Buscar"}
                </Button>
              </div>
              <p id={`${ids}-q-ayuda`} className="text-[13px] leading-[18px] text-muted">
                El ISIN está en la ficha del fondo en MyInvestor: dos letras y diez caracteres.
              </p>
            </form>

            {errorBusqueda ? (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px]"
              >
                <span className="mt-[1px] shrink-0 text-warning">
                  <Icon name="triangle-alert" size={16} />
                </span>
                <span className="flex flex-col gap-1">
                  <span className="font-semibold text-fg">{errorBusqueda}</span>
                  {YAHOO_CAIDO.test(errorBusqueda) ? (
                    <span className="text-muted">
                      Mientras tanto, la posición se puede seguir valorando a mano como siempre.
                    </span>
                  ) : null}
                </span>
              </div>
            ) : null}

            {buscando ? (
              <ul aria-hidden className="flex flex-col gap-2">
                {[0, 1, 2].map((i) => (
                  <li key={i} className="esqueleto h-[60px] rounded-md" />
                ))}
              </ul>
            ) : busqueda && n === 0 ? (
              <p className="rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted">
                Yahoo no encuentra nada con «{busqueda.consulta}». Prueba con el ISIN, o con
                una parte más corta del nombre (por ejemplo «MSCI World»).
              </p>
            ) : busqueda ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-[13px] leading-[18px] font-semibold text-muted">
                  Elige la que coincide con MyInvestor
                </legend>
                <p className="text-[13px] leading-[18px] text-muted">
                  Un mismo fondo cotiza en varias clases (LC, LD, FC, en dólares…) y cada una
                  tiene su precio. Quédate con la que tenga la misma divisa y el mismo precio que
                  ves en MyInvestor.
                </p>
                <ul className="flex flex-col overflow-hidden rounded-md hair border-hairline">
                  {busqueda.candidatos.map((c) => (
                    <li key={c.simbolo} className="hair-t border-separator first:border-t-0">
                      <label
                        className={cn(
                          "flex min-h-[60px] cursor-pointer items-start gap-3 px-3 py-3",
                          "transition-colors duration-150 ease-ui",
                          elegido === c.simbolo ? "bg-accent-soft" : "hover:bg-surface-2",
                        )}
                      >
                        <input
                          type="radio"
                          name={`${ids}-candidata`}
                          value={c.simbolo}
                          checked={elegido === c.simbolo}
                          onChange={() => setElegido(c.simbolo)}
                          className="mt-[3px] size-[18px] shrink-0 accent-accent"
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-[15px] leading-5 font-semibold">{c.nombre}</span>
                          <span className="text-[13px] leading-[18px] text-muted">
                            {NOMBRE_TIPO[c.tipo]} · {c.simbolo}
                            {c.mercado ? ` · ${c.mercado}` : ""} · {c.divisa}
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end text-right">
                          <span className="text-[15px] leading-5 font-semibold tabular-nums">
                            {c.ultimoPrecio ? formatPrecio(c.ultimoPrecio, c.divisa) : "Sin precio"}
                          </span>
                          <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                            {c.fechaUltimoPrecio ? `al ${shortDate(c.fechaUltimoPrecio)}` : "—"}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}

            <DialogFooter>
              <Button type="button" disabled={!candidata} block onClick={continuar}>
                Continuar
              </Button>
            </DialogFooter>
          </div>
        ) : candidata ? (
          <form onSubmit={guardar} className="flex flex-col gap-4">
            {/* La candidata elegida, para no perderla de vista mientras se escribe. */}
            <div className="flex items-start gap-3 rounded-md bg-surface-2 p-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] leading-5 font-semibold">{candidata.nombre}</span>
                <span className="text-[13px] leading-[18px] text-muted tabular-nums">
                  {NOMBRE_TIPO[candidata.tipo]} · {candidata.simbolo} · {candidata.divisa}
                  {candidata.ultimoPrecio && candidata.fechaUltimoPrecio
                    ? ` · ${formatPrecio(candidata.ultimoPrecio, candidata.divisa)} al ${shortDate(candidata.fechaUltimoPrecio)}`
                    : ""}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                className="text-accent-text"
                onClick={() => setPaso("buscar")}
              >
                Cambiar
              </Button>
            </div>

            {preset ? (
              <p className="text-[13px] leading-[18px] text-muted">
                Desde la fecha que pongas, «{preset.name}» valdrá participaciones × precio. Sus
                valoraciones a mano anteriores se conservan, y la curva del pasado no cambia.
              </p>
            ) : manuales.length > 0 ? (
              <Segmented
                label="Dónde"
                value={destino}
                onChange={(v) => {
                  setDestino(v);
                  setAportadoEscrito(null);
                }}
                options={[
                  { value: "nueva", label: "Posición nueva" },
                  { value: "existente", label: "Una que ya tengo" },
                ]}
              />
            ) : null}

            {destino === "nueva" ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="flex flex-col gap-[6px]">
                  <Label htmlFor={`${ids}-nombre`}>Nombre</Label>
                  <Input
                    id={`${ids}-nombre`}
                    required
                    maxLength={60}
                    value={nombre}
                    onChange={(e) => setNombre(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-[6px]">
                  <Label htmlFor={`${ids}-cuenta`}>Cuenta de inversión</Label>
                  <Select
                    id={`${ids}-cuenta`}
                    required
                    placeholder="Elige una"
                    value={cuenta}
                    onValueChange={setCuenta}
                  >
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-2 lg:col-span-2">
                  <Label>Color</Label>
                  <ColorPicker name="color" value={color} onChange={setColor} />
                </div>
              </div>
            ) : preset ? null : (
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor={`${ids}-existente`}>¿Cuál?</Label>
                <Select
                  id={`${ids}-existente`}
                  required
                  placeholder="Elige una posición"
                  value={existenteId}
                  onValueChange={(v) => {
                    setExistenteId(v);
                    setAportadoEscrito(null);
                  }}
                >
                  {manuales.map((m) => (
                    <SelectItem key={m.position_id} value={m.position_id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor={`${ids}-part`}>
                  {candidata.tipo === "FONDO" ? "Participaciones" : "Acciones"}
                </Label>
                <Input
                  id={`${ids}-part`}
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  value={participaciones}
                  onChange={(e) => {
                    setParticipaciones(e.target.value);
                    setErrorParticipaciones(null);
                  }}
                  onBlur={() =>
                    setErrorParticipaciones(lectura && !lectura.ok ? lectura.error : null)
                  }
                  aria-invalid={errorParticipaciones ? true : undefined}
                  aria-describedby={`${ids}-part-ayuda`}
                  placeholder="1234,567890"
                  className="text-right tabular-nums"
                />
                <p id={`${ids}-part-ayuda`} className="text-[13px] leading-[18px] text-muted">
                  Exactas, con todos sus decimales y coma decimal, como en MyInvestor.
                </p>
                <FieldError>{errorParticipaciones}</FieldError>
              </div>

              <div className="flex flex-col gap-[6px]">
                <Label htmlFor={`${ids}-aportado`}>Total aportado</Label>
                <Input
                  id={`${ids}-aportado`}
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  value={aportado}
                  onChange={(e) => setAportadoEscrito(e.target.value)}
                  aria-describedby={`${ids}-aportado-ayuda`}
                  placeholder="0,00"
                  className="text-right tabular-nums"
                />
                <p id={`${ids}-aportado-ayuda`} className="text-[13px] leading-[18px] text-muted">
                  {existente && aportadoDerivado !== null
                    ? aportadoDerivado > 0
                      ? `La suma de tus traspasos a «${existente.name}» hasta esa fecha. Cámbialo si MyInvestor dice otra cosa.`
                      : `No hay traspasos enlazados a «${existente.name}» hasta esa fecha. Escribe el importe invertido que dice MyInvestor.`
                    : "El importe invertido que dice MyInvestor, en euros."}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-[6px]">
              <Label htmlFor={`${ids}-fecha`}>A fecha de</Label>
              <Input
                id={`${ids}-fecha`}
                type="date"
                required
                max={todayIso()}
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
              />
              <p className="text-[13px] leading-[18px] text-muted">
                El día al que corresponden esas participaciones. Desde ahí se valora con el precio
                de cada día.
              </p>
            </div>

            {lectura?.ok ? (
              <p className="flex flex-col gap-1 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px] text-muted tabular-nums">
                <span>
                  {formatParticipaciones(lectura.valor, candidata.tipo)}
                  {candidata.ultimoPrecio
                    ? ` × ${formatPrecio(candidata.ultimoPrecio, candidata.divisa)}`
                    : ""}
                </span>
                {vistaPrevia !== null ? (
                  <span>
                    Con el último precio valdrían{" "}
                    <span className="font-semibold text-fg">{formatCents(vistaPrevia)}</span>.
                  </span>
                ) : candidata.divisa !== "EUR" ? (
                  <span>
                    Cotiza en {candidata.divisa}: el valor en euros sale con el cambio del BCE de
                    cada día.
                  </span>
                ) : null}
              </p>
            ) : null}

            <FieldError>{error}</FieldError>

            <DialogFooter>
              <Button type="button" variant="secondary" block onClick={() => setPaso("buscar")}>
                Atrás
              </Button>
              <Button type="submit" disabled={guardando} block>
                {guardando ? "Guardando…" : "Empezar a seguir"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
