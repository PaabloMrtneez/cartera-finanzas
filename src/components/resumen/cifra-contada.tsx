"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  bienvenidaPendiente,
  borrarRegistroReciente,
  duracionCuenta,
  easeOutExpo,
  evaluarRegistro,
  marcarBienvenidaVista,
  type EvaluacionRegistro,
  type RegistroReciente,
} from "@/lib/cuenta";
import { formatCents } from "@/lib/money";

/*
  El efecto que evita el destello corre ANTES de pintar, así que tiene que ser
  `useLayoutEffect`. Pero en el render de servidor React avisa de que ese efecto
  no hace nada; se cae a `useEffect` cuando no hay ventana para callar el aviso
  sin perder el pre-pintado en cliente.
*/
const useEfectoVisual = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * El modo de las cifras de la pantalla, leído UNA vez arriba y repartido por
 * contexto. Dos motivos por los que una cifra puede contar:
 *  · `registro`: se acaba de registrar un movimiento y su cifra sube desde el
 *    valor anterior (recorre el importe);
 *  · `bienvenida`: es la primera carga de Resumen de la sesión y las tres cifras
 *    héroe suben de 0 a su valor, como saludo.
 *
 * Que la lectura sea única es lo que garantiza que dispare una sola vez y de
 * forma coherente en todas las cifras a la vez.
 */
type ModoContada = {
  /** Señal de registro reciente que animar en esta pantalla, o null. */
  registro: RegistroReciente | null;
  /** Si toca la cuenta de bienvenida (primera carga de la sesión). */
  bienvenida: boolean;
};

const ModoContext = createContext<ModoContada>({ registro: null, bienvenida: false });

/**
 * Envuelve las cifras de una pantalla y decide qué cuenta disparar: la del
 * registro recién hecho o la de bienvenida.
 *
 * La lectura va en el inicializador de `useState`, no en un efecto, para que la
 * PRIMERA pintura del cliente ya sepa si va a animar: si se leyera en un efecto,
 * habría un fotograma con el valor final antes de que la cuenta lo baje a su
 * inicio, y se vería el número «rebotar». El inicializador es puro (solo lee);
 * los efectos colaterales —borrar la señal, marcar la bienvenida— van aparte.
 */
export function RegistroRecienteProvider({
  mesActual,
  children,
}: {
  mesActual: string;
  children: React.ReactNode;
}) {
  const [lectura] = useState<{ evaluacion: EvaluacionRegistro; bienvenidaPend: boolean }>(() => ({
    evaluacion: evaluarRegistro(mesActual),
    bienvenidaPend: bienvenidaPendiente(),
  }));

  useEffect(() => {
    // Consumir la señal: una segunda visita no vuelve a contar. Idempotente, así
    // que el doble montaje de StrictMode no molesta.
    if (lectura.evaluacion.limpiar) borrarRegistroReciente();
    // La PRIMERA carga de la sesión gasta la bienvenida, anime o no: así es «una
    // vez por sesión» de verdad y no queda pendiente para una visita futura.
    if (lectura.bienvenidaPend) marcarBienvenidaVista();
  }, [lectura]);

  // El registro manda: si acaba de registrarse un movimiento que anima aquí, la
  // bienvenida no se dispara además (no duplicar motion). Una cifra sube por una
  // razón o por otra, nunca por las dos.
  const registroAnima = lectura.evaluacion.animar !== null;
  const valor: ModoContada = {
    registro: lectura.evaluacion.animar,
    bienvenida: lectura.bienvenidaPend && !registroAnima,
  };

  return <ModoContext.Provider value={valor}>{children}</ModoContext.Provider>;
}

/** Qué cifra es cada una, para casarla con el tipo de la señal. */
type Campo = "gasto" | "ingresos" | "balance";

function correspondeA(tipo: RegistroReciente["tipo"], campo: Campo): boolean {
  // El balance no lo anima ningún registro (hoy solo sube gasto o ingresos): solo
  // participa en la bienvenida.
  return (tipo === "EXPENSE" && campo === "gasto") || (tipo === "INCOME" && campo === "ingresos");
}

