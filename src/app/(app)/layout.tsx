import { redirect } from "next/navigation";
import { AjusteCifras } from "@/components/app/ajuste-cifras";
import { BottomNav } from "@/components/app/bottom-nav";
import { PageTransition } from "@/components/app/page-transition";
import { CommandSearch } from "@/components/app/command-search";
import { Sidebar } from "@/components/app/sidebar";
import { contarCuentas, contarPendientes } from "@/lib/supabase/consultas-compartidas";

/**
 * Armazón de la app ya autenticada. El proxy garantiza que aquí no se llega
 * sin haber superado el segundo factor, si la cuenta lo tiene (es opcional).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Los pendientes del Atajo que ninguna regla supo clasificar. Se muestran como
  // aviso en Movimientos, tanto en la barra inferior como en la lateral.
  // Memorizadas por petición (`consultas-compartidas.ts`): Resumen y Ajustes
  // piden lo mismo y lo reutilizan en vez de repetir la consulta.
  const [pendingCount, cuentas] = await Promise.all([contarPendientes(), contarCuentas()]);

  // Sin ninguna cuenta no hay nada que enseñar: ni saldo, ni movimientos, ni
  // dónde apuntar un gasto. Se pasa por el primer arranque, que vive fuera de
  // este armazón y por eso no puede entrar en bucle consigo mismo.
  if (cuentas === 0) redirect("/bienvenida");

  return (
    <div className="flex min-h-dvh">
      {/*
        «Saltar al contenido»: invisible hasta que se le da con el tabulador. En
        escritorio la barra lateral son trece paradas antes de llegar a la
        pantalla; con esto, una.
      */}
      <a
        href="#contenido"
        className={[
          "sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60]",
          "focus:rounded-md focus:bg-accent focus:px-4 focus:py-3 focus:text-[15px]",
          "focus:font-semibold focus:text-accent-ink focus:shadow-overlay",
        ].join(" ")}
      >
        Saltar al contenido
      </a>
      <Sidebar pendingCount={pendingCount} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          La transición al cambiar de pantalla, con la gramática de iOS: cambio
          de pestaña SECO (es lo que más se toca al día), push/pop lateral al
          bajar o subir un nivel y hoja que sube para «Nuevo movimiento». Solo
          en móvil; en escritorio todo es la barra lateral, secciones hermanas,
          y no anima. Ver `PageTransition` y `src/lib/transicion.ts`.

          Solo anima el CONTENIDO. La barra lateral y la de pestañas se quedan
          quietas, y eso es lo que hace que el cambio se lea como «otra
          pantalla dentro de la misma app» y no como «otra página».
        */}
        <PageTransition>
          {/*
            La región principal de contenido, marcada como landmark `main`: es lo
            que da a los lectores de pantalla un «saltar al contenido» y lo que
            distingue el cuerpo de la pantalla de la navegación que lo rodea.
            El hueco de abajo deja sitio a la barra de pestañas de móvil.
          */}
          <main
            id="contenido"
            className="flex-1 pb-[calc(52px+env(safe-area-inset-bottom))] lg:pb-0"
          >
            {children}
          </main>
        </PageTransition>
      </div>

      <BottomNav pendingCount={pendingCount} />

      {/* Se abre con ⌘K o Ctrl+K desde cualquier pantalla. */}
      <CommandSearch />

      {/* Encoge la cifra héroe que no cabe (importes de siete u ocho cifras). */}
      <AjusteCifras />
    </div>
  );
}
