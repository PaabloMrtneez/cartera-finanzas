"use client";

import { useState } from "react";
import { useTheme } from "@/components/use-theme";
import { BandaAurora, type SegmentoBanda } from "@/components/ui/banda-aurora";
import { BotonConfirmar } from "@/components/ui/boton-confirmar";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Eyebrow } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { LineaInteractiva } from "@/components/ui/linea-interactiva";
import { Segmented } from "@/components/ui/segmented";
import { SwitchRow } from "@/components/ui/switch";
import { COLOR_OTROS, ESPECTRO_AURORA } from "@/lib/aurora";
import { CIFRA_LECTURA, lecturasNivel } from "@/lib/graficos";
import { formatCents, formatShare, formatSignedCents, formatSignedDelta } from "@/lib/money";
import { THEMES, THEME_LABELS } from "@/lib/theme";
import { TYPE_COLOR_VAR, type TransactionType } from "@/lib/types";

/**
 * El muestrario de la identidad Aurora.
 *
 * No es una pantalla del producto (no tiene enlace en la navegación): es el
 * banco de pruebas para ver de un golpe, en los dos temas, que los tokens, los
 * materiales y los primitivos se portan. Si un token cambia en `globals.css`,
 * aquí se nota en todas sus apariciones a la vez.
 *
 * Todo lo que enseña es la pieza REAL —el mismo `BandaAurora`, la misma
 * `LineaInteractiva`, el mismo `Dialog`— con datos de ejemplo fijos. Nada de
 * maquetas que se queden atrás cuando cambie el componente.
 */

/** Los tokens de la paleta base, con el nombre con que se usan en las clases. */
const PALETA = [
  ["Fondo", "--bg", "bg"],
  ["Superficie", "--surface", "surface"],
  ["Superficie 2", "--surface-2", "surface-2"],
  ["Filete", "--hairline", "hairline"],
  ["Texto", "--fg", "fg"],
  ["Apagado", "--muted", "muted"],
  ["Acento (cian)", "--accent", "accent"],
  ["Losa de noche", "--ink", "ink"],
] as const;

const SEMANTICOS: { nombre: string; token: string; tipo?: TransactionType; cents: number }[] = [
  { nombre: "Gasto", token: "--expense", tipo: "EXPENSE", cents: 4320 },
  { nombre: "Ingreso", token: "--income", tipo: "INCOME", cents: 180000 },
  { nombre: "Traspaso", token: "--transfer", tipo: "TRANSFER", cents: 20000 },
  { nombre: "Aviso", token: "--warning", cents: 0 },
  { nombre: "Sin categoría", token: "--uncat", cents: 0 },
];

/** Un reparto de ejemplo para la banda: seis categorías y su «Otros». */
const REPARTO: [string, number][] = [
  ["Supermercado", 41230],
  ["Casa", 32000],
  ["Restaurantes", 18450],
  ["Transporte", 9620],
  ["Ocio", 7400],
  ["Salud", 4210],
  ["Otros · 4", 6390],
];
const TOTAL_REPARTO = REPARTO.reduce((s, [, v]) => s + v, 0);
const SEGMENTOS: SegmentoBanda[] = REPARTO.map(([nombre, valor], i) => ({
  id: nombre,
  nombre,
  color: i < REPARTO.length - 1 ? ESPECTRO_AURORA[i] : COLOR_OTROS,
  valor,
  texto: formatCents(valor),
  share: formatShare((valor / TOTAL_REPARTO) * 100),
}));

/** Seis cierres de mes de ejemplo para la curva de nivel. */
const MESES = ["may", "jun", "jul", "ago", "sep", "oct"];
const MESES_LARGOS = ["mayo", "junio", "julio", "agosto", "septiembre", "octubre"].map(
  (m) => `${m} de 2026`,
);
const SALDOS = [1240000, 1302050, 1287430, 1355210, 1421900, 1611696];