/**
 * Cuenta un número desde `objetivo − delta` hasta `objetivo` con una curva
 * ease-out, interpolando por `requestAnimationFrame` (es texto que cambia, no
 * algo que se pueda animar con CSS).
 *
 * Reutilizable a propósito: recibe objetivo, delta, si está activo y una
 * duración opcional, para poder llevarlo luego a Cuentas o Patrimonio sin tocar
 * nada. Devuelve el valor a pintar y `saltar()` para ir al final.
 *
 * Buen gusto:
 *  · arranca en `objetivo` —el valor que pinta el servidor— para que la primera
 *    pintura del cliente case y no haya aviso de hidratación;
 *  · con `prefers-reduced-motion` no cuenta: enseña ya el valor final;
 *  · cancela el `rAF` al desmontar o al saltar.
 */
export function useContarHasta({
  objetivo,
  delta,
  activo,
  duracion,
}: {
  objetivo: number;
  delta: number;
  activo: boolean;
  duracion?: number;
}): { valor: number; saltar: () => void } {
  const [valor, setValor] = useState(objetivo);
  const rafRef = useRef<number | null>(null);

  const cancelar = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const saltar = useCallback(() => {
    cancelar();
    setValor(objetivo);
  }, [cancelar, objetivo]);

  useEfectoVisual(() => {
    if (!activo || delta === 0) {
      setValor(objetivo);
      return;
    }

    // Movimiento reducido: se enseña ya el valor final, sin contar.
    const reducido =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducido) {
      setValor(objetivo);
      return;
    }

    const dur = duracion ?? duracionCuenta(delta);
    const inicio = objetivo - delta;
    // Bajar al inicio ocurre antes de pintar (useLayoutEffect), así que el primer
    // fotograma que se ve ya es el de partida: nadie llega a ver el valor final.
    setValor(inicio);

    let t0: number | null = null;
    const paso = (ahora: number) => {
      if (t0 === null) t0 = ahora;
      const p = Math.min(1, (ahora - t0) / dur);
      // El último fotograma se fija al objetivo exacto: nada de céntimos sueltos
      // por el redondeo, que la cifra tiene que acabar clavada en el dato real.
      setValor(p >= 1 ? objetivo : Math.round(inicio + delta * easeOutExpo(p)));
      rafRef.current = p < 1 ? requestAnimationFrame(paso) : null;
    };
    rafRef.current = requestAnimationFrame(paso);

    return cancelar;
  }, [activo, delta, objetivo, duracion, cancelar]);

  return { valor, saltar };
}

/**
 * Una cifra que cuenta hasta su valor por una de dos razones: viene de registrar
 * el movimiento que la afecta (sube desde el valor anterior) o es la primera
 * carga de la sesión (sube desde 0, como bienvenida). Fuera de esos casos es un
 * número normal: pinta `objetivo` y ya está.
 *
 * Renderiza un `<span>` para poder recibir el clic que salta al final; hereda la
 * tipografía (incluida `tabular-nums`) del elemento que la contiene, así que va
 * dentro del héroe `cifra` o del bloque de Ingresos sin repetirles las clases.
 */
export function CifraContada({
  objetivo,
  campo,
  className,
}: {
  objetivo: number;
  campo: Campo;
  className?: string;
}) {
  const { registro, bienvenida } = useContext(ModoContext);
  const registroAplica = registro !== null && correspondeA(registro.tipo, campo);

  // Precedencia: el registro reciente sobre la bienvenida, nunca los dos a la
  // vez (el proveedor ya apaga la bienvenida cuando hay registro que anima).
  const activo = registroAplica || bienvenida;
  // Registro: recorre el importe del movimiento. Bienvenida: cuenta desde 0, así
  // que el delta es el valor entero (positivo o negativo, para el balance).
  const delta = registroAplica ? registro.delta : bienvenida ? objetivo : 0;
  const { valor, saltar } = useContarHasta({ objetivo, delta, activo });

  return (
    <span
      className={className}
      // Tocar (o pulsar) la cifra mientras cuenta la lleva al final. Fuera de la
      // cuenta no hace nada y no se anuncia como interactiva.
      onClick={activo ? saltar : undefined}
    >
      {valor === objetivo ? (
        formatCents(valor)
      ) : (
        /*
          Mientras cuenta, el lector de pantalla no debe oír los números de paso
          (ni quedarse con uno a medias si lee justo entonces): la cuenta va
          oculta para él y el valor final, oculto a la vista, es lo que lee. Al
          acabar se vuelve a un único texto, el de siempre.
        */
        <>
          <span aria-hidden>{formatCents(valor)}</span>
          <span className="sr-only">{formatCents(objetivo)}</span>
        </>
      )}
    </span>
  );
}
