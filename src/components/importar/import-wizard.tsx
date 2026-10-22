"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  confirmarImport,
  previsualizarImport,
  type Peticion,
  type Resumen,
} from "@/app/(app)/importar/actions";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { FieldError, Label } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { detectarSeparador, prepararTabla, proponerColumnas } from "@/lib/csv";
import { centsToDecimalString } from "@/lib/export";
import { parseAmountToCents } from "@/lib/money";
import { llamarAccion } from "@/lib/llamar-accion";

type Cuenta = { id: string; name: string; type: string };

/**
 * Importar un extracto del banco, en tres pasos: pegar, emparejar y confirmar.
 *
 * El fichero se analiza aquí solo para poder enseñar la tabla y proponer el
 * emparejamiento. Lo que se manda al servidor es el texto en crudo: el servidor
 * lo vuelve a analizar y es su lectura la que cuenta, tanto al previsualizar
 * como al importar. Así el número que se ve antes de pulsar es el mismo que se
 * escribe después.
 */
export function ImportWizard({ cuentas }: { cuentas: Cuenta[] }) {
  const router = useRouter();
  // No se encabeza con una cuenta de inversión: un extracto bancario no va ahí,
  // y dejarla por defecto invita a meter la compra del supermercado en el fondo
  // indexado. Se puede elegir igual, pero a propósito.
  const [cuenta, setCuenta] = useState(
    (cuentas.find((c) => c.type !== "INVERSION") ?? cuentas[0])?.id ?? "",
  );
  const [texto, setTexto] = useState("");
  const [separador, setSeparador] = useState(";");
  const [conCabecera, setConCabecera] = useState(true);
  const [todoGasto, setTodoGasto] = useState(false);
  const [saltarDuplicados, setSaltarDuplicados] = useState(true);
  const [columnas, setColumnas] = useState({ fecha: 0, concepto: 1, importe: 2 });
  const [paso, setPaso] = useState<1 | 2 | 3>(1);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [importado, setImportado] = useState(false);
  const [nombreFichero, setNombreFichero] = useState<string | null>(null);
  // La petición con la que se hizo el recuento del paso 3. Si después se toca
  // algo —columnas, separador, el texto, una opción—, el recuento ya no dice la
  // verdad: antes «Importar» mandaba la petición NUEVA con los números VIEJOS a
  // la vista, es decir, podía importar algo distinto de lo que enseñaba.
  const [firmaRecuento, setFirmaRecuento] = useState<string | null>(null);

  const tabla = useMemo(
    () => (texto.trim() === "" ? { filas: [], preambulo: 0 } : prepararTabla(texto, separador)),
    [texto, separador],
  );
  const filas = tabla.filas;
  const cabecera = filas[0] ?? [];
  const muestra = (conCabecera ? filas.slice(1) : filas).slice(0, 6);

  function peticion(): Peticion {
    return { account_id: cuenta, texto, separador, columnas, conCabecera, todoGasto, saltarDuplicados };
  }
  const firmaActual = JSON.stringify(peticion());
  const recuentoVigente = resumen !== null && firmaRecuento === firmaActual;

  /** Al cargar un fichero se detecta todo y se propone; luego se corrige a mano. */
  function cargar(contenido: string) {
    const sep = detectarSeparador(contenido);
    const { filas: leidas } = prepararTabla(contenido, sep);
    setTexto(contenido);
    setSeparador(sep);
    if (leidas.length > 0) setColumnas(proponerColumnas(leidas[0], leidas));
    setError(null);
  }

  function alElegirFichero(event: React.ChangeEvent<HTMLInputElement>) {
    const fichero = event.target.files?.[0];
    if (!fichero) return;
    setNombreFichero(fichero.name);
    const lector = new FileReader();
    lector.onload = () => cargar(String(lector.result ?? ""));
    // Los bancos españoles todavía exportan en Windows-1252 tan a menudo como
    // en UTF-8. Se lee como UTF-8 y, si sale con caracteres de reemplazo, se
    // reintenta: es más fiable que fiarse de lo que diga el fichero.
    lector.readAsText(fichero, "utf-8");
    lector.onloadend = () => {
      const primero = String(lector.result ?? "");
      if (primero.includes("�")) {
        const segundo = new FileReader();
        segundo.onload = () => cargar(String(segundo.result ?? ""));
        segundo.readAsText(fichero, "windows-1252");
      }
    };
  }

  function previsualizar() {
    setError(null);
    startTransition(async () => {
      const enviada = peticion();
      const r = await llamarAccion(() => previsualizarImport(enviada), "cargado");
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setResumen(r.resumen);
      setFirmaRecuento(JSON.stringify(enviada));
      setPaso(3);
    });
  }

  function confirmar() {
    setError(null);
    startTransition(async () => {
      const r = await llamarAccion(() => confirmarImport(peticion()), "importado");
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setResumen(r.resumen);
      setImportado(true);
    });
  }

  if (cuentas.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted">
          <Icon name="wallet" size={26} />
        </span>
        <h2 className="text-[17px] leading-[22px] font-semibold">Primero, una cuenta</h2>
        <p className="max-w-sm text-[15px] leading-5 text-muted">
          Los movimientos de un extracto tienen que entrar en alguna cuenta.
        </p>
        <ButtonLink href="/cuentas">Ir a Cuentas</ButtonLink>
      </Card>
    );
  }

  if (importado && resumen) {
    return (
      <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-income/15 text-income">
          <Icon name="check" size={26} />
        </span>
        <h2 className="text-[20px] leading-[26px] font-semibold">
          {resumen.insertadas === 1
            ? "1 movimiento importado"
            : `${resumen.insertadas} movimientos importados`}
        </h2>
        <p className="max-w-sm text-[15px] leading-5 text-muted">
          {resumen.sinClasificar > 0
            ? `${resumen.sinClasificar} se han quedado sin categoría. Un gasto sin clasificar no consume ningún límite ni sale en el reparto, así que merece la pena pasarles por encima.`
            : "Todos han quedado clasificados por tus reglas de comercio."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => router.push("/movimientos")}>Ver los movimientos</Button>
          <Button
            variant="secondary"
            onClick={() => {
              setImportado(false);
              setResumen(null);
              setTexto("");
              setNombreFichero(null);
              setFirmaRecuento(null);
              setPaso(1);
            }}
          >
            Importar otro
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Paso 1: cuenta y fichero */}
      <Card>
        <CardHeader title="1 · De dónde y a dónde" />
        <div className="flex flex-col gap-4 px-4 py-4 lg:px-5">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="cuenta">Cuenta de destino</Label>
            <Select id="cuenta" value={cuenta} onValueChange={setCuenta}>
              {cuentas.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-[6px]">
            <span className="text-[13px] leading-[18px] font-semibold text-muted">
              El fichero CSV de tu banco
            </span>
            {/*
              El selector nativo pintaba «Choose File · No file chosen» en el
              idioma del NAVEGADOR, no en el de la app. El <input> sigue siendo
              el control de verdad (accesible y enfocable, solo que invisible);
              lo que se ve es su <label>, con el aspecto de un botón secundario y
              el nombre del fichero elegido al lado. El anillo de foco del input
              se traslada a la etiqueta con `has-focus-visible`.
            */}
            <div className="flex min-w-0 items-center gap-3">
              <label
                className={buttonClasses({
                  variant: "secondary",
                  className:
                    "shrink-0 cursor-pointer px-4 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent",
                })}
              >
                <Icon name="folder-open" size={16} />
                Elegir fichero
                <input
                  id="fichero"
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  onChange={alElegirFichero}
                  className="sr-only"
                />
              </label>
              <span className="min-w-0 truncate text-[15px] text-muted lg:text-[14px]">
                {nombreFichero ?? "Ninguno elegido"}
              </span>
            </div>
            <p className="text-[13px] leading-[18px] text-muted">
              O pega el contenido aquí abajo. Nada sale de tu sesión: el fichero no se guarda.
            </p>
          </div>

          <textarea
            value={texto}
            aria-label="Contenido del extracto, pegado"
            // Se propone separador y columnas solo al llegar el contenido (pegar
            // en el campo vacío). Antes se hacía en CADA tecla, y retocar una
            // línea deshacía el emparejamiento que hubieras corregido a mano.
            onChange={(e) => (texto.trim() === "" ? cargar(e.target.value) : setTexto(e.target.value))}
            rows={4}
            spellCheck={false}
            placeholder={"Fecha;Concepto;Importe\n18/08/2026;MERCADONA 4021;-23,45"}
            className="w-full rounded-md border-0 bg-surface-2 p-3 font-mono text-[13px] leading-[18px] text-fg"
          />
        </div>
      </Card>

      {/* Paso 2: emparejar columnas */}
      {filas.length > 0 ? (
        <Card>
          <CardHeader
            title="2 · Qué columna es cada cosa"
            action={
              <span className="text-[13px] text-muted tabular-nums">
                {filas.length} {filas.length === 1 ? "línea" : "líneas"}
              </span>
            }
          />

          <div className="flex flex-col gap-4 px-4 py-4 lg:px-5">
            {/* La tabla con las cabeceras reales, para poder señalarlas. */}
            <div className="-mx-4 overflow-x-auto px-4 lg:-mx-5 lg:px-5">
              <table className="w-full text-[13px] tabular-nums">
                <thead>
                  <tr>
                    {cabecera.map((titulo, i) => {
                      const papel =
                        i === columnas.fecha
                          ? "Fecha"
                          : i === columnas.concepto
                            ? "Concepto"
                            : i === columnas.importe
                              ? "Importe"
                              : null;
                      return (
                        <th
                          key={i}
                          className={cn(
                            "px-2 py-1 text-left font-semibold whitespace-nowrap",
                            papel ? "text-fg" : "text-muted",
                          )}
                        >
                          <span className="flex flex-col">
                            <span className="truncate">
                              {conCabecera ? titulo || `Columna ${i + 1}` : `Columna ${i + 1}`}
                            </span>
                            {papel ? (
                              <span className="text-[13px] font-bold text-accent-text">
                                {papel}
                              </span>
                            ) : null}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {muestra.map((fila, f) => (
                    <tr key={f} className="hair-t border-separator">
                      {cabecera.map((_, i) => (
                        <td
                          key={i}
                          className={cn(
                            "max-w-[220px] truncate px-2 py-[6px]",
                            i === columnas.importe ? "text-right" : "",
                            i === columnas.fecha ||
                              i === columnas.concepto ||
                              i === columnas.importe
                              ? "text-fg"
                              : "text-muted",
                          )}
                        >
                          {fila[i] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              {(
                [
                  ["fecha", "Fecha"],
                  ["concepto", "Concepto"],
                  ["importe", "Importe"],
                ] as const
              ).map(([clave, etiqueta]) => (
                <div key={clave} className="flex flex-col gap-[6px]">
                  <Label htmlFor={`col-${clave}`}>{etiqueta}</Label>
                  <Select
                    id={`col-${clave}`}
                    value={String(columnas[clave])}
                    onValueChange={(v) => setColumnas({ ...columnas, [clave]: Number(v) })}
                  >
                    {cabecera.map((titulo, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {conCabecera && titulo ? titulo : `Columna ${i + 1}`}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2">
              {(
                [
                  [
                    conCabecera,
                    setConCabecera,
                    "La primera línea son títulos",
                    "Si no, se importará también.",
                  ],
                  [
                    todoGasto,
                    setTodoGasto,
                    "Todos son gastos",
                    "Marca esto si tu banco exporta los importes sin signo.",
                  ],
                  [
                    saltarDuplicados,
                    setSaltarDuplicados,
                    "Saltar los que ya tengo",
                    "Mismo día, mismo importe y mismo concepto. Así se pueden reimportar meses solapados.",
                  ],
                ] as const
              ).map(([valor, poner, titulo, detalle]) => (
                <button
                  key={titulo}
                  type="button"
                  onClick={() => poner(!valor)}
                  aria-pressed={valor}
                  className="flex items-start gap-3 rounded-md bg-surface-2 px-3 py-[10px] text-left"
                >
                  <span
                    className={cn(
                      "mt-[2px] flex size-[20px] shrink-0 items-center justify-center rounded-xs",
                      valor ? "bg-accent text-accent-ink" : "bg-surface text-transparent",
                    )}
                  >
                    <Icon name="check" size={13} />
                  </span>
                  <span className="flex flex-col">
                    <span className="text-[15px] font-semibold">{titulo}</span>
                    <span className="text-[13px] leading-[18px] text-muted">{detalle}</span>
                  </span>
                </button>
              ))}
            </div>

            {tabla.preambulo > 0 ? (
              <p className="text-[13px] leading-[18px] text-muted">
                Se han saltado {tabla.preambulo}{" "}
                {tabla.preambulo === 1 ? "línea" : "líneas"} del principio y cualquier pie de
                totales: tienen menos columnas que la tabla, así que no son movimientos.
              </p>
            ) : null}

            {/* Cómo queda la primera fila ya interpretada: es lo que delata un
                emparejamiento equivocado antes de escribir nada. */}
            {muestra.length > 0 ? (
              <PrimeraFila
                fila={muestra[0]}
                columnas={columnas}
                todoGasto={todoGasto}
              />
            ) : null}

            <FieldError>{error}</FieldError>

            <Button onClick={previsualizar} disabled={pending} block>
              {pending && paso !== 3 ? "Comprobando…" : "Ver qué va a entrar"}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Paso 3: el recuento en seco */}
      {paso === 3 && resumen && !recuentoVigente ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md bg-accent-soft p-3 text-[13px] leading-[18px]"
        >
          <Icon name="triangle-alert" size={15} />
          <span>
            Has cambiado algo después del recuento. Pulsa «Ver qué va a entrar» otra vez para
            saber qué se importará.
          </span>
        </p>
      ) : null}

      {paso === 3 && resumen && recuentoVigente ? (
        <Card>
          <CardHeader title="3 · Antes de escribir nada" />
          <div className="flex flex-col gap-4 px-4 py-4 lg:px-5">
            <div className="grid grid-cols-2 gap-3">
              {[
                ["Entran", resumen.insertadas, "text-fg"],
                ["Ya los tenías", resumen.duplicadas, "text-muted"],
                ["Con categoría", resumen.clasificadas, "text-income"],
                ["Sin clasificar", resumen.sinClasificar, "text-muted"],
              ].map(([etiqueta, valor, color]) => (
                <div key={String(etiqueta)} className="flex flex-col rounded-md bg-surface-2 p-3">
                  <span className="text-[13px] leading-[18px] text-muted">{etiqueta}</span>
                  <span className={cn("text-[24px] leading-[30px] font-semibold tabular-nums", color)}>
                    {valor}
                  </span>
                </div>
              ))}
            </div>

            {resumen.ambiguedadDeFecha ? (
              <p className="flex items-start gap-2 rounded-md bg-accent-soft p-3 text-[13px] leading-[18px]">
                <Icon name="triangle-alert" size={15} />
                <span>
                  Todas las fechas del fichero valen como día/mes y como mes/día. Se han leído como
                  día/mes, que es lo español. Comprueba una arriba antes de seguir.
                </span>
              </p>
            ) : null}

            {resumen.descartadas.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] leading-[18px] text-muted">
                  {resumen.descartadas.length === 1
                    ? "1 línea no es un movimiento y se ha dejado fuera."
                    : `${resumen.descartadas.length} líneas no son movimientos y se han dejado fuera.`}{" "}
                  Suele ser la cabecera del extracto, los totales o el saldo inicial.
                </span>
                <ul className="flex flex-col gap-1 rounded-md bg-surface-2 p-3">
                  {resumen.descartadas.slice(0, 5).map((d) => (
                    <li key={d.linea} className="text-[13px] leading-[18px] text-muted">
                      <span className="font-semibold tabular-nums">Línea {d.linea}</span> ·{" "}
                      {d.motivo} · <span className="opacity-70">{d.texto}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <FieldError>{error}</FieldError>

            <Button onClick={confirmar} disabled={pending || resumen.insertadas === 0} block>
              {pending
                ? "Importando…"
                : resumen.insertadas === 1
                  ? "Importar 1 movimiento"
                  : `Importar ${resumen.insertadas} movimientos`}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * La primera fila tal y como quedará guardada. Un emparejamiento equivocado se
 * ve aquí de un vistazo —una fecha imposible, un importe que era el saldo— y no
 * después de meter trescientos apuntes.
 */
function PrimeraFila({
  fila,
  columnas,
  todoGasto,
}: {
  fila: string[];
  columnas: { fecha: number; concepto: number; importe: number };
  todoGasto: boolean;
}) {
  const crudo = parseAmountToCents(fila[columnas.importe] ?? "");
  const cents = crudo === null ? null : todoGasto ? -Math.abs(crudo) : crudo;
  const esGasto = (cents ?? 0) < 0;

  return (
    <div className="flex flex-col gap-1 rounded-md bg-surface-2 p-3 text-[13px] leading-[18px]">
      <span className="text-muted">Así quedaría la primera</span>
      <span className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate font-semibold text-fg">
          {(fila[columnas.concepto] ?? "").trim() || "(sin concepto)"}
        </span>
        <span
          className={cn(
            "shrink-0 font-semibold tabular-nums",
            cents === null ? "text-warning" : esGasto ? "text-expense" : "text-income",
          )}
        >
          {cents === null
            ? "importe ilegible"
            : `${esGasto ? "−" : "+"}${centsToDecimalString(Math.abs(cents))} €`}
        </span>
      </span>
      <span className="text-muted tabular-nums">
        {(fila[columnas.fecha] ?? "").trim() || "(sin fecha)"} ·{" "}
        {cents === null ? "revisa la columna de importe" : esGasto ? "gasto" : "ingreso"}
      </span>
    </div>
  );
}
