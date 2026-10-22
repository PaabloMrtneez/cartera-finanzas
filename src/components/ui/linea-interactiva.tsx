"use client";

import { useId, useMemo } from "react";
import { CabeceraLectura, usePublicarLectura } from "@/components/ui/lectura";
import { useLectura } from "@/components/ui/use-lectura";
import { cn } from "@/lib/cn";
import {
  cerrarArea,
  escalaBonita,
  extremos,
  indiceLinea,
  rotuloEje,
  rutaRecta,
  tramos,
  ultimoConDato,
  type FormatoEje,
  type LecturaPunto,
  type Pt,
  type TamanoLectura,
} from "@/lib/graficos";

export type SerieLinea = {
  id: string;
  nombre: string;
  /**
   * Los números, para la geometría. Un `null` es «aquí todavía no hay dato»:
   * la línea se corta y no baja a cero.
   */
  valores: (number | null)[];
  /**
   * Los mismos datos ya formateados, uno por índice. Vienen hechos de fuera:
   * quien dibuja es un componente de cliente y `formatCents` no cruza la
   * frontera como función. Los strings sí.
   */
  textos: string[];
  /**
   * La serie de REFERENCIA (el periodo anterior, el año pasado): discontinua,
   * fina y apagada, por detrás. Su valor en el punto leído sale en la línea de
   * leyenda de debajo.
   */
  previa?: boolean;
  /**
   * Una PROYECCIÓN: lo que todavía no ha pasado (el cierre previsto del mes, el
   * camino hasta una meta). Discontinua y en el cian del acento, para que no se
   * confunda con el periodo anterior, que es gris. Lleva `null` hasta el
   * presente y arranca en el último punto real.
   */
  proyeccion?: boolean;
};

/** Una referencia horizontal con nombre: el objetivo de una meta. */
export type GuiaLinea = { valor: number; rotulo: string };

/** Aire a la izquierda y a la derecha cuando no hay escala. */
const MX = 6;
/** El canal de la escala, a la derecha, como en una esfera. */
const CANAL_ESCALA = 46;
/** Por debajo de este ancho, las anotaciones son discretas: no se amontonan. */
const ANCHO_HOLGADO = 560;
/** El oro del espectro, para las marcas sobre la curva. */
const ORO = "var(--aurora-5)";
/**
 * El oro como TEXTO. `--warning` es el oro del espectro templado para leerse en
 * cada tema: en oscuro (y sobre la losa de tinta) es exactamente `--aurora-5`;
 * en claro baja de tono para cumplir contraste.
 */
const ORO_TEXTO = "var(--warning)";
const CIFRA_SVG = {
  fontFamily: "var(--font-cifra)",
  fontVariantNumeric: "tabular-nums",
} as const;

/**
 * El gráfico de línea de la app, con la gramática de Bolsa y Salud.
 *
 *  · Trazo FINO con el espectro Aurora (violeta → cian → oro, de izquierda a
 *    derecha) y un velo de área casi invisible.
 *  · LA CABECERA ES LA LECTURA: al recorrer la curva —dedo, ratón o flechas—
 *    la cifra de arriba pasa a ser la del punto, con su fecha y su variación
 *    (`lecturas`). Nada flota sobre la curva; el tramo tras el dedo se apaga,
 *    para que se lea «hasta aquí».
 *  · La serie `previa` va en discontinua, y su valor en el punto leído sale en
 *    la línea de leyenda.
 *  · `anotaciones`: MÁX, MÍN y HOY en oro sobre la propia curva, para las
 *    curvas de NIVEL (patrimonio, saldo, compromiso). En una caja estrecha son
 *    discretas: si no caben las tres, solo HOY. Se apartan mientras se lee.
 *  · `escala`: los valores del eje a la derecha, en su canal.
 *  · `heroe`: el gráfico principal de la pantalla. El trazo se DIBUJA al
 *    entrar y el presente es un punto de oro con un halo que late en
 *    opacidad. Con movimiento reducido, el trazo aparece con un fundido y el
 *    halo se queda quieto. Uno por pantalla: si todo es héroe, nada lo es.
 *  · `compartida`: la lectura no se pinta aquí, se publica para la cifra héroe
 *    de la pantalla (`LecturaCompartida`). El patrimonio lee en la losa.
 *
 * El alto va en clases (`claseAlto`), no en un número: en escritorio hay sitio
 * para más, y una media query en JavaScript sería una segunda fuente de la
 * misma medida. `altoBase` es el de móvil, para el primer fotograma.
 */
