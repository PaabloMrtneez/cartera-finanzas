/**
 * Genera los iconos de la app instalable a partir de la misma geometría que
 * usa <BrandMark />, en porcentajes, para que el icono del móvil y el de la
 * interfaz sean exactamente el mismo dibujo.
 *
 *   node scripts/generate-icons.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const OUT = join(process.cwd(), "public");
mkdirSync(OUT, { recursive: true });

/**
 * @param {number} size
 * @param {number} radiusPct  Radio del contenedor, en % del lado.
 * @param {number} inset      Margen alrededor del dibujo, en % del lado. Los
 *                            iconos «enmascarables» de Android recortan hasta
 *                            un 10 % por cada lado, así que necesitan aire.
 * @param {number} trazo      Grosor de los anillos, en % del lado. Fino en los
 *                            iconos grandes; más grueso en el favicon, donde un
 *                            hilo se perdería.
 */
function svg(size, radiusPct, inset = 0, trazo = 3.2) {
  const s = size;
  const pad = (inset / 100) * s;
  const inner = s - pad * 2;
  const p = (v) => pad + (v / 100) * inner;
  const d = (v) => (v / 100) * inner;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#121726"/>
      <stop offset="100%" stop-color="#070a12"/>
    </linearGradient>
    <linearGradient id="fuera" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8b7bf0"/>
      <stop offset="100%" stop-color="#48d4d0"/>
    </linearGradient>
    <linearGradient id="dentro" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#48d4d0"/>
      <stop offset="100%" stop-color="#e6c06a"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${s}" height="${s}" rx="${(radiusPct / 100) * s}" fill="#070a12"/>
  <rect x="${pad}" y="${pad}" width="${inner}" height="${inner}" rx="${(radiusPct / 100) * inner}" fill="url(#tile)"/>
  <path d="M${p(67.24)} ${p(27.94)} A${d(28)} ${d(28)} 0 1 0 ${p(67.24)} ${p(72.06)}" fill="none" stroke="url(#fuera)" stroke-width="${d(trazo)}" stroke-linecap="round"/>
  <path d="M${p(60.47)} ${p(36.6)} A${d(17)} ${d(17)} 0 1 0 ${p(60.47)} ${p(63.4)}" fill="none" stroke="url(#dentro)" stroke-width="${d(trazo)}" stroke-linecap="round"/>
</svg>`;
}

const targets = [
  { file: "icono-192.png", size: 192, radius: 23, inset: 0 },
  { file: "icono-512.png", size: 512, radius: 23, inset: 0 },
  // Enmascarable: el dibujo se encoge para sobrevivir al recorte circular.
  { file: "icono-mascara-512.png", size: 512, radius: 0, inset: 12 },
  // iOS aplica su propia máscara, así que el fondo va a sangre.
  { file: "apple-touch-icon.png", size: 180, radius: 0, inset: 0 },
];

for (const { file, size, radius, inset } of targets) {
  const buffer = await sharp(Buffer.from(svg(size, radius, inset))).png().toBuffer();
  writeFileSync(join(OUT, file), buffer);
  console.log(`${file}  ${size}x${size}  ${(buffer.length / 1024).toFixed(1)} KB`);
}

// El favicon (.ico con PNG dentro, 16 y 32 px), con el trazo más grueso. El
// formato ICO admite PNG embebido: cabecera de 6 bytes, una entrada de 16 por
// imagen y los PNG detrás, tal cual.
const pequenos = [16, 32];
const pngs = [];
for (const size of pequenos) {
  pngs.push(await sharp(Buffer.from(svg(size, 23, 0, 6))).png().toBuffer());
}
const cabecera = Buffer.alloc(6);
cabecera.writeUInt16LE(0, 0);
cabecera.writeUInt16LE(1, 2);
cabecera.writeUInt16LE(pngs.length, 4);
const entradas = [];
let desplazamiento = 6 + 16 * pngs.length;
pngs.forEach((png, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(pequenos[i], 0);
  e.writeUInt8(pequenos[i], 1);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(desplazamiento, 12);
  desplazamiento += png.length;
  entradas.push(e);
});
const ico = Buffer.concat([cabecera, ...entradas, ...pngs]);
writeFileSync(join(process.cwd(), "src", "app", "favicon.ico"), ico);
console.log(`favicon.ico  16+32  ${(ico.length / 1024).toFixed(1)} KB`);

console.log("\nIconos generados en public/ (y el favicon en src/app/)");
