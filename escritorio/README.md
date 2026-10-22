# Cartera para Windows

Una ventana propia que abre la app publicada (`https://tu-dominio.vercel.app`).
No es una copia de la app: lo que se publica en la web aparece aquí al instante,
y el ejecutable no lleva ningún secreto. Las claves viven en el servidor, como
siempre (regla 8 de `AGENTS.md`).

## Instalarla

1. En GitHub, **Releases** → la última «Cartera para Windows» → descarga
   `Cartera-Setup-X.Y.Z.exe`.
2. Ábrelo. Como el instalador no va firmado, Windows dirá que el editor es
   desconocido: **Más información → Ejecutar de todas formas**.
3. Se instala para tu usuario (no pide administrador) y deja un acceso directo
   en el escritorio y en el menú Inicio.

La sesión se queda guardada (cookies cifradas con tu cuenta de Windows): no hay
que entrar cada vez.

## Qué hace la ventana

- Solo navega dentro de Cartera. Cualquier enlace a otro sitio se abre en tu
  navegador.
- La página no tiene acceso a Node ni al sistema (aislamiento de contexto,
  sandbox, sin integración de Node).
- Ningún permiso salvo los avisos: ni cámara, ni micrófono, ni ubicación.
- Una sola ventana: abrir Cartera otra vez trae al frente la que ya está.
- Recuerda tamaño y posición. Sin conexión enseña su propia pantalla y vuelve
  sola cuando hay red. Después de la primera visita, el service worker de la PWA
  también sirve la pantalla sin conexión de la web.
- Fusibles de Electron: no se puede usar como Node (`ELECTRON_RUN_AS_NODE`), ni
  con `NODE_OPTIONS`, ni con `--inspect`, y solo carga su propio `app.asar`
  (con comprobación de integridad).
- `Alt` enseña el menú: recargar, zoom y pantalla completa.

## Desarrollo

```bash
cd escritorio
npm install
npm start        # abre producción
npm run local    # abre http://localhost:3000 (con `npm run dev` en la raíz)
```

`--local` solo funciona sin empaquetar: el ejecutable que se reparte abre
siempre producción.

## Publicar una versión

El instalador lo compila GitHub Actions (`.github/workflows/escritorio.yml`),
no el ordenador de trabajo: allí electron-builder no puede lanzar su 7-Zip
(`AssignProcessToJobObject`) y sin él no hay instalador NSIS.

1. Sube `version` en `escritorio/package.json`.
2. Actions → **Escritorio (Windows)** → **Run workflow** (o sube una etiqueta
   `escritorio-vX.Y.Z`).
3. Sale una Release `escritorio-vX.Y.Z` con el instalador y su SHA-256.

Solo hace falta otra versión si cambia la ventana (`main.js`,
`sin-conexion.html`) o Electron. Los cambios de la app llegan solos.

Si cambia el dominio de producción, se cambia `PRODUCCION` en `main.js` y se
publica otra versión.
