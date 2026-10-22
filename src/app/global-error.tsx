"use client";

import { useEffect } from "react";
import { THEME_COLOR } from "@/lib/theme";

/**
 * La red de último recurso: un fallo del propio layout raíz.
 *
 * `global-error` SUSTITUYE al layout raíz entero, así que tiene que traer su
 * propio `<html>` y `<body>`, y no puede contar con los tokens de `globals.css`
 * ni con el tema: los estilos van en línea. Es sobria a propósito —el fondo
 * espacio de Aurora, su texto y el botón negro con canto Aurora—: es la pantalla que
 * se ve cuando ha fallado hasta el armazón, y lo único que importa es que sea
 * legible y ofrezca salir del paso. Va en OSCURO, el tema por defecto: si no hay
 * manera de saber cuál eligió la persona, el de la identidad.
 *
 * Los valores son los de `[data-theme="dark"]` en `globals.css` (`--bg`, `--fg`,
 * `--muted`) y los del botón de calidad (`--btn-negro*`, `--grad-aurora`, ver la
 * utilidad `boton-aurora`); si cambian allí, cambian aquí.
 *
 * En este Next el prop es `retry`, no `reset`.
 */
const OSCURO = {
  fondo: THEME_COLOR.dark,
  texto: "#ecf1fb",
  apagado: "#9fa8c0",
  /* El botón de calidad, con la técnica de `boton-aurora`: el cuerpo negro
     recortado a la caja de relleno y el espectro a la del borde, que es
     transparente y de 1 px. */
  boton:
    "linear-gradient(180deg, #0d1018, #05060b) padding-box, " +
    "linear-gradient(90deg, #8b7bf0 0%, #48d4d0 52%, #e6c06a 100%) border-box",
  tintaBoton: "#f3f6fc",
};

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Error global (layout raíz):", error.digest, error);
  }, [error]);

  return (
    <html lang="es" style={{ colorScheme: "dark" }}>
      <head>
        <title>Algo ha fallado · Cartera</title>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: OSCURO.fondo,
          color: OSCURO.texto,
          fontFamily: "-apple-system, 'Segoe UI', system-ui, sans-serif",
        }}
      >
        <main style={{ maxWidth: "22rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "22px", lineHeight: "28px", fontWeight: 600, margin: "0 0 8px" }}>
            Algo ha fallado
          </h1>
          <p style={{ fontSize: "15px", lineHeight: "20px", color: OSCURO.apagado, margin: "0 0 20px" }}>
            La app no ha podido arrancar. Tus datos están a salvo. Prueba a reintentar; si sigue,
            vuelve a entrar.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              height: "50px",
              padding: "0 24px",
              borderRadius: "14px",
              border: "1px solid transparent",
              background: OSCURO.boton,
              boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.07)",
              color: OSCURO.tintaBoton,
              fontSize: "17px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reintentar
          </button>
        </main>
      </body>
    </html>
  );
}
