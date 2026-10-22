import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Inter, Space_Grotesk } from "next/font/google";
import { ServiceWorker } from "@/components/service-worker";
import { ThemeScript } from "@/components/theme-script";
import { THEME_COLOR } from "@/lib/theme";
import "./globals.css";

/*
 * Las fuentes de Aurora, autoalojadas por next/font: se descargan en tiempo de
 * build y se sirven desde el propio dominio, sin ninguna petición a Google desde
 * el navegador (lo que respeta la CSP `font-src 'self'` y la privacidad). Cada
 * una expone su variable CSS, que `globals.css` referencia en `--font-sans` y
 * `--font-cifra`. Son fuentes variables: no hay que enumerar pesos.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  // Cada pantalla pone su nombre delante («Movimientos · Cartera»): es lo que
  // lee el lector de pantalla al llegar y lo que distingue las entradas del
  // historial. Antes todas se llamaban «Cartera».
  title: { default: "Cartera", template: "%s · Cartera" },
  description: "Tus finanzas personales, privadas y en un solo sitio.",
  applicationName: "Cartera",
  appleWebApp: {
    capable: true,
    title: "Cartera",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icono-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icono-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  other: {
    /*
     * Next emite `mobile-web-app-capable`, que es el nombre estandarizado y el
     * que respeta iOS moderno. Se añade también el prefijado de Apple porque las
     * versiones anteriores solo entienden ese, y cuesta una línea.
     */
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // La app se ancla a los bordes: la barra de pestañas necesita el área segura.
  viewportFit: "cover",
  // Por el sistema mientras no hay script; `ThemeScript` las repinta al instante
  // con el tema que de verdad se ve (por defecto, oscuro).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // El nonce de la CSP lo genera el proxy por petición y viaja en `x-nonce`.
  // Leerlo aquí obliga al renderizado dinámico, que en una app privada de cuatro
  // usuarios tras 2FA no cuesta nada: no hay nada cacheable de forma estática.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="es"
      suppressHydrationWarning
      className={`h-full ${inter.variable} ${spaceGrotesk.variable}`}
    >
      <head>
        <ThemeScript nonce={nonce} />
      </head>
      <body className="flex min-h-full flex-col">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
