import { BackLink } from "@/components/app/back-link";
import { cn } from "@/lib/cn";

/**
 * Cabecera de sección. En móvil es una barra de cristal pegada arriba con el
 * título grande; en escritorio, la barra superior de 56 px con el título
 * pequeño y las acciones a la derecha.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header
      className={cn(
        "glass sticky top-0 z-20 hair-b border-hairline",
        "px-4 pt-[env(safe-area-inset-top)] lg:px-10",
      )}
    >
      <div className="flex min-h-14 items-center gap-3 py-2">
        {/* Solo en móvil y solo en secundarias; en pestañas principales no pinta. */}
        <BackLink />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-[22px] leading-7 font-semibold tracking-[-0.01em] lg:text-[15px] lg:leading-5">
            {title}
          </h1>
          {subtitle ? (
            <p className="truncate text-[13px] leading-[18px] text-muted">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/**
 * Contenedor del cuerpo de una sección.
 *
 * El tope era de 1024 px, y eso convertía el escritorio en el móvil ensanchado:
 * una sola columna estrecha centrada, con 200 px de aire muerto a cada lado en
 * un monitor normal y las gráficas aplastadas en un buzón. A 1400 px caben dos
 * columnas de verdad, que es de donde sale todo lo demás.
 *
 * Las pantallas que son un formulario o una lista de ajustes siguen pisando
 * este valor con el suyo: un campo de texto de 1400 px no se lee mejor.
 */
export function PageBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4",
        "lg:max-w-[1400px] lg:gap-6 lg:px-10 lg:py-7",
        className,
      )}
      {...props}
    />
  );
}
