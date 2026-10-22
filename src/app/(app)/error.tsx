"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { PageBody, PageHeader } from "@/components/app/page-header";

/**
 * La red cuando una pantalla autenticada revienta.
 *
 * Antes no había ninguna: si una consulta a Supabase fallaba —la base
 * inalcanzable, un timeout, un error de una función— el usuario se quedaba ante
 * una pantalla rota sin saber qué hacer. Ahora ve un mensaje sereno y un botón
 * para reintentar, dentro del armazón de la app (la barra sigue ahí, no está
 * perdido).
 *
 * OJO: en este Next el prop es `retry`, no `reset` como en el Next estándar.
 * `retry()` vuelve a pedir y a pintar el segmento; si el fallo era pasajero
 * —un pico de red—, con eso se arregla sin recargar toda la app.
 *
 * Solo cubre lo que cuelga del layout de (app). Un fallo del propio layout sube
 * a `global-error`, que es la red de último recurso.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Al menos queda rastro en la consola del navegador y en los logs del
    // servidor. El `digest` es el identificador con el que Vercel agrupa el
    // error en sus registros: es lo que se busca para dar con la traza real.
    console.error("Error en una pantalla de la app:", error.digest, error);
  }, [error]);

  return (
    <>
      <PageHeader title="Algo ha fallado" />
      <PageBody>
        <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-warning">
            <Icon name="triangle-alert" size={26} />
          </span>
          <h2 className="text-[17px] leading-[22px] font-semibold">
            No hemos podido cargar esta pantalla
          </h2>
          {/*
            Sin promesas que no se puedan cumplir. Antes decía «Tus datos están a
            salvo: aquí no se guarda nada», y era justo lo contrario de lo que
            pasaba cuando un guardado sin red acababa aquí (hallazgo C-1). Los
            formularios ya capturan ese fallo y no llegan a esta pantalla, pero
            si algo más revienta no sabemos qué se estaba haciendo: se dice lo
            que es verdad y qué comprobar.
          */}
          <p className="max-w-sm text-[15px] leading-5 text-muted">
            Puede ser un tropiezo pasajero de la conexión. Si estabas guardando algo, comprueba
            después de reintentar si llegó a guardarse antes de repetirlo.
          </p>
          <Button onClick={() => retry()}>Reintentar</Button>
        </Card>
      </PageBody>
    </>
  );
}