export function MuestrarioAurora() {
  const { theme, setTheme } = useTheme();
  const [tipo, setTipo] = useState<TransactionType>("EXPENSE");
  const [avisar, setAvisar] = useState(true);

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3 p-4">
        <Eyebrow>Tema</Eyebrow>
        <Segmented
          label="Tema"
          value={theme}
          onChange={setTheme}
          options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
        />
        <p className="text-[13px] leading-[18px] text-muted">
          El oscuro es el héroe y el tema por defecto; el claro (porcelana fría) es secundario,
          pero debe leerse igual de bien.
        </p>
      </Card>

      {/* La paleta base: cada muestra pintada con su variable, para ver si un
          tema se ha quedado atrás. */}
      <Card className="flex flex-col gap-3 p-4">
        <Eyebrow>Paleta</Eyebrow>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {PALETA.map(([nombre, token, clase]) => (
            <div key={token} className="flex flex-col gap-1">
              <span
                className="h-10 rounded-sm hair border-hairline"
                style={{ background: `var(${token})` }}
              />
              <span className="text-[13px] leading-[18px] font-semibold">{nombre}</span>
              <code className="font-mono text-[13px] leading-[18px] text-muted">{clase}</code>
            </div>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <Eyebrow>Semánticos</Eyebrow>
        <ul className="flex flex-col">
          {SEMANTICOS.map((s) => (
            <li
              key={s.token}
              className="flex min-h-11 items-center gap-3 hair-t border-separator first:border-t-0"
            >
              <span
                aria-hidden
                className="size-3 shrink-0 rounded-full"
                style={{ background: `var(${s.token})` }}
              />
              <span className="flex-1 text-[15px]">{s.nombre}</span>
              <span
                className="text-[15px] font-semibold tabular-nums"
                style={{ color: s.tipo ? TYPE_COLOR_VAR[s.tipo] : `var(${s.token})` }}
              >
                {s.tipo ? formatSignedCents(s.cents, s.tipo) : s.token}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[13px] leading-[18px] text-muted tabular-nums">
          Sin agrupar los millares hasta las cinco cifras: {formatCents(980000)} ·{" "}
          {formatCents(1611696)}.
        </p>
      </Card>

      {/* La FIRMA: el espectro iridiscente. */}
      <Card className="flex flex-col gap-3 p-4">
        <Eyebrow>El espectro Aurora</Eyebrow>
        <span className="h-3 rounded-full" style={{ background: "var(--grad-aurora)" }} />
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {[...ESPECTRO_AURORA, COLOR_OTROS].map((color, i) => (
            <div key={color} className="flex flex-col items-center gap-1">
              <span aria-hidden className="size-9 rounded-full" style={{ background: color }} />
              <code className="font-mono text-[13px] text-muted">
                {i < ESPECTRO_AURORA.length ? `aurora-${i + 1}` : "otros"}
              </code>
            </div>
          ))}
        </div>
        <p className="text-[15px] leading-5">
          El acento es el gradiente:{" "}
          <span className="aurora-text font-semibold">solo para acentos pequeños</span>. Para lo
          sólido (foco, enlace, estado activo) está el{" "}
          <span className="font-semibold text-accent-text">cian</span>.
        </p>
      </Card>

      {/* Los tres materiales y cuándo va cada uno. */}
      <div className="flex flex-col gap-4">
        <Eyebrow className="px-1">Materiales</Eyebrow>
        <Card className="p-4">
          <p className="text-[15px] leading-5 font-semibold">Filete</p>
          <p className="mt-1 text-[13px] leading-[18px] text-muted">
            Lo normal: una caja que agrupa algo se cierra con un filete de 0,5 px (
            <code className="font-mono">hair border-hairline</code>), sin sombra.
          </p>
        </Card>
        <div className="glass-card rounded-lg p-4">
          <p className="text-[15px] leading-5 font-semibold">Cristal</p>
          <p className="mt-1 text-[13px] leading-[18px] text-muted">
            Solo para lo que flota de verdad: la previsión, las hojas. Desenfoque, brillo interior y
            sombra honda (<code className="font-mono">glass-card</code>).
          </p>
        </div>
        <section className="rounded-lg hair border-hairline losa-aurora p-4">
          <Eyebrow className="text-accent-text">Losa Aurora</Eyebrow>
          <p className="mt-2 cifra text-[40px] leading-[46px]">{formatCents(1611696)}</p>
          <p className="mt-2 hair-t border-hairline pt-3 text-[13px] leading-[18px] text-muted">
            La tarjeta héroe de Patrimonio: filete y superficie del tema, con un amanecer del
            espectro en el canto (<code className="font-mono">losa-aurora</code>). Sigue al tema.
          </p>
        </section>
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <Eyebrow>Cifras</Eyebrow>
        <p className="cifra text-[48px] leading-[52px]">{formatCents(48735)}</p>
        <p className="text-[13px] leading-[18px] text-muted">
          <span className="font-semibold text-fg">cifra</span> (Space Grotesk) para la cifra
          protagonista de cada pantalla, los valores de una tira y las lecturas de un gráfico.
        </p>
        <ul className="flex flex-col">
          {[
            ["Mercadona", 2345],
            ["Bar Mundial", 1890],
            ["Renfe", 12050],
          ].map(([concepto, cents]) => (
            <li
              key={concepto}
              className="flex min-h-11 items-center gap-3 hair-t border-separator text-[15px]"
            >
              <span className="flex-1 font-semibold">{concepto}</span>
              <span className="font-semibold text-expense tabular-nums">
                {formatSignedCents(Number(cents), "EXPENSE")}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[13px] leading-[18px] text-muted">
          En listas densas, la de interfaz (Inter) con{" "}
          <span className="font-semibold text-fg">tabular-nums</span>: es lo que alinea las columnas.
        </p>
      </Card>

      {/* Los primitivos de gráfico, con datos de ejemplo. */}
      <Card>
        <CardHeader title="Banda Aurora" />
        <div className="px-4 pb-4 lg:px-5">
          <BandaAurora
            segmentos={SEGMENTOS}
            etiquetaAccesible="Reparto de ejemplo por categoría. Recórrelo con las flechas."
            resumen={`${formatCents(TOTAL_REPARTO)} en 10 grupos`}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Línea interactiva" />
        <div className="px-4 pb-4 lg:px-5">
          <LineaInteractiva
            anotaciones
            escala
            altoBase={160}
            claseAlto="h-[160px] lg:h-[200px]"
            ejeX={MESES}
            lecturas={lecturasNivel(SALDOS, MESES_LARGOS, { desdeRotulo: "mayo" })}
            etiquetaAccesible="Curva de ejemplo de seis meses. Recórrela con las flechas."
            series={[{ id: "ejemplo", nombre: "Saldo", valores: SALDOS, textos: [] }]}
          >
            <div className="flex flex-col gap-1">
              <span className="text-[13px] leading-[18px] font-semibold text-muted">
                Últimos 6 meses
              </span>
              <span className={CIFRA_LECTURA.normal}>
                {formatSignedDelta(SALDOS[SALDOS.length - 1] - SALDOS[0])}
              </span>
              <span className="text-[14px] leading-5 text-muted">
                Recórrela: la cabecera pasa a leer el punto.
              </span>
            </div>
          </LineaInteractiva>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <Eyebrow>Controles</Eyebrow>
        <Segmented
          label="Tipo de movimiento"
          value={tipo}
          onChange={setTipo}
          options={[
            { value: "EXPENSE", label: "Gasto", color: TYPE_COLOR_VAR.EXPENSE },
            { value: "INCOME", label: "Ingreso", color: TYPE_COLOR_VAR.INCOME },
            { value: "TRANSFER", label: "Traspaso", color: TYPE_COLOR_VAR.TRANSFER },
          ]}
        />
        <SwitchRow
          label="Avisar al 80 %"
          hint="Un solo aviso por límite y umbral"
          checked={avisar}
          onCheckedChange={setAvisar}
        />
        <div className="flex flex-wrap gap-2">
          <Button>Principal</Button>
          <Button variant="secondary">Secundario</Button>
          <Button variant="ghost">Discreto</Button>
          <Button variant="destructive">Destructivo</Button>
          <BotonConfirmar
            confirmar="Sí, eliminar"
            onConfirm={() => {}}
            className="text-expense"
          >
            Eliminar (dos toques)
          </BotonConfirmar>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <Eyebrow>Diálogo</Eyebrow>
        <p className="text-[13px] leading-[18px] text-muted">
          Hoja desde abajo en móvil, cuadro centrado a partir de 1024 px. Un solo componente.
        </p>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary">Abrir el diálogo</Button>
          </DialogTrigger>
          <DialogContent
            size="base"
            title="Un diálogo de ejemplo"
            description="El primer campo recibe el foco, y su anillo se ve entero."
          >
            <label className="flex flex-col gap-[6px]">
              <span className="text-[13px] leading-[18px] font-semibold text-muted">Nombre</span>
              <input
                autoComplete="off"
                placeholder="Escribe algo…"
                className="h-11 w-full rounded-md border-0 bg-surface-2 px-3 text-[17px] text-fg placeholder:text-muted lg:h-[38px] lg:rounded-sm lg:text-[14px]"
              />
            </label>
            <DialogFooter>
              <Button variant="secondary" block>
                Cancelar
              </Button>
              <Button block>Guardar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Card>
    </div>
  );
}
