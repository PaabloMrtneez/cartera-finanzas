"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CabeceraLectura } from "@/components/ui/lectura";
import { useLectura } from "@/components/ui/use-lectura";
import { cn } from "@/lib/cn";
import {
  anchoEstimadoRotulo,
  indiceColumna,
  rotulosEjeVisibles,
  type LecturaPunto,
  type TamanoLectura,
} from "@/lib/graficos";

export type BarraDato = {
  clave: string;
  /**
   * Un valor por serie (casi siempre uno; dos en «ingresos contra gasto»).
   * Pueden ser negativos: entonces crecen hacia abajo desde el cero. No tienen
   * por qué ser dinero —a veces es un recuento—: por eso la lectura llega ya
   * escrita.
   */
  valores: number[];
  /** Rótulo corto bajo la barra: «sep», «2026». */
  eje: string;
  /** Lo que lee la cabecera al tocarla. */
  lectura: LecturaPunto;
  /** Adónde lleva: los movimientos de ese mes, por ejemplo. */
  href?: string;
};

export type SerieBarras = { id: string; nombre: string; color: string };

const ACENTO: SerieBarras[] = [{ id: "valor", nombre: "Valor", color: "var(--accent)" }];

/** Lo que pide el rótulo de la media bajo su línea: 14 px de línea, 3 de aire y 2 de margen. */
const ROTULO_MEDIA_PX = 14 + 3 + 2;

/**
 * Las barras de la app, con la gramática de Bolsa y Salud.
 *
 *  · CÁPSULAS: barras de extremos redondos, crecen desde el suelo escalonadas.
 *  · LA CABECERA ES LA LECTURA, como en la curva: al tocar una barra la cifra
 *    de arriba pasa a ser la suya y las demás se atenúan.
 *  · `media`: una discontinua por encima de las barras, con su rótulo en un
 *    CANAL APARTE a la derecha para no pisar nunca una barra.
 *  · `marcada`: la barra que importa en reposo (el mes del movimiento, el año
 *    en curso); las demás ceden un poco.
 *  · Con `href` en las barras, TOCAR OTRA VEZ ES IR: el primer toque lee y la
 *    cabecera ofrece el enlace; el segundo toque (o el clic, o Intro) navega.
 *  · EL CERO SE VE: un mes a cero deja un punto apagado sobre el suelo, gris y
 *    no del color de la serie, para que no se lea como un valor pequeño. Sin él, la barra marcada de un mes que aún no ha gastado nada
 *    desaparecía y «el último mes resaltado» no resaltaba nada.
 *  · EL EJE SE ADAPTA AL ANCHO: con muchas barras en una caja estrecha se
 *    rotula una de cada N (`rotulosEjeVisibles`), contando desde la última, y
 *    la marcada siempre. El mes entero sigue en la lectura y en el anuncio.
 *
 * Las alturas van en porcentaje de la caja y el alto de verdad lo ponen las
 * clases (`claseAlto`). Lo que se mide es el ancho, para el eje, y el alto,
 * para saber de qué lado de la media cabe su rótulo.
 */
