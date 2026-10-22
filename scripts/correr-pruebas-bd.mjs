/**
 * Corre TODAS las pruebas de base de datos (`scripts/test-*.mjs`) una tras otra
 * y resume pasa/falla de cada una.
 *
 *   node scripts/correr-pruebas-bd.mjs [--env-file=RUTA] [--salida=DIR] [--pendientes] [filtro…]
 *
 * · `--env-file` (por defecto `.env.local` del repo) se le pasa a cada prueba
 *   como `node --env-file=…`; este script NO lee ni imprime su contenido.
 * · `--salida` guarda la salida completa de cada prueba en DIR/<prueba>.txt.
 * · Los filtros (opcionales) limitan a las pruebas cuyo nombre los contenga.
 * · `--pendientes` corre cada prueba con `scripts/con-pendientes.mjs` precargado:
 *   TODAS las migraciones del repositorio que la base aún no tiene se aplican
 *   juntas dentro de una transacción que se deshace, y la prueba entera (con sus
 *   `begin/commit` y sus altas de usuario) ocurre dentro de ella. Así se prueba
 *   el esquema que habrá DESPUÉS de `db push` sin aplicarlo.
 *
 * Se excluyen las que no pueden correr sin intervención:
 *   test-ingest.mjs  necesita el token del Atajo de un usuario y la app en marcha
 *                    (y escribe movimientos reales a través del endpoint).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opcion = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const envFile = resolve(opcion("env-file") ?? join(raiz, ".env.local"));
const salida = opcion("salida") ? resolve(opcion("salida")) : null;
const filtros = args.filter((a) => !a.startsWith("--"));
const pendientes = args.includes("--pendientes");
const precarga = pendientes ? ["--import", pathToFileURL(join(raiz, "scripts", "con-pendientes.mjs")).href] : [];
const EXCLUIDAS = { "test-ingest.mjs": "necesita token del Atajo + app en marcha; escribe datos reales" };

if (salida) mkdirSync(salida, { recursive: true });

const pruebas = readdirSync(join(raiz, "scripts"))
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .filter((f) => filtros.length === 0 || filtros.some((x) => f.includes(x)))
  .sort();

function correr(fichero) {
  return new Promise((ok) => {
    const inicio = Date.now();
    const hijo = spawn(process.execPath, [`--env-file=${envFile}`, ...precarga, join(raiz, "scripts", fichero)], {
      cwd: raiz,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let texto = "";
    hijo.stdout.on("data", (d) => (texto += d));
    hijo.stderr.on("data", (d) => (texto += d));
    const reloj = setTimeout(() => hijo.kill(), 15 * 60_000);
    hijo.on("close", (codigo) => {
      clearTimeout(reloj);
      ok({ codigo, texto, ms: Date.now() - inicio });
    });
  });
}

const filas = [];
for (const f of pruebas) {
  if (EXCLUIDAS[f]) {
    filas.push({ prueba: f, estado: "NO EJECUTADA", ok: "-", fallos: "-", seg: "-", motivo: EXCLUIDAS[f] });
    console.log(`-- ${f}: no ejecutada (${EXCLUIDAS[f]})`);
    continue;
  }
  const { codigo, texto, ms } = await correr(f);
  if (salida) writeFileSync(join(salida, f.replace(/\.mjs$/, ".txt")), texto);
  const oks = (texto.match(/^\s+OK\b/gm) ?? []).length;
  const fallos = (texto.match(/FALLO/g) ?? []).length;
  const estado = codigo === 0 && fallos === 0 ? "PASA" : "FALLA";
  const motivo = estado === "PASA" ? "" : (texto.match(/(error|FALLO)[^\n]*/i)?.[0] ?? `código ${codigo}`).slice(0, 160);
  filas.push({ prueba: f, estado, ok: oks, fallos, seg: (ms / 1000).toFixed(1), motivo });
  console.log(`${estado === "PASA" ? "OK" : "!!"} ${f}: ${estado} (${oks} OK, ${fallos} fallos, ${(ms / 1000).toFixed(1)} s)${motivo ? ` — ${motivo}` : ""}`);
}

console.log("\n| Prueba | Estado | OK | Fallos | s | Motivo |\n|---|---|---|---|---|---|");
for (const r of filas) console.log(`| ${r.prueba} | ${r.estado} | ${r.ok} | ${r.fallos} | ${r.seg} | ${r.motivo.replace(/\|/g, "/")} |`);
process.exit(filas.some((r) => r.estado === "FALLA") ? 1 : 0);
