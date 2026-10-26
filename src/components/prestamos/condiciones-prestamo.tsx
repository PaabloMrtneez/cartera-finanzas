"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { Eyebrow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { formatCents, formatShare } from "@/lib/money";
import { hoyEnMadrid, primeraCuotaPorDefecto } from "@/lib/prestamos";
import {
  fechaCuota,
  leerPlazo,
  primerasCuotasPosibles,
  vistaPreviaPrestamo,
  type UnidadPlazo,
} from "@/lib/prestamos-vista";

/** Lo que el formulario trae ya escrito al cambiar las condiciones. */
export type CondicionesIniciales = {
  payment_account_id: string;
  principal: string;
  plazo: string;
  tin: string;
  comision: string;
  charge_day: number;
  start_on: string;
  first_charge_on: string;
  disbursed: boolean;
};

const DIAS = Array.from({ length: 28 }, (_, i) => i + 1);

/** Un campo con su unidad dentro, a la derecha: «€», «%». */
function ConUnidad({ unidad, ...props }: React.ComponentProps<"input"> & { unidad: string }) {
  return (
    <div className="relative">
      <Input {...props} className={cn("pr-9 tabular-nums", props.className)} />
      <span
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[15px] text-muted"
        aria-hidden
      >
        {unidad}
      </span>
    </div>
  );
}

function Ayuda({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-[13px] leading-[18px] text-muted">
      {children}
    </p>
  );
}

/**
 * Las condiciones de un préstamo —de dónde se paga, cuánto, cuánto tiempo, el
 * TIN, la comisión, el día de cobro, cuándo empieza y si el dinero entra ahora
 * o ya estaba apuntado— con su VISTA PREVIA EN VIVO: cuota, intereses, coste,
 * TAE y última cuota, que se rehacen al escribir con `lib/prestamos.ts`, el
 * mismo cálculo que luego hace la base. Lo que se ve es lo que se cobrará.
 *
 * Sirve al alta y a «Cambiar las condiciones». El formulario lo pone quien lo
 * usa; aquí van los campos (con sus `name`, que son los de la server action) y
 * la vista previa. En móvil, la vista previa va debajo de los campos y justo
 * encima de los botones, que es cuando importa. El orden del DOM es el de móvil.
 *
 * En escritorio son dos columnas de ALTO FIJO: a la izquierda los campos, que
 * se desplazan solos; a la derecha la vista previa y, debajo, los botones, que
 * no se mueven. La vista previa ocupa todo el alto que queda, así que mide lo
 * mismo con o sin datos: antes encogía a una línea mientras faltaba algo y los
 * botones quedaban al final de todo, en la esquina de abajo a la derecha.
 */
