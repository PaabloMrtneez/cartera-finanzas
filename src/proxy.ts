import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { destinoConSesion, destinoSinSesion, necesitaNivel } from "@/lib/acceso";

/**
 * Refresca la sesión y encamina según el nivel de garantía alcanzado.
 *
 * El segundo factor es opcional: sin factor se entra con la contraseña; con
 * factor, solo tras superarlo (aal2).
 *
 * Esto es comodidad, no seguridad: quien de verdad impide ver o tocar datos a
 * quien tiene factor y no lo ha superado son las políticas de la base de datos
 * (`private.segundo_factor_cumplido()`). Aquí solo se evita que alguien se
 * quede mirando pantallas vacías sin entender por qué. Las reglas de qué se
 * abre con cada nivel están en `lib/acceso.ts`.
 */

/**
 * La Content-Security-Policy, con un nonce fresco por petición.
 *
 * `script-src` con nonce y `'strict-dynamic'` (sin `'unsafe-inline'`) es lo que
 * de verdad frena un XSS: solo corre el script que lleva el nonce del momento, y
 * los que ese cargue. Next lee esta cabecera en la petición y pone el nonce él
 * solo en sus scripts; el único script en línea propio —el del tema— lo recibe
 * desde la raíz vía `x-nonce`.
 *
 * `style-src` sí lleva `'unsafe-inline'`: la app pinta con estilos en línea
 * (colores de cuenta, anchos de barra, el donut) y un nonce no cubre el atributo
 * `style=`. Una inyección de CSS es mucho menos grave que una de script.
 *
 * `connect-src` incluye el origen de Supabase porque el cliente del navegador
 * habla directamente con él; sin esto, no cargaría ni un dato. `worker-src
 * 'self'` deja registrar el service worker, que `'strict-dynamic'` sacaría del
 * juego si dependiera de `script-src`.
 */
