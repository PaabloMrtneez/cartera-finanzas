"use client";

import { Check, Clipboard, Share } from "lucide-react";
import { useState, useTransition } from "react";
import { generarInvitacion, type ResultadoInvitacion } from "@/app/(app)/ajustes/invitar-actions";
import { Button } from "@/components/ui/button";
import { Grupo } from "@/components/ui/card";
import { FieldError, Input, Label } from "@/components/ui/input";
import { mensajeInvitacion, textoCaducidad } from "@/lib/invitacion";
import { llamarAccion } from "@/lib/llamar-accion";

type Enlace = Extract<ResultadoInvitacion, { ok: true }>;

/**
 * Invitar a alguien, desde el móvil. Solo lo ve quien administra Cartera (la
 * página no lo pinta si no; y la acción vuelve a comprobarlo por su cuenta).
 *
 * El enlace no se manda por correo: se comparte con la hoja del sistema
 * (WhatsApp, Mensajes…) o se copia. Abrirlo para ver la vista previa no lo
 * gasta; solo se gasta cuando la persona pulsa «Empezar».
 */
export function InvitarSettings() {
  const [email, setEmail] = useState("");
  const [enlace, setEnlace] = useState<Enlace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [pending, startTransition] = useTransition();

  function generar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await llamarAccion(() => generarInvitacion(email), "generado");
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setEnlace(r);
    });
  }

  async function compartir() {
    if (!enlace) return;
    const texto = mensajeInvitacion(enlace.tipo);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Cartera", text: texto, url: enlace.enlace });
        return;
      } catch (e) {
        // Cerrar la hoja de compartir no es un error.
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    // Sin hoja de compartir (un ordenador, casi siempre): se copia.
    await copiar();
  }

  async function copiar() {
    if (!enlace) return;
    try {
      await navigator.clipboard.writeText(enlace.enlace);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Sin permiso de portapapeles queda el `select-all` del enlace.
      setError("No se ha podido copiar. Mantén pulsado el enlace para copiarlo.");
    }
  }

  return (
    <Grupo titulo="Invitar a alguien">
      {!enlace ? (
        <form onSubmit={generar} className="flex flex-col gap-3 px-[18px] py-4">
          <p className="text-[13px] leading-[18px] text-muted">
            Crea un enlace para que alguien entre en Cartera y compártelo tú, por WhatsApp o como
            quieras. No se manda ningún correo.
          </p>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="invitar-email">Su correo</Label>
            <Input
              id="invitar-email"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nombre@correo.com"
            />
          </div>
          <FieldError>{error}</FieldError>
          <Button type="submit" disabled={pending || email.trim() === ""}>
            {pending ? "Creando…" : "Crear enlace"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3 px-[18px] py-4">
          <p className="text-[15px] leading-5">
            <span className="font-semibold">Enlace para {enlace.email}</span>
            <span className="text-muted">
              {enlace.tipo === "invite"
                ? " · cuenta nueva."
                : " · ya tenía cuenta: le servirá para elegir una contraseña nueva."}
            </span>
          </p>

          <code className="rounded-md bg-surface-2 px-3 py-2 font-mono text-[13px] leading-[18px] break-all select-all">
            {enlace.enlace}
          </code>

          <div className="flex flex-col gap-2 lg:flex-row">
            <Button onClick={compartir} className="lg:flex-1">
              <Share size={18} aria-hidden />
              Compartir
            </Button>
            <Button variant="secondary" onClick={copiar} className="lg:flex-1">
              {copiado ? <Check size={18} aria-hidden /> : <Clipboard size={18} aria-hidden />}
              {copiado ? "Copiado" : "Copiar"}
            </Button>
          </div>

          <FieldError>{error}</FieldError>

          <p className="text-[13px] leading-[18px] text-muted">
            Caduca en {textoCaducidad(enlace.horas)} y solo vale una vez. Que lo abra en su móvil:
            le guiará para elegir contraseña y activar Face ID. Si caduca, crea otro.
          </p>

          <Button
            variant="ghost"
            size="compact"
            onClick={() => {
              setEnlace(null);
              setEmail("");
              setError(null);
            }}
          >
            Invitar a otra persona
          </Button>
        </div>
      )}
    </Grupo>
  );
}
