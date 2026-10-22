/**
 * Cartera para Windows.
 *
 * Es una VENTANA, no una copia de la app: abre la web publicada en Vercel y
 * nada más. Así no hay dos versiones que mantener (lo que se publica en la web
 * aparece aquí al instante) y, sobre todo, ningún secreto viaja dentro del
 * ejecutable: la clave de servicio y el resto viven en el servidor, como
 * siempre (regla 8 de AGENTS.md). Meter el servidor de Next aquí dentro
 * obligaría a repartir esas claves en el ordenador de cada persona.
 *
 * Lo que sí hace la ventana, y por qué:
 *  · Solo navega dentro de Cartera. Un enlace a otro sitio se abre en el
 *    navegador de verdad, que es donde cada uno tiene sus defensas; nada ajeno
 *    se carga con la sesión de Cartera dentro.
 *  · La página no toca Node ni el sistema (aislamiento de contexto, sin
 *    integración de Node y en sandbox). Si alguna vez se colara un script, se
 *    quedaría dentro de la web, igual que en un navegador.
 *  · Ningún permiso salvo los avisos: ni cámara, ni micrófono, ni ubicación.
 *  · Una sola ventana: abrir Cartera otra vez trae al frente la que ya está.
 *  · Recuerda tamaño y posición, y sin conexión enseña una pantalla propia que
 *    reintenta sola al volver la red.
 *
 * La sesión se guarda en el perfil de la app (cookies cifradas con la cuenta de
 * Windows: fusible `enableCookieEncryption` en package.json), así que no hay que
 * entrar cada vez que se abre.
 */
import { app, BrowserWindow, Menu, screen, session, shell } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** La dirección de producción. Si cambia el dominio, se cambia aquí y se recompila. */
const PRODUCCION = "https://tu-dominio.vercel.app";

/**
 * `npm run local` apunta al servidor de desarrollo. Solo sin empaquetar: el
 * ejecutable que se reparte abre SIEMPRE producción, diga lo que diga la línea
 * de órdenes.
 */
const DIRECCION =
  !app.isPackaged && process.argv.includes("--local") ? "http://localhost:3000" : PRODUCCION;
const ORIGEN = new URL(DIRECCION).origin;

/** El fondo oscuro de Aurora (`--bg` del tema oscuro): sin destello blanco al abrir. */
const FONDO = "#02040a";

/** La pantalla de sin conexión: un fichero del propio ejecutable. */
const SIN_CONEXION = join(import.meta.dirname, "sin-conexion.html");
const URL_SIN_CONEXION = pathToFileURL(SIN_CONEXION).href;

/** Los únicos permisos que se conceden, y solo a Cartera. */
const PERMISOS = new Set(["notifications", "clipboard-sanitized-write", "fullscreen"]);

const esDeCartera = (url) => {
  try {
    return new URL(url).origin === ORIGEN;
  } catch {
    return false;
  }
};

/** Un enlace de fuera, al navegador. Solo https: nada de file:, ms-settings: ni similares. */
function abrirFuera(url) {
  try {
    if (new URL(url).protocol === "https:") void shell.openExternal(url);
  } catch {
    // Dirección rota: se ignora.
  }
}

// ── Tamaño y posición de la ventana ─────────────────────────────────────────

const FICHERO_VENTANA = join(app.getPath("userData"), "ventana.json");

function leerVentana() {
  try {
    const v = JSON.parse(readFileSync(FICHERO_VENTANA, "utf8"));
    // Si la pantalla donde estaba ya no existe (se desenchufó el monitor), se
    // olvida la posición y se centra: si no, la ventana abriría fuera de la vista.
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      v.x >= a.x && v.y >= a.y && v.x < a.x + a.width && v.y < a.y + a.height,
    );
    return visible ? v : { width: v.width, height: v.height, maximizada: v.maximizada };
  } catch {
    return {};
  }
}

function guardarVentana(ventana) {
  try {
    const { x, y, width, height } = ventana.getNormalBounds();
    writeFileSync(FICHERO_VENTANA, JSON.stringify({ x, y, width, height, maximizada: ventana.isMaximized() }));
  } catch {
    // No poder recordar el tamaño no es motivo para fallar al cerrar.
  }
}

// ── La ventana ──────────────────────────────────────────────────────────────

let ventana = null;