export function CondicionesPrestamo({
  cuentas,
  inicial,
  cabecera,
  conTae = false,
  gasto,
  pie,
}: {
  cuentas: { id: string; name: string }[];
  inicial?: CondicionesIniciales;
  /** Lo que va antes de las condiciones (el nombre, en el alta). */
  cabecera?: ReactNode;
  /** El campo de la TAE del contrato (solo en el alta). */
  conTae?: boolean;
  /**
   * La categoría y qué cuenta como gasto (solo en el alta): va justo después de
   * cómo entra el dinero, que es lo que decide si la cuota debe contar entera.
   */
  gasto?: ReactNode;
  /** El error y los botones: en escritorio, bajo la vista previa. */
  pie: ReactNode;
}) {
  const hoy = useMemo(() => hoyEnMadrid(), []);
  const ids = {
    cuenta: useId(),
    importe: useId(),
    plazo: useId(),
    tin: useId(),
    tae: useId(),
    comision: useId(),
    dia: useId(),
    inicio: useId(),
    primera: useId(),
    ayudaTae: useId(),
  };

  const [cuenta, setCuenta] = useState(inicial?.payment_account_id ?? "");
  const [principal, setPrincipal] = useState(inicial?.principal ?? "");
  const [plazo, setPlazo] = useState(inicial?.plazo ?? "");
  const [unidad, setUnidad] = useState<UnidadPlazo>("MESES");
  const [tin, setTin] = useState(inicial?.tin ?? "");
  const [modoComision, setModoComision] = useState<"IMPORTE" | "PORCENTAJE">("IMPORTE");
  const [comision, setComision] = useState(inicial?.comision ?? "");
  const [dia, setDia] = useState(inicial?.charge_day ?? 1);
  const [inicio, setInicio] = useState(inicial?.start_on ?? hoy);
  const [primera, setPrimera] = useState<string | null>(inicial?.first_charge_on ?? null);
  // El desplegable de la primera cuota no lista doce meses: ofrece lo que casi
  // siempre se quiere —este mes (si el día de cobro aún no ha pasado) o el mes
  // siguiente— y «Elegir otra fecha», que despliega el resto. `eligiendoManual`
  // recuerda que se pidió elegir a mano, para no cerrar ese segundo paso.
  const [eligiendoManual, setEligiendoManual] = useState(false);
  const [desembolso, setDesembolso] = useState<boolean | null>(inicial?.disbursed ?? null);

  // La primera cuota se elige entre las que la base admite (el día de cobro,
  // después del inicio). Si al cambiar el inicio o el día la elegida deja de
  // valer, vuelve la de por defecto: la del mes siguiente.
  const posibles = useMemo(() => primerasCuotasPosibles(inicio || hoy, dia), [inicio, hoy, dia]);
  const porDefecto = primeraCuotaPorDefecto(inicio || hoy, dia);
  const primeraEfectiva = primera && posibles.includes(primera) ? primera : porDefecto;
  // «Este mes» solo existe si el día de cobro cae después de la firma; si no, el
  // primer vencimiento posible YA es el mes siguiente y no hay atajo de este mes.
  const esteMes = posibles[0] === porDefecto ? null : posibles[0];
  const esRapida = primeraEfectiva === porDefecto || primeraEfectiva === esteMes;
  const eligiendo = eligiendoManual || !esRapida;

  const vista = useMemo(
    () =>
      vistaPreviaPrestamo({
        principal,
        plazo,
        unidad,
        tin,
        modoComision,
        comision,
        diaCobro: dia,
        inicio: inicio || hoy,
        primera: primeraEfectiva,
        desembolso,
        hoy,
      }),
    [principal, plazo, unidad, tin, modoComision, comision, dia, inicio, hoy, primeraEfectiva, desembolso],
  );

  const meses = leerPlazo(plazo, unidad);
  const nombreCuenta = cuentas.find((c) => c.id === cuenta)?.name ?? null;
  const taeCalculada = vista.estado === "ok" && vista.resumen.tae !== null ? vista.resumen.tae : null;

  return (
    <div
      className={cn(
        "flex flex-col gap-5",
        // El alto: el de la ventana menos la cabecera de la hoja y su margen,
        // con un tope para que en pantallas altas no quede un cajón vacío.
        "lg:grid lg:h-[min(40rem,calc(100dvh-15rem))] lg:grid-cols-[minmax(0,1fr)_300px]",
        "lg:grid-rows-[minmax(0,1fr)] lg:gap-x-8",
      )}
    >
      {/*
        La columna que se desplaza. Con `overflow` recorta lo que se sale, y el
        anillo de foco de un campo pegado al borde salía cortado: 4 px de aire
        por cada lado (compensados con margen negativo) lo dejan entero.
      */}
      <div
        className={cn(
          "flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1",
          "lg:-m-1 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:p-1 lg:pr-3",
        )}
      >
        {cabecera}

        <div className="flex flex-col gap-[6px]">
          <Label htmlFor={ids.cuenta}>Cuenta de pago</Label>
          <Select
            id={ids.cuenta}
            name="payment_account_id"
            required
            placeholder="Elige una cuenta"
            value={cuenta}
            onValueChange={setCuenta}
          >
            {cuentas.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </Select>
          <Ayuda>Donde te prestan el dinero y desde donde se pagan las cuotas.</Ayuda>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor={ids.importe}>Importe prestado</Label>
            <ConUnidad
              id={ids.importe}
              name="principal"
              unidad="€"
              inputMode="decimal"
              autoComplete="off"
              required
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
              placeholder="12.000,00"
            />
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor={ids.plazo}>Plazo</Label>
            <div className="flex gap-2">
              <Input
                id={ids.plazo}
                inputMode="numeric"
                autoComplete="off"
                required
                value={plazo}
                onChange={(e) => setPlazo(e.target.value)}
                placeholder={unidad === "ANIOS" ? "5" : "60"}
                className="min-w-0 flex-1 tabular-nums"
                aria-describedby={`${ids.plazo}-ayuda`}
              />
              <Segmented
                label="Unidad del plazo"
                value={unidad}
                onChange={setUnidad}
                options={[
                  { value: "MESES", label: "Meses" },
                  { value: "ANIOS", label: "Años" },
                ]}
                className="shrink-0"
              />
            </div>
            {/* Lo que viaja son los meses, ya calculados: la acción no sabe de años. */}
            <input type="hidden" name="term_months" value={meses ?? plazo} />
            <Ayuda id={`${ids.plazo}-ayuda`}>
              {meses !== null
                ? `${meses.toLocaleString("es-ES")} ${meses === 1 ? "cuota mensual" : "cuotas mensuales"}.`
                : "Una cuota al mes."}
            </Ayuda>
          </div>
        </div>

        <div className={cn("grid gap-4", conTae && "grid-cols-2")}>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor={ids.tin}>TIN</Label>
            <ConUnidad
              id={ids.tin}
              name="tin"
              unidad="%"
              inputMode="decimal"
              autoComplete="off"
              required
              value={tin}
              onChange={(e) => setTin(e.target.value)}
              placeholder="6,5"
            />
          </div>
          {conTae ? (
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor={ids.tae}>TAE (opcional)</Label>
              <ConUnidad
                id={ids.tae}
                name="tae"
                unidad="%"
                inputMode="decimal"
                autoComplete="off"
                placeholder={taeCalculada !== null ? taeCalculada.toFixed(2).replace(".", ",") : "6,9"}
                aria-describedby={ids.ayudaTae}
              />
            </div>
          ) : null}
        </div>
        {conTae ? (
          <Ayuda id={ids.ayudaTae}>
            El TIN es el que manda en la cuota. La TAE, la del contrato; si la dejas vacía, se
            calcula con la comisión.
          </Ayuda>
        ) : null}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] leading-[18px] font-semibold text-muted">
            ¿El dinero entra ahora?
          </legend>
          {(
            [
              {
                valor: "ahora",
                titulo: "El dinero entra ahora",
                texto: `Se apunta el ingreso del préstamo${nombreCuenta ? ` en ${nombreCuenta}` : ""} y la comisión como gasto. Si la fecha es pasada, las cuotas que ya vencieron se cobran al guardar.`,
              },
              {
                valor: "apuntado",
                titulo: "Ya lo tenía apuntado",
                texto:
                  "El dinero ya está en tus cuentas: solo se apunta lo que debes a día de hoy, y las cuotas desde mañana.",
              },
            ] as const
          ).map((o) => (
            <label
              key={o.valor}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md bg-surface-2 p-3",
                "ring-accent has-checked:ring-[1.5px]",
              )}
            >
              <input
                type="radio"
                name="disbursed"
                value={o.valor}
                required
                checked={desembolso === (o.valor === "ahora")}
                onChange={() => setDesembolso(o.valor === "ahora")}
                className="mt-[2px] size-[18px] shrink-0 accent-accent"
              />
              <span className="flex flex-col gap-[2px]">
                <span className="text-[15px] leading-5 font-semibold">{o.titulo}</span>
                <span className="text-[13px] leading-[18px] text-muted">{o.texto}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {/* Un préstamo que ya existía no lleva comisión: ya la pagaste, y la base
            no la admite. Se quita el campo en vez de dejarlo apagado. */}
        {desembolso !== false ? (
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor={ids.comision}>Comisión de apertura (opcional)</Label>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <ConUnidad
                  id={ids.comision}
                  name="fee"
                  unidad={modoComision === "IMPORTE" ? "€" : "%"}
                  inputMode="decimal"
                  autoComplete="off"
                  value={comision}
                  onChange={(e) => setComision(e.target.value)}
                  placeholder={modoComision === "IMPORTE" ? "150,00" : "1,5"}
                />
              </div>
              <Segmented
                label="La comisión, en euros o en porcentaje"
                value={modoComision}
                onChange={setModoComision}
                options={[
                  { value: "IMPORTE", label: "€" },
                  { value: "PORCENTAJE", label: "%" },
                ]}
                className="w-[96px] shrink-0"
              />
            </div>
            <input type="hidden" name="fee_mode" value={modoComision} />
          </div>
        ) : null}

        {gasto}

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor={ids.inicio}>Fecha de la firma</Label>
            <Input
              id={ids.inicio}
              name="start_on"
              type="date"
              required
              max={hoy}
              value={inicio}
              onChange={(e) => setInicio(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor={ids.dia}>Día de cobro</Label>
            <Select
              id={ids.dia}
              name="charge_day"
              value={String(dia)}
              onValueChange={(v) => setDia(Number(v))}
            >
              {DIAS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  Día {d}
                </SelectItem>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-[6px]">
          <Label htmlFor={ids.primera}>Primera cuota</Label>
          <Select
            id={ids.primera}
            aria-label="Primera cuota"
            value={eligiendo ? "__elegir" : primeraEfectiva}
            onValueChange={(v) => {
              if (v === "__elegir") {
                setEligiendoManual(true);
              } else {
                setEligiendoManual(false);
                setPrimera(v);
              }
            }}
          >
            {esteMes ? (
              <SelectItem value={esteMes}>Este mes · {fechaCuota(esteMes)}</SelectItem>
            ) : null}
            <SelectItem value={porDefecto}>El mes siguiente · {fechaCuota(porDefecto)}</SelectItem>
            <SelectItem value="__elegir">Elegir otra fecha…</SelectItem>
          </Select>
          {eligiendo ? (
            <Select
              aria-label="Fecha de la primera cuota"
              value={primeraEfectiva}
              onValueChange={setPrimera}
            >
              {posibles.map((f) => (
                <SelectItem key={f} value={f}>
                  {fechaCuota(f)}
                </SelectItem>
              ))}
            </Select>
          ) : null}
          {/* Lo que viaja es la fecha resuelta, no «__elegir»: el desplegable es
              solo la superficie, el valor lo lleva este campo. */}
          <input type="hidden" name="first_charge_on" value={primeraEfectiva} />
          <Ayuda>Las siguientes, el mismo día de cada mes.</Ayuda>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:col-start-2 lg:row-start-1 lg:min-h-0">
        <VistaPrevia vista={vista} nombreCuenta={nombreCuenta} desembolso={desembolso} />
        {pie}
      </div>
    </div>
  );
}

/**
 * La vista previa: la cuota en grande y, debajo, lo que cuesta. Agrupa varias
 * cifras de un mismo cálculo, así que va en su caja (la superficie
 * secundaria, como el resto de bloques dentro de una hoja).
 */
function VistaPrevia({
  vista,
  nombreCuenta,
  desembolso,
}: {
  vista: ReturnType<typeof vistaPreviaPrestamo>;
  nombreCuenta: string | null;
  desembolso: boolean | null;
}) {
  return (
    <section
      aria-label="Vista previa del préstamo"
      className="flex flex-col gap-3 rounded-md bg-surface-2 p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
    >
      <Eyebrow>Vista previa</Eyebrow>
      {vista.estado === "incompleto" ? (
        <p className="text-[15px] leading-5 text-muted lg:text-[14px]">{vista.falta}</p>
      ) : vista.estado === "error" ? (
        <p className="flex items-start gap-2 text-[15px] leading-5 text-warning lg:text-[14px]">
          <span className="mt-[2px] shrink-0">
            <Icon name="triangle-alert" size={16} />
          </span>
          {vista.error}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-[13px] leading-[18px] font-semibold text-muted">Cuota al mes</span>
            <span className="cifra text-[34px] leading-[40px] font-medium" data-testid="cuota-prevista">
              {formatCents(vista.resumen.cuota)}
            </span>
            {/* Para el lector de pantalla: la cuota, cada vez que cambia. */}
            <span className="sr-only" aria-live="polite">
              Cuota al mes: {formatCents(vista.resumen.cuota)}
            </span>
          </div>

          <dl className="flex flex-col">
            {[
              ["Intereses", formatCents(vista.resumen.interesesTotales)],
              ...(vista.comisionCents > 0 ? [["Comisión", formatCents(vista.comisionCents)]] : []),
              ["Coste total", formatCents(vista.resumen.costeTotal)],
              [
                "TAE calculada",
                vista.resumen.tae === null ? "—" : formatShare(vista.resumen.tae, 2),
              ],
              ["Devuelves en total", formatCents(vista.resumen.totalCuotas + vista.comisionCents)],
              ["Última cuota", fechaCuota(vista.resumen.fechaFin)],
            ].map(([rotulo, valor], i) => (
              <div
                key={rotulo}
                className={cn(
                  "flex items-baseline justify-between gap-3 py-[7px] text-[14px] leading-5",
                  "hair-t border-separator",
                  i === 2 && "font-semibold",
                )}
              >
                <dt className={cn(i === 2 ? "text-fg" : "text-muted")}>{rotulo}</dt>
                <dd className="tabular-nums">{valor}</dd>
              </div>
            ))}
          </dl>

          {/* Qué se apunta al guardar. Hasta que se elige si el dinero entra ahora
              o ya estaba, nada: esa pregunta ya está en los campos, y repetirla
              aquí solo era ruido. */}
          {vista.arranque || desembolso ? (
            <p className="text-[13px] leading-[18px] text-muted tabular-nums">
              {vista.arranque
                ? `Se apunta una deuda de ${formatCents(vista.arranque.pendiente)} a hoy, y la app cobra desde la cuota ${vista.arranque.primerPeriodo} de ${vista.plazoMeses}.`
                : `Entran ${formatCents(vista.principalCents)}${nombreCuenta ? ` en ${nombreCuenta}` : ""}${
                    vista.comisionCents > 0 ? ` y se apunta la comisión como gasto` : ""
                  }.${
                    vista.vencidas > 0
                      ? ` Al guardar se cobran ya ${vista.vencidas === 1 ? "la cuota vencida" : `las ${vista.vencidas} cuotas vencidas`}.`
                      : ""
                  }`}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
