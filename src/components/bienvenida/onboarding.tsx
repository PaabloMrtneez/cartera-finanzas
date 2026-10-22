"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { terminarArranque } from "@/app/bienvenida/actions";
import { BrandMark } from "@/components/brand-mark";
import { BotonSigno, alternarSigno } from "@/components/ui/boton-signo";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Icon } from "@/components/ui/icon";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { CATEGORIAS_SUGERIDAS } from "@/lib/onboarding";
import { ACCOUNT_TYPES_ELEGIBLES, ACCOUNT_TYPE_LABELS, type AccountType } from "@/lib/types";
import { llamarAccion } from "@/lib/llamar-accion";

/**
 * El primer arranque, en tres pasos.
 *
 * Solo se ve una vez, y no por una marca guardada sino porque se muestra
 * mientras no haya ninguna cuenta. Una marca puede quedarse desincronizada de
 * los datos; «no tienes cuentas» no puede: es la propia condición que hay que
 * resolver.
 *
 * La cuenta se crea al final, en el paso 3, y no al salir del paso 2. Así
 * cerrar la pestaña por el camino no deja a nadie con media cuenta creada y el
 * arranque ya consumido.
 */
export function Onboarding() {
  const router = useRouter();
  const [paso, setPaso] = useState(1);
  const [tipo, setTipo] = useState<AccountType>("BANCO");
  const [color, setColor] = useState("#1f7fa8");
  const [nombre, setNombre] = useState("");
  const [saldo, setSaldo] = useState("");
  const [tarjeta, setTarjeta] = useState("");
  const [elegidas, setElegidas] = useState<string[]>(CATEGORIAS_SUGERIDAS.map((c) => c.clave));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /*
   * Al cambiar de paso, el botón pulsado desaparece con su paso y el foco caía
   * al <body>: el lector de pantalla no decía nada del paso nuevo. Se lleva el
   * foco a su título (no en el primer pintado: ahí manda la página).
   */
  const titulo = useRef<HTMLHeadingElement>(null);
  const primerPintado = useRef(true);
  useEffect(() => {
    if (primerPintado.current) {
      primerPintado.current = false;
      return;
    }
    titulo.current?.focus({ preventScroll: true });
  }, [paso]);

  function alternar(clave: string) {
    setElegidas((previas) =>
      previas.includes(clave) ? previas.filter((c) => c !== clave) : [...previas, clave],
    );
  }

  function terminar(conCategorias: boolean) {
    setError(null);
    const formData = new FormData();
    formData.set("name", nombre);
    formData.set("type", tipo);
    formData.set("initial_balance_cents", saldo);
    formData.set("color", color);
    formData.set("card_last4", tarjeta);

    startTransition(async () => {
      const result = await llamarAccion(() => terminarArranque(formData, conCategorias ? elegidas : []));
      if (!result.ok) {
        setError(result.error);
        // El fallo casi siempre es del nombre o del saldo: se vuelve al paso
        // donde se pueden arreglar, en lugar de dejar un error sin remedio.
        setPaso(2);
        return;
      }
      router.replace("/resumen");
    });
  }

  return (
    <main
      className={cn(
        "mx-auto flex min-h-dvh w-full max-w-[520px] flex-col px-5",
        // Pantalla completa en la app instalada: arriba, la isla del iPhone;
        // abajo, el indicador de inicio bajo los botones.
        "pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]",
      )}
    >
      <p className="sr-only" aria-live="polite">
        Paso {paso} de 3
      </p>
      {/* Tres puntos, para saber cuánto queda. */}
      <div className="flex justify-center gap-2" aria-hidden>
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={cn(
              "h-[6px] rounded-full",
              n === paso ? "w-6 bg-accent" : "w-[6px] bg-hairline",
            )}
          />
        ))}
      </div>

      {paso === 1 ? (
        <div className="flex flex-1 animate-rise flex-col justify-center gap-6 py-10">
          <span className="relative flex w-fit items-center justify-center">
            {/* El halo iridiscente del espectro Aurora tras el monograma: el
                mismo recibimiento que la puerta de acceso. */}
            <span
              aria-hidden
              className="pointer-events-none absolute size-[104px] rounded-full opacity-40 blur-2xl"
              style={{ background: "var(--grad-aurora)" }}
            />
            <BrandMark size={64} className="relative" />
          </span>
          <div className="flex flex-col gap-3">
            <h1
              ref={titulo}
              tabIndex={-1}
              className="text-[32px] leading-[38px] font-semibold tracking-[-0.03em] outline-none"
            >
              Tus cuentas, sin que las vea nadie más
            </h1>
            <p className="text-[17px] leading-6 text-muted">
              Cartera empieza vacía a propósito: no hay categorías de ejemplo ni cifras inventadas
              que luego haya que borrar. Lo que veas será tuyo desde el primer día.
            </p>
            <p className="text-[15px] leading-5 text-muted">
              Los saldos no se guardan en ningún sitio: se calculan cada vez a partir de tus
              movimientos. Por eso no pueden descuadrarse.
            </p>
          </div>
          <Button onClick={() => setPaso(2)} block>
            Empezar
          </Button>
        </div>
      ) : null}

      {paso === 2 ? (
        <form
          className="flex flex-1 flex-col gap-4 py-8"
          onSubmit={(event) => {
            event.preventDefault();
            setPaso(3);
          }}
        >
          <div className="flex flex-col gap-2">
            <h1
              ref={titulo}
              tabIndex={-1}
              className="text-[28px] leading-[34px] font-semibold tracking-[-0.03em] outline-none"
            >
              Tu primera cuenta
            </h1>
            <p className="text-[15px] leading-5 text-muted">
              Donde tienes el dinero. Podrás añadir las demás cuando quieras.
            </p>
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              autoComplete="off"
              required
              maxLength={60}
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Cuenta principal"
            />
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label>Tipo</Label>
            <Segmented
              label="Tipo de cuenta"
              value={tipo}
              onChange={setTipo}
              options={ACCOUNT_TYPES_ELEGIBLES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] }))}
            />
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="saldo">Cuánto hay ahora</Label>
            <div className="flex items-center gap-2">
              <BotonSigno onClick={() => setSaldo(alternarSigno)} />
              <Input
                id="saldo"
                inputMode="decimal"
                autoComplete="off"
                required
                value={saldo}
                onChange={(e) => setSaldo(e.target.value)}
                placeholder="0,00"
                className="text-right tabular-nums"
              />
            </div>
            <p className="text-[13px] leading-[18px] text-muted">
              Puede ser negativo: una tarjeta de crédito arranca en deuda. Coma para los decimales.
            </p>
          </div>

          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="tarjeta">Últimos 4 dígitos</Label>
            <Input
              id="tarjeta"
              inputMode="numeric"
              // Que iOS no proponga la tarjeta guardada entera: aquí van 4 cifras.
              autoComplete="off"
              pattern="[0-9]{4}"
              maxLength={4}
              value={tarjeta}
              onChange={(e) => setTarjeta(e.target.value)}
              placeholder="Opcional"
              className="tabular-nums"
            />
            <p className="text-[13px] leading-[18px] text-muted">
              Si pagas con Apple Pay, esto es lo que permite que el cargo entre solo en esta cuenta.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Color</Label>
            <ColorPicker name="color" value={color} onChange={setColor} />
          </div>

          <FieldError>{error}</FieldError>

          <div className="mt-auto flex flex-col gap-2 pt-4">
            <Button type="submit" block>
              Continuar
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPaso(1)} block>
              Atrás
            </Button>
          </div>
        </form>
      ) : null}

      {paso === 3 ? (
        <div className="flex flex-1 flex-col gap-4 py-8">
          <div className="flex flex-col gap-2">
            <h1
              ref={titulo}
              tabIndex={-1}
              className="text-[28px] leading-[34px] font-semibold tracking-[-0.03em] outline-none"
            >
              ¿Empezamos con estas categorías?
            </h1>
            <p className="text-[15px] leading-5 text-muted">
              Quita las que no uses y añade las tuyas después. Un gasto sin clasificar no cuenta
              para ningún límite ni aparece en el reparto, así que conviene tener unas cuantas.
            </p>
          </div>

          <ul className="flex flex-col overflow-hidden rounded-md bg-surface">
            {CATEGORIAS_SUGERIDAS.map((c) => {
              const marcada = elegidas.includes(c.clave);
              return (
                <li key={c.clave}>
                  <button
                    type="button"
                    onClick={() => alternar(c.clave)}
                    aria-pressed={marcada}
                    className="flex min-h-[52px] w-full items-center gap-3 hair-t border-separator px-4 py-2 text-left"
                  >
                    <span
                      className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-white"
                      style={{ background: c.color }}
                    >
                      <Icon name={c.icon} size={16} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[15px] font-semibold">{c.name}</span>
                      {c.type === "INCOME" ? (
                        <span className="text-[13px] leading-[18px] text-muted">Ingreso</span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "flex size-[22px] shrink-0 items-center justify-center rounded-full",
                        marcada ? "bg-accent text-accent-ink" : "bg-surface-2 text-transparent",
                      )}
                    >
                      <Icon name="check" size={14} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <FieldError>{error}</FieldError>

          <div className="mt-auto flex flex-col gap-2 pt-4">
            <Button onClick={() => terminar(true)} disabled={pending || elegidas.length === 0} block>
              {pending
                ? "Creando…"
                : elegidas.length === CATEGORIAS_SUGERIDAS.length
                  ? "Crear todas y entrar"
                  : `Crear ${elegidas.length} y entrar`}
            </Button>
            <Button variant="ghost" onClick={() => terminar(false)} disabled={pending} block>
              Prefiero crearlas yo
            </Button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
