"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * El diálogo del prototipo es dos cosas distintas según el tamaño de pantalla:
 * en móvil una hoja que sube desde abajo, en escritorio un cuadro centrado con
 * un ancho concreto para cada caso.
 *
 * Son un único componente, no dos. La diferencia es enteramente de CSS sobre el
 * mismo marcado, así que no hay dos árboles que mantener en sincronía ni salto
 * visible al cambiar el tamaño de la ventana.
 */

/** Anchos exactos que el prototipo asigna a cada diálogo, solo desde 1024 px. */
const SIZES = {
  borrar: "lg:max-w-[440px]",
  base: "lg:max-w-[520px]",
  reembolso: "lg:max-w-[560px]",
  meta: "lg:max-w-[560px]",
  suscripcion: "lg:max-w-[580px]",
  // Cuatro diálogos comparten los 620 px del prototipo. Se nombran por separado
  // porque así el código dice cuál es cada uno, no un tamaño genérico.
  registro: "lg:max-w-[620px]",
  limite: "lg:max-w-[620px]",
  posicion: "lg:max-w-[620px]",
  regla: "lg:max-w-[620px]",
  categoria: "lg:max-w-[640px]",
  limiteNuevo: "lg:max-w-[660px]",
  buscar: "lg:max-w-[680px]",
  cierre: "lg:max-w-[720px]",
  valoracion: "lg:max-w-[760px]",
  movimiento: "lg:max-w-[840px]",
  // El alta de un préstamo: el formulario a la izquierda y su vista previa a
  // la derecha, que se lee mientras se escribe.
  prestamo: "lg:max-w-[880px]",
} as const;

