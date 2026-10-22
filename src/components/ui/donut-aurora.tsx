"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { BarrasRanking, type FilaRanking } from "@/components/ui/barras-ranking";
import { TONO_CLASE } from "@/components/ui/lectura";
import { cn } from "@/lib/cn";
import { sectorEnAngulo, sectoresAnillo, type Tono } from "@/lib/graficos";

/** Una línea del centro: «Aportado 10.000 €», «+23 %». */
export type LineaCentro = { texto: string; tono?: Tono };

/** Lo que dice el centro del anillo: en reposo, el total; leyendo, un sector. */
export type Centro = { rotulo: string; cifra: string; lineas?: LineaCentro[] };

export type SectorDonut = {
  id: string;
  nombre: string;
  /** Un peldaño de `ESPECTRO_AURORA` o `COLOR_OTROS`, asignado por posición. */
  color: string;
  /** El número, para la geometría. Siempre positivo. */
  valor: number;
  /** El importe y la proporción ya formateados, para la leyenda. */
  texto: string;
  share: string;
  /** Lo que lee el centro al tocar el sector. */
  lectura: Centro;
  href?: string;
  /** El valor del periodo anterior: la muesca de su fila en la lista. */
  previo?: number | null;
  /** La variación ya escrita para su fila: «+120,00 €», con su tono. */
  variacion?: { texto: string; tono: Tono };
};

/** La caja del dibujo: un cuadrado de 200 que el CSS escala (un círculo sigue siendo un círculo). */
const LADO = 200;
const C = LADO / 2;

/**
 * Un arco de anillo: un círculo con un único guion de trazo. La pieza con la
 * que se dibuja el donut y con la que se dibujarán los ANILLOS DE PRESUPUESTO
 * (concéntricos, uno por límite, como los de Actividad): para ellos basta otro
 * radio, y un segundo arco encima para el exceso que sigue dando la vuelta.
 *
 * `desde` y `largo` en porcentaje de la vuelta (`pathLength=100`), empezando
 * a las doce y en el sentido del reloj. Los extremos van redondeados.
 */
export function ArcoAnillo({
  radio,
  grosor,
  desde,
  largo,
  color,
  opacidad = 1,
  className,
}: {
  radio: number;
  grosor: number;
  desde: number;
  largo: number;
  color: string;
  opacidad?: number;
  className?: string;
}) {
  if (largo <= 0) return null;
  const completo = largo >= 100;
  return (
    <circle
      cx={C}
      cy={C}
      r={radio}
      fill="none"
      stroke={color}
      strokeWidth={grosor}
      strokeLinecap={completo ? "butt" : "round"}
      pathLength={100}
      strokeDasharray={completo ? undefined : `${largo} ${100 - largo}`}
      strokeDashoffset={-desde}
      transform={`rotate(-90 ${C} ${C})`}
      className={cn("transition-opacity duration-150 ease-out", className)}
      style={{ opacity: opacidad }}
    />
  );
}

/**
 * EL DONUT AURORA: el reparto de pocas partes con un total que importa.
 *
 * La banda Aurora es la firma del reparto del gasto; el donut vuelve para
 * composiciones de pocas partes en las que el TOTAL es la noticia —la cartera
 * de inversión—, porque su centro es el sitio natural de esa cifra.
 *
 * LECCIÓN APRENDIDA. El donut anterior se retiró porque sus textos se
 * cortaban. Aquí no hay NI UN rótulo alrededor ni dentro de los sectores: el
 * centro es para la lectura (el total en reposo; el sector tocado, leyendo) y
 * los nombres van en una lista debajo —el ranking de barras—, que tiene todo el
 * ancho para no partir nada.
 *
 * Huecos finos entre sectores y extremos redondeados (`sectoresAnillo` descuenta
 * el remate). Al entrar, el anillo se BARRE desde las doce (una máscara que se
 * dibuja); con movimiento reducido, un fundido.
 *
 * SE TOCA: el sector bajo el dedo o el ratón se queda y los demás se atenúan;
 * tocar el hueco del centro vuelve al total. Con el teclado, las flechas
 * recorren los sectores, Escape vuelve al total e Intro abre el enlace. Y la
 * lista de debajo está casada con el anillo: pasar por una fila lee su sector.
 */