export function BarrasInteractivas({
  barras,
  series = ACENTO,
  colorNegativo = "var(--expense)",
  media,
  marcada,
  claseAlto,
  tamano = "normal",
  enlace = "Ver movimientos",
  inicio,
  etiquetaAccesible,
  className,
  children,
}: {
  barras: BarraDato[];
  series?: SerieBarras[];
  colorNegativo?: string;
  media?: { valor: number; rotulo?: string } | null;
  marcada?: number | null;
  claseAlto: string;
  tamano?: TamanoLectura;
  enlace?: string;
  /** En `tamano="fila"`: lo de la izquierda de la cabecera (medallón y nombre). */
  inicio?: React.ReactNode;
  etiquetaAccesible: string;
  className?: string;
  /** La cabecera en reposo, con las medidas de `CIFRA_LECTURA[tamano]`. */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const total = barras.length;
  const conEnlaces = barras.some((b) => b.href);
  const { caja, ancho, alto, activo, manejadores } = useLectura({
    total,
    altoBase: 0,
    indice: (x, w) => indiceColumna(x, w, total),
    alConfirmar: conEnlaces
      ? (i) => {
          const href = barras[i]?.href;
          if (href) router.push(href);
        }
      : undefined,
  });

  // Lo que mide cada rótulo del eje, medido en el navegador (con la fuente ya
  // cargada) para decidir cuáles caben. Se vuelve a medir si cambian los
  // rótulos o el ancho: un gráfico que estaba oculto mide cero hasta verse.
  const eje = useRef<HTMLDivElement>(null);
  const clavesEje = barras.map((b) => b.eje).join("|");
  const [medidos, setMedidos] = useState<{ clave: string; anchos: number[] } | null>(null);
  useEffect(() => {
    const nodo = eje.current;
    if (!nodo) return;
    let vivo = true;
    const medir = () => {
      if (!vivo) return;
      // Un rango mide el TEXTO, no la columna flexible que lo contiene.
      const rango = document.createRange();
      const anchos = [...nodo.children].map((s) => {
        rango.selectNodeContents(s);
        return rango.getBoundingClientRect().width;
      });
      if (anchos.length > 0 && anchos.every((w) => w > 0)) {
        setMedidos({ clave: clavesEje, anchos });
      }
    };
    medir();
    document.fonts?.ready.then(medir);
    return () => {
      vivo = false;
    };
  }, [clavesEje, ancho]);

  if (total === 0) return null;

  // El dominio: lo más alto por arriba (o la media, si queda por encima) y lo
  // más hondo por abajo, con un poco de aire. El cero cae donde le toca, no a
  // media altura: un mes en rojo pequeño no merece media caja.
  const todos = barras.flatMap((b) => b.valores);
  const maxPos = Math.max(...todos, media && media.valor > 0 ? media.valor : 0, 1);
  const maxNeg = Math.max(...todos.map((v) => -v), 0);
  const rango = (maxPos + maxNeg) * 1.08;
  const cero = ((maxNeg * 1.08) / rango) * 100;
  const pct = (v: number) => (Math.abs(v) / rango) * 100;

  const leida = activo === null ? null : barras[activo];
  const rotulados = rotulosEjeVisibles(
    medidos?.clave === clavesEje
      ? medidos.anchos
      : barras.map((b) => anchoEstimadoRotulo(b.eje)),
    ancho,
    marcada ?? null,
  );

  // La altura de la media, en % de la caja. Su rótulo va DEBAJO de la línea,
  // salvo que ahí no quepa: una media baja lo sacaba de la caja y lo dejaba
  // colgando a la altura de los meses. Entonces, encima. Hasta medir, el 40 %.
  const alturaMedia = media ? cero + (media.valor >= 0 ? pct(media.valor) : -pct(media.valor)) : 0;
  const rotuloMediaArriba =
    alto > 0 ? (alturaMedia / 100) * alto < ROTULO_MEDIA_PX : alturaMedia < 40;
  const anchoCapsula =
    series.length > 1
      ? "w-[min(12px,40%)] lg:w-[min(20px,40%)]"
      : "w-[min(22px,62%)] lg:w-[min(36px,62%)]";

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <CabeceraLectura
        lectura={leida?.lectura ?? null}
        tamano={tamano}
        href={leida?.href}
        enlace={enlace}
        inicio={inicio}
      >
        {children}
      </CabeceraLectura>

      <div className="flex flex-col gap-[6px]">
        <div className="flex">
          <div
            ref={caja}
            className={cn(
              "relative flex min-w-0 flex-1 cursor-crosshair touch-pan-y outline-none",
              "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
              "focus-visible:ring-offset-surface",
              claseAlto,
            )}
            role="group"
            aria-label={
              conEnlaces ? `${etiquetaAccesible} Intro abre sus movimientos.` : etiquetaAccesible
            }
            tabIndex={0}
            {...manejadores}
          >
            {/* El cero: sin negativos es simplemente el suelo. */}
            <span
              className="pointer-events-none absolute inset-x-0 h-px bg-hairline"
              style={{ bottom: `${cero}%` }}
              aria-hidden
            />
            {barras.map((b, i) => {
              const opacidad =
                activo !== null
                  ? i === activo
                    ? 1
                    : 0.28
                  : marcada !== undefined && marcada !== null
                    ? i === marcada
                      ? 1
                      : 0.45
                    : 1;
              return (
                <div key={b.clave} className="relative flex h-full min-w-0 flex-1 justify-center gap-[3px]">
                  {b.valores.map((v, k) => {
                    const negativa = v < 0;
                    const h = pct(v);
                    if (v === 0) {
                      // El cero: un punto gris a media voz sobre la línea del
                      // cero. Dice «aquí no hubo nada» sin dibujar una cantidad
                      // que no existe. Punto y no trazo: una fila de trazos
                      // junto a la media se leía como una segunda discontinua.
                      return (
                        <div key={series[k]?.id ?? k} className={cn("relative h-full", anchoCapsula)}>
                          <span
                            className="absolute left-1/2 size-[5px] -translate-x-1/2 translate-y-[2px] rounded-full bg-muted transition-opacity duration-150 ease-out"
                            style={{ bottom: `${cero}%`, opacity: opacidad * 0.5 }}
                            aria-hidden
                          />
                        </div>
                      );
                    }
                    return (
                      <div key={series[k]?.id ?? k} className={cn("relative h-full", anchoCapsula)}>
                        <span
                          className={cn(
                            "absolute inset-x-0 animate-bar-grow rounded-full",
                            "transition-opacity duration-150 ease-out",
                            negativa ? "origin-top" : "origin-bottom",
                          )}
                          style={{
                            height: `max(4px, ${h}%)`,
                            bottom: negativa ? `calc(${cero}% - max(4px, ${h}%))` : `${cero}%`,
                            background: negativa ? colorNegativo : (series[k]?.color ?? "var(--accent)"),
                            opacity: opacidad,
                            animationDelay: `${i * 40 + k * 20}ms`,
                          }}
                          aria-hidden
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {/* La media: discontinua, por encima de las barras y sin cogerles el
                toque. Sigue hasta el canal de su rótulo. */}
            {media ? (
              <span
                className="pointer-events-none absolute right-[-44px] left-0 border-t-[1.5px] border-dashed border-fg opacity-45"
                style={{ bottom: `${alturaMedia}%` }}
                aria-hidden
              />
            ) : null}
          </div>
          {media ? (
            <div className={cn("relative w-11 shrink-0", claseAlto)} aria-hidden>
              <span
                className={cn(
                  "absolute right-0 text-[11px] leading-[14px] font-semibold tracking-[0.04em] text-muted uppercase",
                  rotuloMediaArriba ? "-translate-y-[3px]" : "translate-y-[calc(100%+3px)]",
                )}
                style={{ bottom: `${alturaMedia}%` }}
              >
                {media.rotulo ?? "Media"}
              </span>
            </div>
          ) : null}
        </div>

        <div ref={eje} className={cn("flex", media && "pr-11")} aria-hidden>
          {barras.map((b, i) => {
            const resaltada = activo !== null ? i === activo : i === marcada;
            // Los que no caben se quedan invisibles —no fuera—: así cada
            // rótulo sigue centrado bajo su barra.
            return (
              <span
                key={b.clave}
                className={cn(
                  "min-w-0 flex-1 text-center text-[11px] leading-[14px] whitespace-nowrap first-letter:uppercase",
                  "transition-colors duration-150 ease-out",
                  resaltada ? "font-semibold text-fg" : "text-muted",
                  !rotulados[i] && "invisible",
                )}
              >
                {b.eje}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