/** Sin guías: una constante, no un `[]` nuevo por render, para no romper el memo del dominio. */
const SIN_GUIAS: GuiaLinea[] = [];

export function LineaInteractiva({
  series,
  lecturas,
  ejeX,
  marcasX,
  altoBase,
  claseAlto,
  formato = "euros",
  desdeCero = false,
  incluirCero = false,
  escala = false,
  anotaciones = false,
  heroe = false,
  compartida = false,
  rotuloHoy = "HOY",
  leyendaPrevia,
  leyendaProyeccion,
  guias = SIN_GUIAS,
  sombrearEntre = false,
  tamano = "normal",
  inicio,
  etiquetaAccesible,
  className,
  children,
}: {
  series: SerieLinea[];
  /** Lo que lee la cabecera en cada índice. */
  lecturas: LecturaPunto[];
  /** Rótulo corto de eje por índice: «12 ago», «ago 26». */
  ejeX: string[];
  /** Qué índices se rotulan bajo el eje. Por defecto, el primero, el del medio y el último. */
  marcasX?: number[];
  altoBase: number;
  claseAlto: string;
  formato?: FormatoEje;
  /** El eje arranca en cero: para cantidades (gasto acumulado), no para saldos. */
  desdeCero?: boolean;
  /** El cero entra en el dominio y se marca: la frontera entre ganar y perder. */
  incluirCero?: boolean;
  escala?: boolean;
  anotaciones?: boolean;
  heroe?: boolean;
  compartida?: boolean;
  rotuloHoy?: string;
  /** «Periodo anterior, ese mes»: el rótulo de la línea de leyenda de la previa. */
  leyendaPrevia?: string;
  /** La línea de leyenda de la proyección: «Cierre previsto ≈ 1.240 €». */
  leyendaProyeccion?: string;
  /** Referencias horizontales en oro, con su rótulo: «META 5.000». */
  guias?: GuiaLinea[];
  /**
   * Sombrea el hueco entre la curva principal y la `previa`: en verde donde la
   * principal va por encima, en rojo donde va por debajo. Es «valor frente a
   * aportado»: la ganancia o la pérdida se ve como una superficie. Sin velo.
   */
  sombrearEntre?: boolean;
  tamano?: TamanoLectura;
  /** En `tamano="fila"`: lo de la izquierda de la cabecera (medallón y nombre). */
  inicio?: React.ReactNode;
  etiquetaAccesible: string;
  className?: string;
  /** La cabecera en reposo, con las medidas de `CIFRA_LECTURA[tamano]`. */
  children?: React.ReactNode;
}) {
  const total = ejeX.length;
  const conEscala = escala || anotaciones;
  const MR = conEscala ? CANAL_ESCALA : MX;
  // Aire arriba y abajo: lo justo para el punto, o para el rótulo de una
  // anotación cuando las hay.
  const MT = anotaciones ? 22 : 10;
  const MB = anotaciones ? 20 : 8;

  const esPrincipal = (s: SerieLinea) => !s.previa && !s.proyeccion;
  const principalDatos = (series.find(esPrincipal) ?? series[0]).valores;
  const { caja, ancho, alto, activo, manejadores } = useLectura({
    total,
    altoBase,
    indice: (x, w) => indiceLinea(x, w, total, MX, MR),
    inicio: ultimoConDato(principalDatos) ?? undefined,
  });
  const id = useId();
  const act = activo === null ? null : Math.min(activo, total - 1);
  const lecturaActiva = act === null ? null : (lecturas[act] ?? null);
  const enProveedor = usePublicarLectura(lecturaActiva, compartida);

  const principal = series.find(esPrincipal) ?? series[0];
  const previa = series.find((s) => s.previa) ?? null;
  const proyeccion = series.find((s) => s.proyeccion) ?? null;

  // El dominio: todos los valores con dato, de todas las series, y las guías.
  // Memorizado: al leer con el dedo cambia solo el punto leído, y recorrer
  // todas las series para el mínimo y el máximo en cada render sobra (con
  // «Todo» en Patrimonio o un préstamo a 360 meses, son cientos de valores).
  const { suelo, techo, ticks } = useMemo(() => {
    const todos = [
      ...series.flatMap((s) => s.valores).filter((v): v is number => v !== null),
      ...guias.map((g) => g.valor),
    ];
    let min = todos.length ? Math.min(...todos) : 0;
    let max = todos.length ? Math.max(...todos) : 1;
    if (desdeCero || incluirCero) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    if (conEscala) {
      // Con escala, el dominio es el de la propia escala: las guías caen en
      // valores redondos y la curva no toca los bordes.
      const e = escalaBonita(min, max, alto < 140 ? 2 : 4, formato === "euros" ? 100 : 1);
      return { suelo: e.desde, techo: e.hasta, ticks: e.ticks };
    }
    const holgura = Math.max((max - min) * 0.08, 1);
    return { suelo: desdeCero ? 0 : min - holgura, techo: max + holgura, ticks: [] as number[] };
  }, [series, guias, desdeCero, incluirCero, conEscala, alto, formato]);
  const derecha = ancho - MR;
  const x = (i: number) => MX + (i * (derecha - MX)) / Math.max(total - 1, 1);
  const y = (v: number) => MT + (1 - (v - suelo) / Math.max(techo - suelo, 1e-9)) * (alto - MT - MB);

  const tramosPrincipal = useMemo(() => tramos(principal.valores), [principal.valores]);
  const ptsDe = (s: SerieLinea, indices: number[]): Pt[] =>
    indices.map((i) => ({ x: x(i), y: y(s.valores[i] as number) }));
  const ultimo = ultimoConDato(principal.valores);
  const primero = principal.valores.findIndex((v) => v !== null);
  const ext = useMemo(
    () => (anotaciones ? extremos(principal.valores) : null),
    [anotaciones, principal.valores],
  );

  // El tramo a la derecha del dedo se apaga.
  const corte = act === null ? ancho + 20 : x(act);
  const iLeido = act ?? ultimo ?? total - 1;
  // Una firma del dato: si cambia (otro rango), el trazo se vuelve a dibujar.
  const firma = `${total}-${ejeX[0]}-${ejeX[total - 1]}`;

  const marcas = marcasX ?? [0, Math.floor((total - 1) / 2), total - 1];
  const leyendo = act !== null;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {compartida && enProveedor ? (
        children
      ) : (
        <CabeceraLectura lectura={lecturaActiva} tamano={tamano} inicio={inicio}>
          {children}
        </CabeceraLectura>
      )}

      <div className="flex flex-col gap-[6px]">
        <div
          ref={caja}
          className={cn(
            "relative w-full cursor-crosshair touch-pan-y outline-none",
            "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
            "focus-visible:ring-offset-surface",
            claseAlto,
          )}
          role="group"
          aria-label={etiquetaAccesible}
          tabIndex={0}
          {...manejadores}
        >
          <svg
            viewBox={`0 0 ${ancho} ${alto}`}
            width={ancho}
            height={alto}
            className={cn("block overflow-visible", !heroe && "animate-chart-in")}
            aria-hidden
          >
            {/*
              Los colores de los degradados van en `style`, NO en `stop-color`:
              como atributo de presentación, `var(--x)` no se resuelve y el
              degradado sale negro. Y en coordenadas de usuario: en unidades del
              objeto, una línea plana tiene caja de alto cero y desaparece.
            */}
            <defs>
              <linearGradient
                id={`${id}-espectro`}
                gradientUnits="userSpaceOnUse"
                x1={x(Math.max(primero, 0))}
                y1={0}
                x2={Math.max(x(ultimo ?? total - 1), x(Math.max(primero, 0)) + 1)}
                y2={0}
              >
                <stop offset="0%" style={{ stopColor: "var(--v-aurora)" }} />
                <stop offset="52%" style={{ stopColor: "var(--c-aurora)" }} />
                <stop offset="100%" style={{ stopColor: "var(--g-aurora)" }} />
              </linearGradient>
              <linearGradient id={`${id}-fundido`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: "#fff", stopOpacity: 0.2 }} />
                <stop offset="100%" style={{ stopColor: "#fff", stopOpacity: 0 }} />
              </linearGradient>
              <mask id={`${id}-velo`} maskUnits="userSpaceOnUse" x={0} y={0} width={ancho} height={alto}>
                <rect x={0} y={0} width={ancho} height={alto} fill={`url(#${id}-fundido)`} />
              </mask>
              <clipPath id={`${id}-izq`}>
                <rect x={-10} y={-30} width={Math.max(corte + 10, 0)} height={alto + 60} />
              </clipPath>
              <clipPath id={`${id}-der`}>
                <rect x={corte} y={-30} width={Math.max(ancho - corte + 10, 0)} height={alto + 60} />
              </clipPath>
              {/* Para sombrear entre curvas: lo que queda por encima de la
                  referencia (ganancia) y lo que queda por debajo (pérdida). */}
              {sombrearEntre && previa
                ? (["arriba", "abajo"] as const).map((lado) => {
                    const pts = ptsDe(previa, tramos(previa.valores).flat());
                    if (pts.length === 0) return null;
                    const borde = lado === "arriba" ? -40 : alto + 40;
                    const a = pts[0].x.toFixed(2);
                    const z = pts[pts.length - 1].x.toFixed(2);
                    return (
                      <clipPath key={lado} id={`${id}-${lado}`}>
                        <path
                          d={`M${a},${borde}${rutaRecta(pts).replace(/^M/, "L")}L${z},${borde}Z`}
                        />
                      </clipPath>
                    );
                  })
                : null}
            </defs>

            {/* La escala: guías de filete y sus valores en el canal derecho. */}
            {conEscala
              ? ticks.map((t, k) => (
                  <g key={t}>
                    <line
                      x1={0}
                      x2={derecha}
                      y1={y(t)}
                      y2={y(t)}
                      stroke={k === 0 || (incluirCero && t === 0) ? "var(--hairline)" : "var(--separator)"}
                    />
                    <text
                      x={ancho}
                      y={y(t)}
                      dominantBaseline="middle"
                      textAnchor="end"
                      fontSize={11}
                      fill="var(--muted)"
                      style={CIFRA_SVG}
                    >
                      {rotuloEje(t, formato)}
                    </text>
                  </g>
                ))
              : null}
            {!conEscala ? (
              <line
                x1={0}
                x2={ancho}
                y1={incluirCero ? y(0) : alto - 0.5}
                y2={incluirCero ? y(0) : alto - 0.5}
                stroke="var(--hairline)"
              />
            ) : null}

            {/* Las guías: una referencia en oro (el objetivo de una meta), con su
                rótulo encima, pegado a la izquierda. */}
            {guias.map((g) => (
              <g key={`guia-${g.rotulo}`}>
                <line
                  x1={0}
                  x2={derecha}
                  y1={y(g.valor)}
                  y2={y(g.valor)}
                  stroke={ORO}
                  strokeOpacity={0.7}
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
                <text
                  x={MX}
                  y={y(g.valor) - 5}
                  fontSize={11}
                  fontWeight={600}
                  letterSpacing="0.06em"
                  fill={ORO_TEXTO}
                  style={CIFRA_SVG}
                >
                  {g.rotulo}
                </text>
              </g>
            ))}

            <g key={firma}>
              {/* Entre la principal y su referencia: la ganancia en verde y la
                  pérdida en rojo, como una superficie. */}
              {sombrearEntre && previa ? (
                <g
                  className={heroe ? "animate-fade-in" : undefined}
                  style={heroe ? { animationDelay: "320ms" } : undefined}
                >
                  {tramos(
                    principal.valores.map((v, i) =>
                      v === null || previa.valores[i] === null ? null : v,
                    ),
                  ).map((indices) => {
                    const arriba = ptsDe(principal, indices);
                    const abajo = ptsDe(previa, [...indices].reverse());
                    const d = `${rutaRecta(arriba)}${rutaRecta(abajo).replace(/^M/, "L")}Z`;
                    return (
                      <g key={`s${indices[0]}`}>
                        <path
                          d={d}
                          fill="var(--income)"
                          fillOpacity={0.2}
                          clipPath={`url(#${id}-arriba)`}
                        />
                        <path
                          d={d}
                          fill="var(--expense)"
                          fillOpacity={0.2}
                          clipPath={`url(#${id}-abajo)`}
                        />
                      </g>
                    );
                  })}
                </g>
              ) : null}

              {/* El velo: el mismo espectro, apagado hacia abajo. Casi no se ve,
                  y es lo justo: da cuerpo sin competir con el trazo. */}
              <g
                className={heroe ? "animate-fade-in" : undefined}
                style={heroe ? { animationDelay: "320ms" } : undefined}
              >
                {(sombrearEntre ? [] : tramosPrincipal).map((indices) => {
                  const pts = ptsDe(principal, indices);
                  return (
                    <path
                      key={`a${indices[0]}`}
                      d={cerrarArea(rutaRecta(pts), pts, alto)}
                      fill={`url(#${id}-espectro)`}
                      mask={`url(#${id}-velo)`}
                    />
                  );
                })}
              </g>

              {previa
                ? tramos(previa.valores).map((indices) => (
                    <path
                      key={`p${indices[0]}`}
                      d={rutaRecta(ptsDe(previa, indices.length === 1 ? [indices[0], indices[0]] : indices))}
                      fill="none"
                      stroke="var(--muted)"
                      strokeOpacity={0.55}
                      strokeWidth={1.25}
                      strokeDasharray="3 4"
                      strokeLinecap="round"
                    />
                  ))
                : null}

              {proyeccion
                ? tramos(proyeccion.valores).map((indices) => (
                    <path
                      key={`f${indices[0]}`}
                      d={rutaRecta(
                        ptsDe(
                          proyeccion,
                          indices.length === 1 ? [indices[0], indices[0]] : indices,
                        ),
                      )}
                      fill="none"
                      stroke="var(--accent)"
                      strokeOpacity={0.9}
                      strokeWidth={1.75}
                      strokeDasharray="4 4"
                      strokeLinecap="round"
                      className={heroe ? "animate-fade-in" : undefined}
                      style={heroe ? { animationDelay: "560ms" } : undefined}
                    />
                  ))
                : null}

              {/* El trazo, dos veces: entero a la izquierda del dedo, apagado a
                  la derecha. Sin lectura, el corte cae fuera y se ve entero. */}
              {(["izq", "der"] as const).map((lado) =>
                tramosPrincipal.map((indices) => (
                  <path
                    key={`${lado}${indices[0]}`}
                    d={rutaRecta(ptsDe(principal, indices.length === 1 ? [indices[0], indices[0]] : indices))}
                    fill="none"
                    stroke={`url(#${id}-espectro)`}
                    strokeOpacity={lado === "izq" ? 1 : 0.28}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    clipPath={`url(#${id}-${lado})`}
                    pathLength={heroe ? 1 : undefined}
                    strokeDasharray={heroe ? 1 : undefined}
                    className={heroe ? "animate-trazo" : undefined}
                  />
                )),
              )}
            </g>

            {/* El presente y, si las hay, las anotaciones. Se apartan —con
                transición, sin desmontarse— mientras se lee otro punto. */}
            {ultimo !== null ? (
              <g
                className="transition-opacity duration-150 ease-out"
                style={{ opacity: leyendo ? 0 : 1 }}
              >
                {ext ? (
                  <Anotaciones
                    pts={{
                      max: {
                        x: x(ext.iMax),
                        y: y(principal.valores[ext.iMax] as number),
                      },
                      min: {
                        x: x(ext.iMin),
                        y: y(principal.valores[ext.iMin] as number),
                      },
                      hoy: {
                        x: x(ultimo),
                        y: y(principal.valores[ultimo] as number),
                      },
                    }}
                    indices={{ max: ext.iMax, min: ext.iMin, hoy: ultimo }}
                    textos={{
                      max: rotuloEje(principal.valores[ext.iMax] as number, formato),
                      min: rotuloEje(principal.valores[ext.iMin] as number, formato),
                    }}
                    rotuloHoy={rotuloHoy}
                    derecha={derecha}
                    alto={alto}
                    holgado={ancho >= ANCHO_HOLGADO}
                  />
                ) : null}
                <Presente
                  key={firma}
                  cx={x(ultimo)}
                  cy={y(principal.valores[ultimo] as number)}
                  heroe={heroe}
                  anillo={anotaciones}
                />
              </g>
            ) : null}

            {/* Lo que se está tocando: plomada y un punto por serie. */}
            {act !== null ? (
              <g>
                <line
                  x1={x(act)}
                  x2={x(act)}
                  y1={0}
                  y2={alto}
                  stroke="var(--fg)"
                  strokeOpacity={0.32}
                  strokeWidth={1}
                />
                {previa && previa.valores[act] !== null ? (
                  <circle
                    cx={x(act)}
                    cy={y(previa.valores[act] as number)}
                    r={3}
                    fill="var(--muted)"
                    stroke="var(--surface)"
                    strokeWidth={1.5}
                  />
                ) : null}
                {principal.valores[act] !== null ? (
                  <circle
                    cx={x(act)}
                    cy={y(principal.valores[act] as number)}
                    r={5}
                    fill="var(--fg)"
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                ) : proyeccion && proyeccion.valores[act] !== null ? (
                  <circle
                    cx={x(act)}
                    cy={y(proyeccion.valores[act] as number)}
                    r={4.5}
                    fill="var(--surface)"
                    stroke="var(--accent)"
                    strokeWidth={2}
                  />
                ) : null}
              </g>
            ) : null}
          </svg>
        </div>

        {/* El eje del tiempo: unos pocos rótulos, colocados donde caen. */}
        <div className="relative h-[14px] text-[11px] leading-[14px] text-muted tabular-nums" aria-hidden>
          {marcas
            .filter((i, k, a) => i >= 0 && i < total && a.indexOf(i) === k)
            .map((i) => {
              const extremo = i === 0 ? "start" : i === total - 1 ? "end" : "middle";
              return (
                <span
                  key={i}
                  className="absolute top-0 whitespace-nowrap first-letter:uppercase"
                  style={{
                    left: x(i),
                    transform:
                      extremo === "start"
                        ? `translateX(-${MX}px)`
                        : extremo === "end"
                          ? "translateX(-100%)"
                          : "translateX(-50%)",
                  }}
                >
                  {ejeX[i]}
                </span>
              );
            })}
        </div>
      </div>

      {proyeccion && leyendaProyeccion ? (
        <p className="flex items-center gap-2 text-[13px] leading-[18px] text-muted tabular-nums">
          <span
            className="h-0 w-4 shrink-0 border-t-[1.5px] border-dashed border-accent"
            aria-hidden
          />
          <span className="min-w-0 truncate">{leyendaProyeccion}</span>
        </p>
      ) : null}

      {previa && leyendaPrevia ? (
        <p className="flex items-center gap-2 text-[13px] leading-[18px] text-muted tabular-nums">
          <span className="h-0 w-4 shrink-0 border-t-[1.5px] border-dashed border-muted opacity-70" aria-hidden />
          <span className="min-w-0 truncate">
            {leyendaPrevia}: <span className="text-fg">{previa.textos[iLeido] ?? "—"}</span>
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * El presente. En el gráfico héroe, un punto de oro con un halo que late en
 * opacidad y aparece cuando el trazo ya ha llegado; con anotaciones, un anillo
 * de oro (la marca de HOY); si no, un punto de oro sencillo.
 */
function Presente({
  cx,
  cy,
  heroe,
  anillo,
}: {
  cx: number;
  cy: number;
  heroe: boolean;
  anillo: boolean;
}) {
  if (heroe) {
    return (
      <g className="animate-fade-in" style={{ animationDelay: "560ms" }}>
        <circle className="animate-halo" cx={cx} cy={cy} r={11} fill={ORO} />
        <circle cx={cx} cy={cy} r={4.5} fill={ORO} stroke="var(--surface)" strokeWidth={2} />
      </g>
    );
  }
  if (anillo) {
    return (
      <g>
        <circle cx={cx} cy={cy} r={5.5} fill="none" stroke={ORO} strokeWidth={1} />
        <circle cx={cx} cy={cy} r={2.5} fill={ORO} />
      </g>
    );
  }
  return <circle cx={cx} cy={cy} r={3.5} fill={ORO} stroke="var(--surface)" strokeWidth={2} />;
}

type Caja = { x0: number; x1: number; y0: number; y1: number };

const solapan = (a: Caja, b: Caja) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Ancho aproximado de un rótulo de 11 px en la de cifras. */
const anchoTexto = (t: string) => t.length * 6.6 + 4;

/**
 * MÁX, MÍN y HOY en oro, escritos sobre la curva. En una caja holgada van
 * siempre; en una estrecha, solo si caben sin pisarse —si no, queda HOY, que
 * es lo que más se mira—.
 */
function Anotaciones({
  pts,
  indices,
  textos,
  rotuloHoy,
  derecha,
  alto,
  holgado,
}: {
  pts: Record<"max" | "min" | "hoy", Pt>;
  indices: Record<"max" | "min" | "hoy", number>;
  textos: Record<"max" | "min", string>;
  rotuloHoy: string;
  derecha: number;
  alto: number;
  holgado: boolean;
}) {
  const ancla = (px: number, w: number): "start" | "middle" | "end" =>
    px < w / 2 + 2 ? "start" : px > derecha - w / 2 - 2 ? "end" : "middle";

  const etiqueta = (clave: "max" | "min") => {
    const p = pts[clave];
    const texto = `${clave === "max" ? "MÁX" : "MÍN"} ${textos[clave]}`;
    const w = anchoTexto(texto);
    // El máximo se rotula por encima; el mínimo por debajo, salvo que no quepa.
    const arriba = clave === "max" ? p.y - 22 > 0 || p.y + 26 > alto : p.y + 26 > alto;
    const ty = arriba ? p.y - 12 : p.y + 20;
    const a = ancla(p.x, w);
    const x0 = a === "start" ? p.x : a === "end" ? p.x - w : p.x - w / 2;
    return {
      clave,
      texto,
      ty,
      a,
      arriba,
      caja: { x0, x1: x0 + w, y0: ty - 11, y1: ty + 3 },
    };
  };

  const hoy = pts.hoy;
  // HOY se escribe a la izquierda del punto, por encima: el presente suele
  // estar en el borde derecho.
  const wHoy = anchoTexto(rotuloHoy);
  const hoyArriba = hoy.y - 22 > 0;
  const tyHoy = hoyArriba ? hoy.y - 11 : hoy.y + 19;
  const cajaHoy: Caja = {
    x0: hoy.x + 4 - wHoy,
    x1: hoy.x + 6,
    y0: tyHoy - 11,
    y1: tyHoy + 3,
  };

  let extremosVisibles = (["max", "min"] as const)
    .filter((k) => indices[k] !== indices.hoy)
    .map(etiqueta);
  if (indices.max === indices.min) extremosVisibles = [];

  if (!holgado) {
    const cajas = extremosVisibles.map((e) => e.caja);
    const chocan =
      cajas.some((c) => solapan(c, cajaHoy)) || (cajas.length === 2 && solapan(cajas[0], cajas[1]));
    if (chocan) extremosVisibles = [];
  }

  return (
    <g>
      {extremosVisibles.map((e) => {
        const p = pts[e.clave];
        return (
          <g key={e.clave}>
            <line
              x1={p.x}
              x2={p.x}
              y1={p.y + (e.arriba ? -4 : 4)}
              y2={p.y + (e.arriba ? -8 : 8)}
              stroke={ORO}
            />
            <circle cx={p.x} cy={p.y} r={3} fill="var(--surface)" stroke={ORO} strokeWidth={1.25} />
            <text x={p.x} y={e.ty} textAnchor={e.a} fontSize={11} fill={ORO_TEXTO} style={CIFRA_SVG}>
              <tspan fontWeight={600} letterSpacing="0.06em">
                {e.clave === "max" ? "MÁX" : "MÍN"}
              </tspan>{" "}
              {textos[e.clave]}
            </text>
          </g>
        );
      })}
      <text
        x={hoy.x + 6}
        y={tyHoy}
        textAnchor="end"
        fontSize={11}
        fontWeight={600}
        letterSpacing="0.06em"
        fill={ORO_TEXTO}
        style={CIFRA_SVG}
      >
        {rotuloHoy}
      </text>
    </g>
  );
}