export function DonutAurora({
  sectores,
  centro,
  etiquetaAccesible,
  leyenda = true,
  className,
}: {
  sectores: SectorDonut[];
  centro: Centro;
  etiquetaAccesible: string;
  /** La lista de debajo. Sin ella, quien lo usa pone la suya. */
  leyenda?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const id = useId();
  const caja = useRef<HTMLDivElement>(null);
  const pulsando = useRef(false);
  const [activo, setActivo] = useState<number | null>(null);

  const RADIO = 82;
  const GROSOR = 16;
  // El remate redondo sobresale medio grosor por cada lado: en porcentaje de
  // la vuelta, un grosor entero por hueco.
  const remate = (GROSOR / (2 * Math.PI * RADIO)) * 100;
  const arcos = sectoresAnillo(
    sectores.map((s) => s.valor),
    { hueco: 1.6, remate },
  );
  const fracciones = arcos.map((a) => a.fraccion);
  const n = sectores.length;

  const desde = (clientX: number, clientY: number): number | null | "fuera" => {
    const r = caja.current?.getBoundingClientRect();
    if (!r || r.width === 0) return "fuera";
    const escala = r.width / LADO;
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy) / escala;
    // El hueco del centro vuelve al total; fuera del disco, nada.
    if (dist < RADIO - GROSOR) return null;
    if (dist > RADIO + GROSOR) return "fuera";
    const angulo = Math.atan2(dx, -dy);
    const vuelta = (((angulo / (2 * Math.PI)) * 100) + 100) % 100;
    return sectorEnAngulo(fracciones, vuelta);
  };

  const leer = (e: React.PointerEvent) => {
    const i = desde(e.clientX, e.clientY);
    if (i === "fuera") {
      if (e.pointerType === "mouse") setActivo(null);
      return;
    }
    setActivo(i);
  };

  const leido = activo !== null ? sectores[activo] : null;
  const lectura = leido?.lectura ?? null;

  const filas: FilaRanking[] = sectores.map((s) => ({
    id: s.id,
    nombre: s.nombre,
    color: s.color,
    valor: s.valor,
    texto: s.texto,
    share: s.share,
    href: s.href,
    previo: s.previo,
    variacion: s.variacion,
  }));

  return (
    // En escritorio, el anillo y su lista lado a lado: la lista es su leyenda,
    // y debajo de un anillo centrado quedaba media tarjeta vacía a cada lado.
    // El orden del DOM es el de móvil (anillo, luego lista).
    <div
      className={cn(
        "flex flex-col gap-4 lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:items-center lg:gap-2 lg:pb-4 lg:pl-5",
        className,
      )}
    >
      <div
        ref={caja}
        role="group"
        aria-label={`${etiquetaAccesible} Recórrelo con las flechas.`}
        tabIndex={0}
        className={cn(
          "relative mx-auto aspect-square w-[232px] cursor-pointer touch-pan-y rounded-full outline-none lg:w-[260px]",
          "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
          "focus-visible:ring-offset-surface",
        )}
        onPointerDown={(e) => {
          pulsando.current = true;
          leer(e);
        }}
        onPointerMove={(e) => {
          if (pulsando.current || e.pointerType === "mouse") leer(e);
        }}
        onPointerUp={() => {
          pulsando.current = false;
        }}
        onPointerCancel={() => {
          pulsando.current = false;
        }}
        onPointerLeave={(e) => {
          pulsando.current = false;
          if (e.pointerType === "mouse") setActivo(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") return setActivo(null);
          if (e.key === "Enter" && leido?.href) {
            e.preventDefault();
            return router.push(leido.href);
          }
          const salto =
            e.key === "ArrowRight" || e.key === "ArrowDown"
              ? 1
              : e.key === "ArrowLeft" || e.key === "ArrowUp"
                ? -1
                : 0;
          if (salto === 0) return;
          e.preventDefault();
          // El anillo es circular: aquí sí se da la vuelta.
          setActivo((i) => (i === null ? (salto > 0 ? 0 : n - 1) : (i + salto + n) % n));
        }}
      >
        <svg viewBox={`0 0 ${LADO} ${LADO}`} className="block size-full overflow-visible" aria-hidden>
          <defs>
            {/* El barrido de entrada: una máscara que se dibuja desde las doce. */}
            <mask id={`${id}-barrido`} maskUnits="userSpaceOnUse" x={0} y={0} width={LADO} height={LADO}>
              <circle
                cx={C}
                cy={C}
                r={RADIO}
                fill="none"
                stroke="#fff"
                strokeWidth={GROSOR + 24}
                pathLength={1}
                strokeDasharray={1}
                transform={`rotate(-90 ${C} ${C})`}
                className="animate-trazo"
              />
            </mask>
          </defs>
          {/* El carril, por si las partes no llenan (nunca deberían). */}
          <circle cx={C} cy={C} r={RADIO} fill="none" stroke="var(--surface-2)" strokeWidth={GROSOR} />
          <g mask={`url(#${id}-barrido)`}>
            {sectores.map((s, i) => (
              <ArcoAnillo
                key={s.id}
                radio={RADIO}
                grosor={GROSOR}
                desde={arcos[i].desde}
                largo={arcos[i].largo}
                color={s.color}
                opacidad={activo === null || activo === i ? 1 : 0.3}
              />
            ))}
          </g>
        </svg>

        {/* El centro: el total en reposo, el sector leyendo. Los dos estados en
            la misma celda, para que nada salte. El ancho es el del hueco, y el
            nombre del sector, que es lo único de largo libre, se queda en dos
            líneas como mucho (ver `TextoCentro`). */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="grid w-[62%] text-center">
            <TextoCentro c={centro} visible={lectura === null} />
            <TextoCentro c={lectura ?? centro} visible={lectura !== null} vivo />
          </div>
        </div>
      </div>

      {leyenda ? (
        <BarrasRanking
          filas={filas}
          activo={activo}
          alCambiar={setActivo}
          etiquetaAccesible={etiquetaAccesible}
        />
      ) : null}
    </div>
  );
}

/**
 * El texto del hueco. Las cifras son cortas y tienen el ancho medido; el ROTULO
 * no: es el nombre del sector, y un fondo se llama «Fidelity MSCI World Index
 * EUR P Acc». Partido en tres o cuatro líneas, el bloque crecía hasta pisar el
 * anillo, porque el hueco es un CÍRCULO: arriba, donde empieza el rótulo, es
 * más estrecho que en el ecuador. Por eso el rótulo va algo más estrecho que
 * las cifras (84 % del bloque, la cuerda del círculo a esa altura) y se queda
 * en dos líneas con puntos suspensivos. El nombre entero sigue en el DOM —el
 * recorte es solo visual—, así que el lector de pantalla lo lee completo, y
 * en la lista de debajo está su fila con el nombre (y su `title`).
 */
function TextoCentro({ c, visible, vivo = false }: { c: Centro; visible: boolean; vivo?: boolean }) {
  return (
    <div
      className={cn("col-start-1 row-start-1 flex flex-col items-center gap-[2px] self-center", !visible && "invisible")}
      aria-hidden={!visible}
      aria-live={vivo ? "polite" : undefined}
    >
      <span className="line-clamp-2 max-w-[84%] text-[13px] leading-[17px] font-semibold break-words text-muted first-letter:uppercase">
        {c.rotulo}
      </span>
      <span className="cifra text-[20px] leading-[24px] font-medium whitespace-nowrap lg:text-[24px] lg:leading-[28px]">
        {c.cifra}
      </span>
      {c.lineas?.map((l, i) => (
        <span key={i} className={cn("text-[13px] leading-[17px] tabular-nums", TONO_CLASE[l.tono ?? "neutro"])}>
          {l.texto}
        </span>
      ))}
    </div>
  );
}