function crearVentana() {
  const previa = leerVentana();
  ventana = new BrowserWindow({
    width: previa.width ?? 1280,
    height: previa.height ?? 860,
    x: previa.x,
    y: previa.y,
    minWidth: 380,
    minHeight: 600,
    show: false,
    backgroundColor: FONDO,
    title: "Cartera",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  });
  if (previa.maximizada) ventana.maximize();
  ventana.setMenuBarVisibility(false);

  ventana.once("ready-to-show", () => ventana.show());
  ventana.on("close", () => guardarVentana(ventana));
  ventana.on("closed", () => {
    ventana = null;
  });

  const contenido = ventana.webContents;

  // Sin conexión la primera vez (el service worker aún no tiene nada guardado),
  // o Vercel caído: la pantalla propia, que vuelve a intentarlo sola.
  contenido.on("did-fail-load", (_e, codigo, _desc, url, esPrincipal) => {
    // -3 es «abortada»: pasa al navegar de una página a otra, no es un fallo.
    if (!esPrincipal || codigo === -3) return;
    void ventana.loadFile(SIN_CONEXION, {
      query: { volver: esDeCartera(url) ? url : DIRECCION },
    });
  });

  // Si la página se cuelga o la mata el sistema, se recarga en vez de dejar un
  // rectángulo vacío.
  contenido.on("render-process-gone", (_e, detalle) => {
    if (detalle.reason !== "clean-exit") contenido.reload();
  });

  void ventana.loadURL(DIRECCION);
}

// ── Reglas para todo lo que se cargue ───────────────────────────────────────

app.on("web-contents-created", (_e, contenido) => {
  // Navegar: solo dentro de Cartera y a la pantalla de sin conexión (ese
  // fichero exacto, no cualquier file:). Lo demás, al navegador.
  const vigilar = (evento, url) => {
    if (esDeCartera(url) || url.split(/[?#]/)[0] === URL_SIN_CONEXION) return;
    evento.preventDefault();
    abrirFuera(url);
  };
  contenido.on("will-navigate", vigilar);
  contenido.on("will-redirect", vigilar);

  // Ventanas nuevas: nunca. Lo de Cartera se abre en la misma ventana; lo de
  // fuera, en el navegador.
  contenido.setWindowOpenHandler(({ url }) => {
    if (esDeCartera(url)) void contenido.loadURL(url);
    else abrirFuera(url);
    return { action: "deny" };
  });

  // Ni <webview> ni nada que incruste otro navegador dentro.
  contenido.on("will-attach-webview", (evento) => evento.preventDefault());
});

function configurarSesion() {
  const s = session.defaultSession;
  const permitido = (contenido, permiso, origen) =>
    PERMISOS.has(permiso) && esDeCartera(origen ?? contenido?.getURL() ?? "");

  s.setPermissionRequestHandler((contenido, permiso, responder, detalles) => {
    responder(permitido(contenido, permiso, detalles?.requestingUrl));
  });
  s.setPermissionCheckHandler((contenido, permiso, origen) => permitido(contenido, permiso, origen));
}

/**
 * El menú, oculto (Alt lo enseña). Hace falta aunque no se vea: sin él no
 * funcionarían Ctrl+R, el zoom ni deshacer y pegar con el teclado. Las
 * herramientas de desarrollo, solo sin empaquetar.
 */
function configurarMenu() {
  const ver = [
    { role: "reload", label: "Recargar" },
    { type: "separator" },
    { role: "resetZoom", label: "Tamaño real" },
    { role: "zoomIn", label: "Ampliar" },
    { role: "zoomOut", label: "Reducir" },
    { type: "separator" },
    { role: "togglefullscreen", label: "Pantalla completa" },
  ];
  if (!app.isPackaged) ver.push({ role: "toggleDevTools", label: "Herramientas de desarrollo" });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Cartera", submenu: [{ role: "quit", label: "Salir" }] },
      {
        label: "Editar",
        submenu: [
          { role: "undo", label: "Deshacer" },
          { role: "redo", label: "Rehacer" },
          { type: "separator" },
          { role: "cut", label: "Cortar" },
          { role: "copy", label: "Copiar" },
          { role: "paste", label: "Pegar" },
          { role: "selectAll", label: "Seleccionar todo" },
        ],
      },
      { label: "Ver", submenu: ver },
    ]),
  );
}

// ── Arranque ────────────────────────────────────────────────────────────────

// Una sola Cartera abierta: la segunda vez se trae al frente la que ya hay.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!ventana) return;
    if (ventana.isMinimized()) ventana.restore();
    ventana.focus();
  });

  // Para que Windows agrupe la ventana y los avisos bajo el icono de Cartera.
  app.setAppUserModelId("es.cartera.escritorio");

  app.whenReady().then(() => {
    configurarSesion();
    configurarMenu();
    crearVentana();
  });

  app.on("window-all-closed", () => app.quit());
}