function construirCsp(nonce: string, esDesarrollo: boolean): string {
  let supabaseConnect = "";
  try {
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    supabaseConnect = ` ${u.origin} wss://${u.host}`;
  } catch {
    // Sin URL válida (poco probable) no se añade origen: mejor eso que una
    // cabecera rota. En local a veces falta.
  }

  const directivas = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${esDesarrollo ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${supabaseConnect}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  // En local el navegador ignora HSTS y `upgrade-insecure-requests` rompería el
  // websocket de recarga en caliente (ws://), así que solo en producción.
  if (!esDesarrollo) directivas.push("upgrade-insecure-requests");

  return directivas.join("; ");
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const esDesarrollo = process.env.NODE_ENV === "development";
  const csp = construirCsp(nonce, esDesarrollo);

  // El nonce y la CSP van en la cabecera de la PETICIÓN para que Next los lea al
  // renderizar; la CSP va también en la RESPUESTA para que la aplique el navegador.
  const cabeceras = new Headers(request.headers);
  cabeceras.set("x-nonce", nonce);
  cabeceras.set("Content-Security-Policy", csp);

  let response = NextResponse.next({ request: { headers: cabeceras } });
  response.headers.set("Content-Security-Policy", csp);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          // Rehacer la cabecera desde la petición YA con las cookies nuevas, y
          // volver a colgar nonce y CSP: si no, el refresco de sesión perdería
          // el nonce y Next no lo aplicaría.
          const refrescadas = new Headers(request.headers);
          refrescadas.set("x-nonce", nonce);
          refrescadas.set("Content-Security-Policy", csp);
          response = NextResponse.next({ request: { headers: refrescadas } });
          response.headers.set("Content-Security-Policy", csp);
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const hayUsuario = await sesionValida(supabase, request);

  // La decisión vive en `lib/acceso.ts`, con sus pruebas. Sin sesión solo se
  // abren /entrar y /invitacion: el segundo factor exige el primero.
  const path = request.nextUrl.pathname;

  if (!hayUsuario) {
    const destino = destinoSinSesion(path);
    return destino ? redirect(request, destino) : response;
  }

  if (!necesitaNivel(path)) return response;

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const destino = destinoConSesion(path, aal);
  return destino ? redirect(request, destino) : response;
}

/**
 * ¿Hay una sesión válida? Con dos formas de comprobarlo según la petición.
 *
 * NAVEGACIONES, ACCIONES Y TODO LO DEMÁS: `getUser()`, que pregunta al servidor
 * de autenticación. Es lo más estricto: además de la firma, ve si la sesión se
 * ha cerrado o el usuario ya no existe. `getSession()` a secas no valida nada
 * y aquí no serviría.
 *
 * PRECARGAS (`next-router-prefetch`): `getClaims()`, que comprueba la FIRMA del
 * token en local con la clave pública del proyecto (ES256; el JWKS se pide una
 * vez y queda en memoria) y su caducidad, sin ida y vuelta a Supabase Auth. Si
 * el token ha caducado, antes lo refresca igual que `getUser()` (y las cookies
 * nuevas viajan en la respuesta). Una pantalla con su barra lateral disparaba
 * una docena de precargas, y cada una era una llamada a Auth.
 *
 * Por qué es seguro:
 *  · Una precarga solo trae el armazón hasta el `loading.tsx` (o el árbol de
 *    rutas): no la página con datos. Lo que se pinta con datos se pide de nuevo
 *    al navegar, y esa petición SÍ pasa por `getUser()`.
 *  · La barrera de los datos no es este proxy, es la RLS: cada consulta del
 *    render va a PostgREST con el mismo token, y PostgREST verifica su firma y
 *    su caducidad igual que aquí. Un token falso o caducado no ve ni una fila
 *    lo compruebe quien lo compruebe.
 *  · Lo único que se pierde en una precarga es enterarse de una sesión cerrada
 *    en otro sitio antes de que caduque su token (≤ 1 h). Es lo mismo que ya
 *    acepta PostgREST para cada consulta, y la navegación de verdad lo cazaría.
 *  · La cabecera la puede poner cualquiera, pero solo cambia CÓMO se valida (la
 *    firma se comprueba igual), no si se valida.
 * Si el proyecto volviera a una clave simétrica (HS256), `getClaims()` cae solo
 * a `getUser()`: más lento, igual de seguro.
 */
async function sesionValida(
  supabase: ReturnType<typeof createServerClient>,
  request: NextRequest,
): Promise<boolean> {
  if (request.headers.get("next-router-prefetch") === "1") {
    const { data, error } = await supabase.auth.getClaims();
    return !error && Boolean(data?.claims?.sub);
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Boolean(user);
}

function redirect(request: NextRequest, path: string) {
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    /*
     * Todo menos:
     *  · los ficheros estáticos y el manifiesto;
     *  · el service worker, que debe servirse desde la raíz sin redirecciones;
     *  · la página de cortesía sin conexión, que precisamente tiene que abrirse
     *    cuando no se puede validar ninguna sesión;
     *  · las rutas que se autentican con su propio token en lugar de con una
     *    sesión: la ingesta del Atajo, y el envío de avisos y la actualización
     *    de precios, que las pide una tarea programada. Sin sacarlas de aquí,
     *    este proxy las redirige a la pantalla de acceso y no llegan nunca a
     *    ejecutarse.
     *
     * `api/exportar` NO va en esta lista a propósito: sirve datos de una
     * persona a partir de su sesión, así que tiene que pasar por aquí.
     *
     * Cada excepción va ANCLADA: la ruta entera, no un prefijo. Y las imágenes,
     * solo en la raíz, que es donde las sirve `public/`. Antes bastaba con que
     * la ruta acabara en `.png` para saltarse el proxy, y `/movimientos/x.png`
     * —la ruta dinámica con un id raro— montaba la app sin CSP y sin pasar por
     * el encaminamiento de acceso. Lo fija `src/proxy.test.ts`.
     */
    "/((?!_next/static/|_next/image$|favicon\\.ico$|manifest\\.webmanifest$|sw\\.js$|sin-conexion$|api/ingest$|api/notificar$|api/precios$|[^/]+\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
