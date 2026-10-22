"use client";

import { CabeceraLectura } from "@/components/ui/lectura";
import { useLectura } from "@/components/ui/use-lectura";
import { cn } from "@/lib/cn";
import { OPACIDAD_CALOR, nivelCalor, type LecturaPunto, type TamanoLectura } from "@/lib/graficos";

export type DiaCalor = {
  /** «2026-10-14». */
  fecha: string;
  /** Céntimos del día; `null` si el día aún no ha llegado. */
  valor: number | null;
  lectura: LecturaPunto;
};

const HUECO = 4;
const SEMANA = ["L", "M", "X", "J", "V", "S", "D"];
const ORO = "var(--aurora-5)";
const CIFRA_SVG = {
  fontFamily: "var(--font-cifra)",
  fontVariantNumeric: "tabular-nums",
} as const;

/** El día de la semana ISO (0 = lunes) de una fecha, pasando por UTC. */
function diaSemana(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return (d + 6) % 7;
}

/**
 * CALENDARIO DE CALOR: un mes en su forma de siempre —siete columnas, de lunes
 * a domingo— y cada día pintado según lo que gastaste. Lo que se busca aquí
 * es el PATRÓN (los fines de semana, el día de la compra grande), y eso un
 * calendario lo enseña sin explicar nada.
 *
 *  · Cinco niveles del cian del acento (`nivelCalor`): nada, y cuatro tramos
 *    del día más caro. Una devolución que deja el día en negativo es «nada».
 *  · Los días que aún no han llegado, con filete discontinuo y sin relleno;
 *    hoy, con filete de oro.
 *  · LA CABECERA ES LA LECTURA: al tocar un día, la cifra de arriba es la suya.
 *    Flechas: izquierda y derecha, un día; arriba y abajo, una semana.
 *
 * Se dibuja en píxeles reales (mide su caja) para que las casillas sean
 * cuadradas en cualquier anchura y el número de cada día quepa a 13 px.
 */
export function CalendarioCalor({
  dias,
  hoy,
  tamano = "compacto",
  etiquetaAccesible,
  className,
  children,
}: {
  dias: DiaCalor[];
  /** El índice de hoy en `dias`, si el mes es el actual. */
  hoy?: number;
  tamano?: TamanoLectura;
  etiquetaAccesible: string;
  className?: string;
  children: React.ReactNode;
}) {
  const desfase = dias.length > 0 ? diaSemana(dias[0].fecha) : 0;
  const casillas = desfase + dias.length;
  const filas = Math.max(Math.ceil(casillas / 7), 1);
  const maximo = Math.max(0, ...dias.map((d) => d.valor ?? 0));

  const { caja, ancho, activo, manejadores } = useLectura({
    total: filas * 7,
    altoBase: filas * 46,
    pasoVertical: 7,
    inicio: hoy !== undefined ? hoy + desfase : undefined,
    indice: (x, w, y, h) => {
      const col = Math.min(Math.max(Math.floor((x / Math.max(w, 1)) * 7), 0), 6);
      const fila = Math.min(Math.max(Math.floor((y / Math.max(h, 1)) * filas), 0), filas - 1);
      return fila * 7 + col;
    },
  });

  const lado = Math.max((ancho - HUECO * 6) / 7, 0);
  const alto = filas * lado + (filas - 1) * HUECO;
  const diaActivo = activo === null ? null : activo - desfase;
  const leido =
    diaActivo !== null && diaActivo >= 0 && diaActivo < dias.length ? dias[diaActivo] : null;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <CabeceraLectura lectura={leido?.lectura ?? null} tamano={tamano}>
        {children}
      </CabeceraLectura>

      <div className="flex flex-col gap-2">
        <div
          className="grid grid-cols-7 gap-1 text-center text-[13px] leading-[18px] text-muted"
          aria-hidden
        >
          {SEMANA.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div
          ref={caja}
          role="group"
          aria-label={`${etiquetaAccesible} Recórrelo con las flechas.`}
          tabIndex={0}
          className={cn(
            "relative w-full cursor-pointer touch-pan-y rounded-sm outline-none",
            "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
            "focus-visible:ring-offset-surface",
          )}
          style={{ height: alto || filas * 46 }}
          {...manejadores}
        >
          <svg
            viewBox={`0 0 ${ancho} ${alto}`}
            width={ancho}
            height={alto}
            className="block"
            aria-hidden
          >
            {dias.map((d, i) => {
              const k = i + desfase;
              const cx = (k % 7) * (lado + HUECO);
              const cy = Math.floor(k / 7) * (lado + HUECO);
              const futuro = d.valor === null;
              const nivel = futuro ? 0 : nivelCalor(d.valor as number, maximo);
              const esHoy = hoy === i;
              const esActivo = diaActivo === i;
              return (
                <g
                  key={d.fecha}
                  className="animate-fade-in"
                  style={{ animationDelay: `${Math.min(i, 30) * 12}ms` }}
                >
                  <rect
                    x={cx + 0.5}
                    y={cy + 0.5}
                    width={Math.max(lado - 1, 0)}
                    height={Math.max(lado - 1, 0)}
                    rx={8}
                    fill={futuro ? "none" : "var(--surface-2)"}
                    stroke={futuro ? "var(--hairline)" : "none"}
                    strokeDasharray={futuro ? "3 3" : undefined}
                  />
                  {nivel > 0 ? (
                    <rect
                      x={cx + 0.5}
                      y={cy + 0.5}
                      width={Math.max(lado - 1, 0)}
                      height={Math.max(lado - 1, 0)}
                      rx={8}
                      fill="var(--accent)"
                      fillOpacity={OPACIDAD_CALOR[nivel]}
                    />
                  ) : null}
                  {esHoy || esActivo ? (
                    <rect
                      x={cx + 1}
                      y={cy + 1}
                      width={Math.max(lado - 2, 0)}
                      height={Math.max(lado - 2, 0)}
                      rx={7.5}
                      fill="none"
                      stroke={esActivo ? "var(--fg)" : ORO}
                      strokeWidth={esActivo ? 2 : 1.5}
                    />
                  ) : null}
                  <text
                    x={cx + lado / 2}
                    y={cy + lado / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={13}
                    fill={nivel >= 3 ? "var(--accent-ink)" : futuro ? "var(--muted)" : "var(--fg)"}
                    fontWeight={nivel >= 3 ? 600 : 400}
                    style={CIFRA_SVG}
                  >
                    {i + 1}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* La escala: de menos a más, con las mismas casillas. */}
      <div className="flex items-center gap-2 text-[13px] leading-[18px] text-muted" aria-hidden>
        <span>Menos</span>
        {OPACIDAD_CALOR.map((o, n) => (
          <span key={n} className="relative size-[14px] overflow-hidden rounded-xs bg-surface-2">
            {n > 0 ? <span className="absolute inset-0 bg-accent" style={{ opacity: o }} /> : null}
          </span>
        ))}
        <span>Más</span>
      </div>
    </div>
  );
}
