import { Input, Label } from "@/components/ui/input";

/**
 * El campo del código de 6 dígitos, igual en todas las pantallas que lo piden.
 *
 * `one-time-code` deja que el teclado del iPhone ofrezca el código del llavero
 * (la app Contraseñas) sin salir de la página. La etiqueta es fija: las pruebas
 * de extremo a extremo la buscan por su texto exacto.
 */
export function CampoCodigo({ autoFocus = false }: { autoFocus?: boolean }) {
  return (
    <div className="flex flex-col gap-[6px]">
      <Label htmlFor="code">Código de 6 dígitos</Label>
      <Input
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        spellCheck={false}
        pattern="[0-9\s]{6,8}"
        maxLength={8}
        required
        autoFocus={autoFocus}
        placeholder="123456"
        className="font-cifra h-14 text-center text-[26px] tracking-[0.3em] tabular-nums lg:h-14 lg:text-[26px]"
      />
    </div>
  );
}

/** Lee el código del formulario sin espacios (el llavero lo pega «123 456»). */
export function leerCodigo(form: HTMLFormElement): string {
  return String(new FormData(form).get("code") ?? "").replace(/\s/g, "");
}
