/**
 * JS de primera carga por ruta, a partir de un build ya hecho (`.next`).
 *
 *   node scripts/peso-rutas.mjs [.next]
 *
 * Next 16 ya no imprime el «First Load JS» al compilar. Esto lo reconstruye:
 * para cada página suma los ficheros de arranque (`rootMainFiles` del
 * build-manifest) y los `entryJSFiles` de la página y de sus layouts según su
 * `page_client-reference-manifest.js`, sin duplicar, y da el tamaño en bruto y
 * comprimido con gzip y brotli. Además lista los chunks más pesados y qué
 * módulos de `src/` los usan (los `async` son los que se cargan bajo demanda).
 *
 * Nota para worktrees: `next build` no encuentra `next` porque Turbopack no
 * resuelve fuera de su raíz. Se compila poniendo, solo para el build y sin
 * commitear, `turbopack: { root: <repo padre> }` en next.config.ts.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

const NEXT = process.argv[2] ?? ".next";
const build = JSON.parse(readFileSync(path.join(NEXT, "build-manifest.json"), "utf8"));
const raiz = [...build.polyfillFiles, ...build.rootMainFiles];

const cacheTam = new Map();
function tam(rel) {
  if (cacheTam.has(rel)) return cacheTam.get(rel);
  const f = path.join(NEXT, rel.replace(/^\/_next\//, ""));
  if (!existsSync(f)) return { bruto: 0, gzip: 0, br: 0 };
  const b = readFileSync(f);
  const r = { bruto: b.length, gzip: zlib.gzipSync(b, { level: 9 }).length, br: zlib.brotliCompressSync(b).length };
  cacheTam.set(rel, r);
  return r;
}

function* manifiestos(dir) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) yield* manifiestos(p);
    else if (n === "page_client-reference-manifest.js") yield p;
  }
}

const filas = [];
const usoChunk = new Map();
for (const f of manifiestos(path.join(NEXT, "server", "app"))) {
  const ctx = { globalThis: {} };
  ctx.globalThis = ctx;
  vm.runInNewContext(readFileSync(f, "utf8"), ctx);
  const [ruta, m] = Object.entries(ctx.__RSC_MANIFEST)[0];
  const ficheros = new Set(raiz);
  for (const lista of Object.values(m.entryJSFiles ?? {})) for (const x of lista) ficheros.add(x);
  let bruto = 0;
  let gzip = 0;
  let br = 0;
  for (const x of ficheros) {
    const t = tam(x);
    bruto += t.bruto;
    gzip += t.gzip;
    br += t.br;
  }
  filas.push({ ruta: ruta.replace(/\/page$/, "") || "/", chunks: ficheros.size, kbBruto: Math.round(bruto / 1024), kbGzip: Math.round(gzip / 1024), kbBrotli: Math.round(br / 1024) });
  for (const [mod, info] of Object.entries(m.clientModules ?? {})) {
    for (const c of info.chunks ?? []) {
      const k = c.replace(/^\/_next\//, "");
      if (!usoChunk.has(k)) usoChunk.set(k, { mods: new Set(), async: info.async });
      usoChunk.get(k).mods.add(mod.replace(/^\[project\]\/(\.claude\/worktrees\/[^/]+\/)?/, ""));
    }
  }
}
filas.sort((a, b) => b.kbGzip - a.kbGzip);
console.log(`Arranque común (polyfills + rootMainFiles): ${raiz.length} ficheros, ${Math.round(raiz.reduce((s, x) => s + tam(x).gzip, 0) / 1024)} KB gzip`);
console.table(filas);

const pesados = [...usoChunk.entries()]
  .map(([c, u]) => ({ chunk: path.basename(c), kbGzip: Math.round(tam(c).gzip / 1024), diferido: u.async, ejemplo: [...u.mods].filter((x) => x.startsWith("src/")).slice(0, 3).join(", ") || [...u.mods].slice(0, 2).join(", ") }))
  .sort((a, b) => b.kbGzip - a.kbGzip)
  .slice(0, 15);
console.log("Chunks de cliente más pesados:");
console.table(pesados);