export type DialogSize = keyof typeof SIZES;

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  size = "base",
  title,
  description,
  children,
  className,
  style,
  instantaneo = false,
  avisarDescarte = true,
  onEscapeKeyDown,
  onPointerDownOutside,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  size?: DialogSize;
  title: string;
  description?: string;
  /** Sin animación de apertura. Para lo que se abre con el teclado. */
  instantaneo?: boolean;
  /**
   * Preguntar «¿Descartar los cambios?» antes de cerrar si se ha escrito algo.
   * Apagado en lo que no es un formulario que guarda: el buscador, los filtros,
   * el selector de gasto a reembolsar.
   */
  avisarDescarte?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const velo = useRef<HTMLDivElement>(null);
  const cerrar = useRef<HTMLButtonElement>(null);
  const arrastre = useRef<{
    id: number;
    y0: number;
    dy: number;
    t: number;
    /** Velocidad del último tramo, en px/ms (positiva hacia abajo). */
    v: number;
    activo: boolean;
  } | null>(null);

  /*
   * La hoja de móvil sube por encima del teclado.
   *
   * En móvil el panel va anclado abajo (`bottom-0`). Cuando se enfoca un campo,
   * el teclado del sistema se dibuja ENCIMA sin empujar el layout, así que una
   * hoja corta —el «Conectar un dispositivo» de Ajustes, que es un nombre y un
   * botón— quedaba entera debajo del teclado y no se veía lo que escribías.
   *
   * `visualViewport` da la altura realmente visible; su diferencia con la del
   * layout es justo lo que ocupa el teclado. Se sube la hoja esa distancia
   * poniendo su `bottom` a la altura del teclado, y se le limita el alto al hueco
   * visible para que un diálogo largo no empuje su título fuera por arriba: el
   * cuerpo ya tiene su propio scroll. En escritorio no hay teclado en pantalla:
   * `visualViewport` no encoge, `kb` se queda en `null` y el centrado `lg:` no
   * se toca.
   */
  const [kb, setKb] = useState<{ inset: number; visible: number } | null>(null);

  /*
   * «¿Descartar los cambios?» (hallazgo M-6).
   *
   * Antes, un toque en el velo, Escape, la X o un arrastre hacia abajo cerraban
   * la hoja aunque tuviera medio formulario escrito, y lo escrito se perdía sin
   * aviso. Ahora, si se ha tocado algún campo, cualquiera de esos cierres se
   * frena y la hoja pregunta. Solo los cierres DEL USUARIO: cuando el formulario
   * guarda bien y cierra la hoja desde el código, no se pregunta nada.
   *
   * «Tocado» se sabe sin que cada formulario lo cuente: los eventos `input` y
   * `change` suben hasta el panel (también el del <select> oculto de los
   * desplegables de Radix), y los controles que no son campos —fichas,
   * segmentados, interruptores— se reconocen por su rol. Solo cuenta lo que
   * está dentro de un <form>, y un buscador (`type="search"`) tampoco: lo
   * escrito ahí no es un dato que se pierda.
   */
  const tocado = useRef(false);
  const [preguntando, setPreguntando] = useState(false);
  const seguirEditando = useRef<HTMLButtonElement>(null);
  const tituloDescarte = useId();

  const marcarTocado = (e: { target: EventTarget | null }) => {
    const el = e.target as HTMLElement | null;
    // Solo lo que vive en un <form>: el buscador de ⌘K o los filtros de
    // Movimientos aplican al momento y no tienen nada que perder.
    if (!el?.closest?.("form")) return;
    if (el.closest("input[type='search'], [data-sin-descarte]")) return;
    tocado.current = true;
  };
  const marcarControl = (e: { target: EventTarget | null }) => {
    const el = e.target as HTMLElement | null;
    if (!el?.closest?.("form")) return;
    if (el.closest("[role='radio'], [aria-pressed], [role='switch'], [role='checkbox']")) {
      tocado.current = true;
    }
  };

  /** Frena un cierre del usuario si hay algo escrito. Devuelve si lo frenó. */
  const frenarCierre = (e: { preventDefault: () => void }) => {
    if (!avisarDescarte || !tocado.current) return false;
    e.preventDefault();
    setPreguntando(true);
    return true;
  };

  const descartar = () => {
    tocado.current = false;
    setPreguntando(false);
    cerrar.current?.click();
  };

  useEffect(() => {
    if (preguntando) seguirEditando.current?.focus({ preventScroll: true });
  }, [preguntando]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const actualizar = () => {
      if (window.innerWidth >= 1024) {
        setKb(null);
        return;
      }
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKb(inset > 0 ? { inset, visible: vv.height } : null);
    };
    actualizar();
    vv.addEventListener("resize", actualizar);
    vv.addEventListener("scroll", actualizar);
    return () => {
      vv.removeEventListener("resize", actualizar);
      vv.removeEventListener("scroll", actualizar);
    };
  }, []);

  /*
   * `instantaneo` apaga la animación de apertura.
   *
   * Es para lo que se abre con el teclado. La paleta de ⌘K puede usarse cien
   * veces al día, y a esa frecuencia cualquier animación deja de ser un detalle
   * y se convierte en una espera: pulsas el atajo y la interfaz tarda 320 ms en
   * dejarte escribir. Raycast no anima su apertura por esta misma razón.
   *
   * No es una preferencia estética: es la tabla de frecuencia. Cien veces al
   * día, ninguna animación.
   */
  /*
   * Entrada Y SALIDA. Radix mantiene el elemento montado mientras corre la
   * animación de cierre, así que basta con animar `data-[state=closed]`.
   *
   * Antes solo había entrada: la hoja subía al abrir y al cerrar desaparecía de
   * golpe. Eso deja la sensación de que se ha roto algo, porque un objeto que
   * llega deslizándose no se esfuma.
   *
   * Con los tiempos de iOS. En móvil es una HOJA: sube en 500 ms con el muelle
   * de UIKit (`--ease-ios`) y el velo oscurece EN PARALELO, con la misma curva;
   * al cerrar baja en 380, algo más rápido, porque al abrir acompañas tu propio
   * gesto y al cerrar solo quieres que se aparte. En escritorio es un cuadro
   * centrado y se porta como una ALERTA (UIAlertController): llega desde 1,1
   * con fundido en 280 ms y se va con un fundido de 170.
   */
  const animacion = instantaneo
    ? { scrim: "", panel: "" }
    : {
        scrim: cn(
          "animate-scrim-in lg:animate-fade-in",
          "data-[state=closed]:animate-scrim-out",
          "lg:data-[state=closed]:animate-alert-out",
        ),
        panel: cn(
          "animate-sheet-in lg:animate-alert-in",
          "data-[state=closed]:animate-sheet-out",
          "lg:data-[state=closed]:animate-alert-out",
        ),
      };

  /*
   * Arrastrar hacia abajo para cerrar, como una hoja de iOS. Solo en móvil y
   * solo desde el tirador y la cabecera: el cuerpo tiene su propio scroll y no
   * se le roba el gesto.
   *
   * La hoja SIGUE AL DEDO píxel a píxel (un estilo en línea, sin transición) y
   * el velo se aclara en proporción. Al soltar decide la intención, no solo la
   * distancia: se cierra si se bajó más de un 30 % de su alto O si se lanzó
   * hacia abajo (> 0,5 px/ms, un gesto rápido y corto también cierra). Si no,
   * vuelve a su sitio con el muelle. Es interrumpible: volver a cogerla a mitad
   * del regreso la para donde esté, porque el siguiente movimiento reescribe el
   * transform.
   *
   * Al cerrar, la salida arranca desde donde quedó (`--arrastre` en el
   * keyframe), y el velo desde su opacidad de ese momento: nada salta arriba
   * para luego bajar.
   */
  const alPresionar = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (instantaneo || window.innerWidth >= 1024 || e.button !== 0) return;
    arrastre.current = { id: e.pointerId, y0: e.clientY, dy: 0, t: e.timeStamp, v: 0, activo: false };
  };

  const alMover = (e: ReactPointerEvent<HTMLDivElement>) => {
    const a = arrastre.current;
    const hoja = panel.current;
    if (!a || a.id !== e.pointerId || !hoja) return;
    const dy = e.clientY - a.y0;
    if (!a.activo) {
      // Un umbral pequeño para no confundir un toque (el botón de cerrar) con
      // un arrastre. Hacia arriba no es el gesto de cerrar: se suelta.
      if (Math.abs(dy) < 6) return;
      if (dy < 0) {
        arrastre.current = null;
        return;
      }
      a.activo = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const dt = e.timeStamp - a.t;
    if (dt > 0) a.v = (dy - a.dy) / dt;
    a.dy = dy;
    a.t = e.timeStamp;
    // Por encima de su sitio no sube: ofrece resistencia, como la goma de iOS.
    const y = dy >= 0 ? dy : dy / 5;
    hoja.style.transition = "none";
    hoja.style.transform = `translateY(${y}px)`;
    if (velo.current) {
      velo.current.style.transition = "none";
      velo.current.style.opacity = String(Math.max(0, 1 - Math.max(0, y) / hoja.offsetHeight));
    }
  };

  const alSoltar = () => {
    const a = arrastre.current;
    arrastre.current = null;
    const hoja = panel.current;
    if (!a?.activo || !hoja) return;
    const seCierra = a.dy > hoja.offsetHeight * 0.3 || (a.v > 0.5 && a.dy > 16);
    // Con cambios sin guardar la hoja vuelve a su sitio y pregunta.
    const frenada = seCierra && avisarDescarte && tocado.current;
    if (frenada) setPreguntando(true);
    if (seCierra && !frenada) {
      hoja.style.setProperty("--arrastre", `${Math.max(0, a.dy)}px`);
      velo.current?.style.setProperty("--opacidad-salida", velo.current.style.opacity || "1");
      cerrar.current?.click();
      return;
    }
    hoja.style.transition = "transform var(--dur-sheet-out) var(--ease-ios)";
    hoja.style.transform = "";
    if (velo.current) {
      velo.current.style.transition = "opacity var(--dur-sheet-out) var(--ease-ios)";
      velo.current.style.opacity = "";
    }
  };

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        ref={velo}
        className={cn(
          // El desenfoque, solo en escritorio: en móvil el velo se funde y se
          // arrastra con la hoja, y desenfocar la pantalla entera en cada
          // fotograma es lo más caro que hay para una GPU modesta. A 2 px y
          // con el velo oscuro encima, en un teléfono no se aprecia.
          "fixed inset-0 z-50 bg-scrim lg:backdrop-blur-[2px]",
          animacion.scrim,
        )}
      />
      <DialogPrimitive.Content
        ref={panel}
        /*
         * El foco automático se hace a mano, no con autoFocus.
         *
         * En móvil la hoja empieza fuera de la pantalla y sube animándose. Si
         * el navegador enfoca un campo mientras todavía está abajo, arrastra
         * el scroll de la página persiguiéndolo, y al acabar la animación te
         * encuentras el documento desplazado hasta el final y el primer campo
         * fuera de alcance.
         *
         * Se enfoca con preventScroll para que eso no pase, y se elige el
         * primer campo real en vez del botón de cerrar.
         */
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const primero = panel.current?.querySelector<HTMLElement>(
            "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled])",
          );
          (primero ?? panel.current)?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(e) => {
          onEscapeKeyDown?.(e);
          if (e.defaultPrevented) return;
          // Con la pregunta en pantalla, Escape es «seguir editando».
          if (preguntando) {
            e.preventDefault();
            setPreguntando(false);
            return;
          }
          frenarCierre(e);
        }}
        onPointerDownOutside={(e) => {
          onPointerDownOutside?.(e);
          if (!e.defaultPrevented) frenarCierre(e);
        }}
        onInput={marcarTocado}
        onChange={marcarTocado}
        onClickCapture={marcarControl}
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden bg-surface shadow-overlay",
          // Móvil: anclado abajo, ocupando el ancho completo.
          "inset-x-0 bottom-0 max-h-[88%] rounded-t-xl",
          // Escritorio: centrado, con ancho propio y esquinas completas.
          "lg:inset-x-auto lg:bottom-auto lg:top-1/2 lg:left-1/2 lg:w-[calc(100%-2rem)]",
          "lg:max-h-[calc(100%-4rem)] lg:-translate-x-1/2 lg:-translate-y-1/2",
          "lg:rounded-lg",
          animacion.panel,
          SIZES[size],
          className,
        )}
        style={
          kb
            ? {
                ...style,
                bottom: kb.inset,
                maxHeight: kb.visible - 16,
                transition: "bottom 200ms var(--ease-drawer)",
              }
            : style
        }
        {...props}
      >
        {/* La zona de arrastre: el tirador y la cabecera. `touch-none` en
            móvil para que el navegador no la tome por un scroll. */}
        <div
          className="touch-none lg:touch-auto"
          onPointerDown={alPresionar}
          onPointerMove={alMover}
          onPointerUp={alSoltar}
          onPointerCancel={alSoltar}
        >
          {/* El tirador solo tiene sentido en la hoja móvil. */}
          <div className="flex justify-center pt-2 lg:hidden" aria-hidden>
            <span className="h-[5px] w-9 rounded-full bg-hairline" />
          </div>

          <div
            className={cn(
              // Abajo 8 px y no 12: los 4 que faltan los pone el cuerpo como
              // `pt-1`, el hueco que necesita el anillo de foco (ver abajo).
              "flex items-start gap-3 px-4 pt-[10px] pb-2",
              "lg:hair-b lg:border-hairline lg:px-[22px] lg:pt-5 lg:pb-4",
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogPrimitive.Title className="text-[22px] leading-7 font-semibold lg:text-[20px] lg:leading-[26px]">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-[15px] leading-5 text-muted lg:text-[13px] lg:leading-[18px]">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                // Radix avisa por consola si el diálogo no tiene descripción
                // accesible; declararla ausente a propósito silencia el aviso.
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>

            <DialogPrimitive.Close
              ref={cerrar}
              aria-label="Cerrar"
              onClick={frenarCierre}
              className={cn(
                "pulsable flex shrink-0 items-center justify-center bg-surface-2 text-muted",
                "size-11 rounded-full lg:size-8 lg:rounded-sm",
              )}
            >
              <X size={20} className="lg:hidden" />
              <X size={17} className="hidden lg:block" />
            </DialogPrimitive.Close>
          </div>
        </div>

        {/*
          La pregunta, entre la cabecera y el cuerpo: es la propia hoja la que
          habla, no un diálogo encima de otro. Aparece con un fundido corto.
        */}
        {preguntando ? (
          <div
            role="alertdialog"
            aria-labelledby={tituloDescarte}
            className={cn(
              "mx-4 mb-2 flex flex-col gap-3 rounded-md bg-surface-2 p-3 animate-fade-in",
              "lg:mx-[22px] lg:mt-4 lg:mb-0 lg:flex-row lg:items-center",
            )}
          >
            <p className="flex min-w-0 flex-1 flex-col">
              <span id={tituloDescarte} className="text-[15px] leading-5 font-semibold">
                ¿Descartar los cambios?
              </span>
              <span className="text-[13px] leading-[18px] text-muted">
                Lo que has escrito en esta hoja no se ha guardado.
              </span>
            </p>
            <div className="flex gap-2">
              <Button
                ref={seguirEditando}
                variant="secondary"
                size="compact"
                className="flex-1 bg-surface lg:flex-none"
                onClick={() => setPreguntando(false)}
              >
                Seguir editando
              </Button>
              <Button
                variant="destructive"
                size="compact"
                className="flex-1 lg:flex-none"
                onClick={descartar}
              >
                Descartar
              </Button>
            </div>
          </div>
        ) : null}

        {/*
          El cuerpo, con su propio scroll.

          Arriba lleva relleno a propósito. El anillo de foco (`:focus-visible`,
          2 px a 2 px del borde) se dibuja 4 px POR FUERA del campo, y este
          contenedor recorta lo que se sale porque es el que hace scroll: con el
          primer campo pegado a su borde, el anillo salía cortado por arriba —se
          veía en la paleta de búsqueda—. En móvil bastan esos 4 px (`pt-1`); en
          escritorio la cabecera acaba en un filete y el contenido necesitaba
          además aire bajo él, así que son 20, los mismos que el pie.

          Abajo, el indicador de inicio del iPhone: la hoja va anclada al borde y
          su último botón no puede quedar debajo de la barrita. Y
          `overscroll-contain` para que llegar al final de la hoja no ponga a
          desplazarse la página de detrás.
        */}
        <div
          className={cn(
            "overflow-y-auto overscroll-contain px-4 pt-1",
            "pb-[max(1rem,env(safe-area-inset-bottom))]",
            "lg:px-[22px] lg:pt-5 lg:pb-5",
          )}
        >
          {children}
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * Pie de acciones. En móvil los botones son altos y ocupan todo el ancho; en
 * escritorio se recogen a la derecha y son más bajos.
 */
export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex gap-3 lg:justify-end lg:gap-2">{children}</div>
  );
}
