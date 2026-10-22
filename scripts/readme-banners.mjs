/**
 * Genera los banners animados del README (docs/readme/*.svg).
 *
 *   npm run readme:banners
 *
 * Por qué SVG generado y no imágenes hechas a mano:
 *  · GitHub enseña un SVG del repositorio como imagen, y las animaciones CSS
 *    que lleva DENTRO se reproducen (sin JavaScript, que ahí no corre).
 *  · El texto va convertido en TRAZOS con la fuente de la app (Space Grotesk).
 *    GitHub sirve las imágenes con una política de seguridad que no deja cargar
 *    fuentes, ni siquiera incrustadas: con <text> saldría en otra tipografía.
 *  · Cada banner sale en versión oscura y clara; el README elige con <picture>
 *    según el tema de quien lo mira.
 *  · Los colores son los tokens de Aurora (src/app/globals.css). Si cambian
 *    allí, se cambian aquí y se vuelve a generar.
 *  · Con `prefers-reduced-motion` no se mueve nada: cada pieza está escrita en
 *    su estado final y la animación solo la trae hasta él.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const SALIDA = join(raiz, "docs", "readme");
const cargar = (peso) =>
  opentype.parse(readFileSync(join(SALIDA, "fuente", `SpaceGrotesk-${peso}.ttf`)).buffer);
const F = { regular: cargar("Regular"), medium: cargar("Medium"), bold: cargar("Bold") };

// ── Tokens de Aurora, por tema ──────────────────────────────────────────────

const TEMAS = {
  oscuro: {
    fondo: "#02040a",
    superficie: "#0e1320",
    filete: "rgba(158, 182, 236, 0.16)",
    fg: "#ecf1fb",
    muted: "#9fa8c0",
    v: "#8b7bf0",
    c: "#48d4d0",
    g: "#e6c06a",
    acento: "#56d9d4",
    azulejoAlto: "#141b28",
    azulejoBajo: "#0a0d17",
    azulejoFilete: "rgba(165, 195, 245, 0.16)",
    brillo: 0.34,
    estrellas: true,
    destello: "#ffffff",
  },
  claro: {
    fondo: "#fbfcfe",
    superficie: "#eef1f7",
    filete: "#d7dce7",
    fg: "#121622",
    muted: "#595f6e",
    v: "#7564e8",
    c: "#1fb0ab",
    g: "#d3a443",
    acento: "#12a7a0",
    azulejoAlto: "#ffffff",
    azulejoBajo: "#eef2f8",
    azulejoFilete: "#d3d9e6",
    brillo: 0.16,
    estrellas: false,
    destello: "#ffffff",
  },
};

/** El espectro de las categorías (`--aurora-1…7` y `--aurora-otros`). */
const ESPECTRO = ["#8b7bf0", "#6aa9e8", "#48d4d0", "#8de6c0", "#e6c06a", "#f0a85a", "#f08bc0", "#6d7689"];

// ── Texto en trazos ─────────────────────────────────────────────────────────

/**
 * Un texto convertido en un <path>, con kerning y espaciado opcional (px).
 * `anchor`: start | middle | end. Devuelve el path y el ancho que ocupa.
 */
function trazo(fuente, cadena, x, y, size, { tracking = 0, anchor = "start" } = {}) {
  const glifos = fuente.stringToGlyphs(cadena);
  const escala = size / fuente.unitsPerEm;
  const avances = glifos.map((g, i) => {
    const kern = i < glifos.length - 1 ? fuente.getKerningValue(g, glifos[i + 1]) : 0;
    return (g.advanceWidth + kern) * escala + (i < glifos.length - 1 ? tracking : 0);
  });
  const ancho = avances.reduce((a, b) => a + b, 0);
  let cx = anchor === "middle" ? x - ancho / 2 : anchor === "end" ? x - ancho : x;
  let d = "";
  glifos.forEach((g, i) => {
    d += g.getPath(cx, y, size).toPathData(2);
    cx += avances[i];
  });
  return { d, ancho };
}

const path = (t, atributos = "") => `<path d="${t.d}" ${atributos}/>`;

// ── Piezas comunes ──────────────────────────────────────────────────────────

const ESTILO_BASE = `
  .sube { animation: sube 0.9s cubic-bezier(.2,.8,.2,1) both; }
  @keyframes sube { from { opacity: 0; transform: translateY(14px); } }
  .aparece { animation: aparece 1.2s ease-out both; }
  @keyframes aparece { from { opacity: 0; } }
  .deriva-a { animation: deriva-a 18s ease-in-out infinite alternate; }
  .deriva-b { animation: deriva-b 22s ease-in-out infinite alternate; }
  .deriva-c { animation: deriva-c 26s ease-in-out infinite alternate; }
  @keyframes deriva-a { to { transform: translate(90px, 30px); } }
  @keyframes deriva-b { to { transform: translate(-110px, -20px); } }
  @keyframes deriva-c { to { transform: translate(60px, -40px); } }
  .titila { animation: titila 4s ease-in-out infinite; }
  @keyframes titila { 50% { opacity: 0.15; } }
  .barrido { animation: barrido 6s cubic-bezier(.45,0,.55,1) 2s infinite; }
  @keyframes barrido { from { transform: translateX(-320px); } 45%, to { transform: translateX(1600px); } }
  * { transform-box: fill-box; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
`;

function documento(ancho, alto, titulo, defs, cuerpo, estilo = "") {
  // Sin título es decoración (el separador): que los lectores de pantalla lo salten.
  const accesible = titulo ? `role="img" aria-label="${titulo}"` : `aria-hidden="true"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" ${accesible}>
${titulo ? `<title>${titulo}</title>` : ""}
<style>${ESTILO_BASE}${estilo}</style>
<defs>${defs}</defs>
${cuerpo}
</svg>
`;
}

/** Tarjeta redondeada con filete, y su recorte para lo que va dentro. */
function tarjeta(t, ancho, alto, id) {
  return {
    defs: `<clipPath id="${id}"><rect width="${ancho}" height="${alto}" rx="32"/></clipPath>`,
    fondo: `<rect width="${ancho}" height="${alto}" rx="32" fill="${t.fondo}"/>`,
    filete: `<rect x="0.75" y="0.75" width="${ancho - 1.5}" height="${alto - 1.5}" rx="31.25" fill="none" stroke="${t.filete}" stroke-width="1.5"/>`,
  };
}

/** Resplandores del fondo: violeta, cian y oro, a la deriva. */
function resplandores(t, puntos) {
  const defs = ["v", "c", "g"]
    .map(
      (k) =>
        `<radialGradient id="r-${k}"><stop offset="0" stop-color="${t[k]}" stop-opacity="${t.brillo}"/><stop offset="1" stop-color="${t[k]}" stop-opacity="0"/></radialGradient>`,
    )
    .join("");
  const cuerpo = puntos
    .map(
      ([k, cx, cy, rx, ry], i) =>
        `<ellipse class="deriva-${"abc"[i % 3]}" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#r-${k})"/>`,
    )
    .join("");
  return { defs, cuerpo };
}

/** Estrellas tenues (solo de noche), en posiciones fijas para que no cambien al regenerar. */
function estrellas(t, ancho, alto, n) {
  if (!t.estrellas) return "";
  let semilla = 7;
  const azar = () => ((semilla = (semilla * 9301 + 49297) % 233280) / 233280);
  let s = "";
  for (let i = 0; i < n; i++) {
    const x = (azar() * ancho).toFixed(1);
    const y = (azar() * alto).toFixed(1);
    const r = (0.6 + azar() * 1.1).toFixed(2);
    const retraso = (azar() * 4).toFixed(2);
    s += `<circle class="titila" style="animation-delay:${retraso}s" cx="${x}" cy="${y}" r="${r}" fill="#dfe8ff" opacity="0.55"/>`;
  }
  return s;
}

/** El filo del espectro abajo de la tarjeta, con un destello que lo recorre. */
function filoAurora(t, ancho, alto, id) {
  return {
    defs: `<linearGradient id="${id}-esp" x1="0" x2="1"><stop offset="0" stop-color="${t.v}"/><stop offset="0.52" stop-color="${t.c}"/><stop offset="1" stop-color="${t.g}"/></linearGradient>
<linearGradient id="${id}-luz" x1="0" x2="1"><stop offset="0" stop-color="${t.destello}" stop-opacity="0"/><stop offset="0.5" stop-color="${t.destello}" stop-opacity="0.85"/><stop offset="1" stop-color="${t.destello}" stop-opacity="0"/></linearGradient>`,
    cuerpo: `<rect x="0" y="${alto - 5}" width="${ancho}" height="5" fill="url(#${id}-esp)"/>
<rect class="barrido" x="0" y="${alto - 5}" width="260" height="5" fill="url(#${id}-luz)"/>`,
  };
}

/**
 * La marca: los dos anillos Aurora sobre su azulejo (la misma geometría que
 * src/components/brand-mark.tsx). Los anillos se dibujan al aparecer.
 */
function marca(t, x, y, lado, id, { dibuja = true, retraso = 0 } = {}) {
  const k = lado / 100;
  const clase = dibuja ? ' class="dibuja"' : "";
  return {
    defs: `<linearGradient id="${id}-az" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.azulejoAlto}"/><stop offset="1" stop-color="${t.azulejoBajo}"/></linearGradient>
<linearGradient id="${id}-fuera" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.v}"/><stop offset="1" stop-color="${t.c}"/></linearGradient>
<linearGradient id="${id}-dentro" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.c}"/><stop offset="1" stop-color="${t.g}"/></linearGradient>`,
    cuerpo: `<g transform="translate(${x} ${y}) scale(${k})">
<rect width="100" height="100" rx="23" fill="url(#${id}-az)"/>
<rect x="0.75" y="0.75" width="98.5" height="98.5" rx="22.25" fill="none" stroke="${t.azulejoFilete}" stroke-width="1.5"/>
<path${clase} style="animation-delay:${retraso}s" pathLength="100" d="M67.24 27.94 A28 28 0 1 0 67.24 72.06" fill="none" stroke="url(#${id}-fuera)" stroke-width="3.2" stroke-linecap="round"/>
<path${clase} style="animation-delay:${retraso + 0.35}s" pathLength="100" d="M60.47 36.6 A17 17 0 1 0 60.47 63.4" fill="none" stroke="url(#${id}-dentro)" stroke-width="3.2" stroke-linecap="round"/>
</g>`,
  };
}

const ESTILO_MARCA = `
  .dibuja { stroke-dasharray: 100; animation: dibuja 1.6s cubic-bezier(.65,0,.35,1) both; }
  @keyframes dibuja { from { stroke-dashoffset: 100; } }
`;

// ── Los banners ─────────────────────────────────────────────────────────────

function cabecera(t) {
  const W = 1280;
  const H = 420;
  const card = tarjeta(t, W, H, "cab");
  const luz = resplandores(t, [
    ["v", 260, 80, 420, 260],
    ["c", 1050, 120, 380, 240],
    ["g", 760, 470, 360, 180],
  ]);
  const filo = filoAurora(t, W, H, "cab");
  const logo = marca(t, 96, 126, 168, "cab-m");

  const x = 316;
  const ceja = trazo(F.medium, "FINANZAS PERSONALES · APP PRIVADA", x, 166, 17, { tracking: 3.2 });
  const nombre = trazo(F.bold, "Cartera", x - 4, 260, 112);
  const lema = trazo(F.regular, "Tus cuentas, tus gastos y tus inversiones en un solo sitio.", x, 312, 27);

  return documento(
    W,
    H,
    "Cartera — finanzas personales, privadas y en un solo sitio",
    card.defs + luz.defs + filo.defs + logo.defs,
    `${card.fondo}
<g clip-path="url(#cab)">${luz.cuerpo}${estrellas(t, W, H, 46)}${filo.cuerpo}</g>
${logo.cuerpo}
<g class="sube" style="animation-delay:.35s">${path(ceja, `fill="${t.acento}"`)}</g>
<g class="sube" style="animation-delay:.5s">${path(nombre, `fill="${t.fg}"`)}</g>
<g class="sube" style="animation-delay:.75s">${path(lema, `fill="${t.muted}"`)}</g>
${card.filete}`,
    ESTILO_MARCA,
  );
}

function banda(t) {
  const W = 1280;
  const H = 384;
  const card = tarjeta(t, W, H, "ban");
  const luz = resplandores(t, [
    ["c", 300, 260, 420, 200],
    ["v", 1100, 60, 360, 200],
  ]);

  const ceja = trazo(F.medium, "LA FIRMA DE CARTERA", 64, 74, 16, { tracking: 3 });
  const titulo = trazo(F.medium, "La banda Aurora", 64, 124, 40);
  const texto = trazo(F.regular, "El gasto del mes como un solo espectro: cada categoría, su tramo.", 64, 162, 21);
  const aviso = trazo(F.regular, "Datos de ejemplo", W - 64, 74, 17, { anchor: "end" });

  const partes = [
    ["Vivienda", 32],
    ["Súper", 20],
    ["Transporte", 12],
    ["Restaurantes", 11],
    ["Ocio", 9],
    ["Suscripciones", 7],
    ["Salud", 5],
    ["Otros", 4],
  ];
  const x0 = 64;
  const anchoBarra = W - 128;
  const hueco = 3;
  const y = 196;
  const alto = 40;
  let bx = x0;
  let tramos = "";
  partes.forEach(([, pct], i) => {
    const w = (anchoBarra * pct) / 100 - (i < partes.length - 1 ? hueco : 0);
    tramos += `<rect x="${bx.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${alto}" fill="${ESPECTRO[i]}"/>`;
    bx += w + hueco;
  });

  // Leyenda bajo la banda: cada entrada ocupa lo que mide su nombre, y el
  // hueco que sobra se reparte a partes iguales entre ellas. Con columnas
  // iguales, «Restaurantes» y «Suscripciones» se montaban sobre el punto de la
  // siguiente.
  const anchos = partes.map(([nombre, pct]) =>
    20 + Math.max(trazo(F.medium, nombre, 0, 0, 19).ancho, trazo(F.regular, `${pct} %`, 0, 0, 18).ancho),
  );
  const holgura = (anchoBarra - anchos.reduce((a, b) => a + b, 0)) / (partes.length - 1);
  let leyenda = "";
  let lx = x0;
  partes.forEach(([nombre, pct], i) => {
    const n = trazo(F.medium, nombre, lx + 20, 288, 19);
    const p = trazo(F.regular, `${pct} %`, lx + 20, 318, 18);
    leyenda += `<g class="sube" style="animation-delay:${0.9 + i * 0.07}s"><circle cx="${lx + 7}" cy="281" r="6.5" fill="${ESPECTRO[i]}"/>${path(n, `fill="${t.fg}"`)}${path(p, `fill="${t.muted}"`)}</g>`;
    lx += anchos[i] + holgura;
  });

  return documento(
    W,
    H,
    "La banda Aurora: el gasto del mes repartido por categorías (datos de ejemplo)",
    `${card.defs}${luz.defs}<clipPath id="ban-barra"><rect x="${x0}" y="${y}" width="${anchoBarra}" height="${alto}" rx="${alto / 2}"/></clipPath>
<linearGradient id="ban-luz" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    `${card.fondo}
<g clip-path="url(#ban)">${luz.cuerpo}${estrellas(t, W, H, 26)}</g>
<g class="sube" style="animation-delay:.1s">${path(ceja, `fill="${t.acento}"`)}</g>
<g class="sube" style="animation-delay:.2s">${path(titulo, `fill="${t.fg}"`)}</g>
<g class="sube" style="animation-delay:.3s">${path(texto, `fill="${t.muted}"`)}</g>
<g class="aparece">${path(aviso, `fill="${t.muted}"`)}</g>
<g clip-path="url(#ban-barra)"><g class="crece">${tramos}</g><rect class="barrido" x="${x0}" y="${y}" width="200" height="${alto}" fill="url(#ban-luz)"/></g>
${leyenda}
${card.filete}`,
    `.crece { transform-origin: left center; animation: crece 1.5s cubic-bezier(.65,0,.35,1) .45s both; }
     @keyframes crece { from { transform: scaleX(0); } }`,
  );
}

function separador(t) {
  const W = 1280;
  const H = 24;
  return documento(
    W,
    H,
    "",
    `<linearGradient id="sep" x1="0" x2="1"><stop offset="0" stop-color="${t.v}" stop-opacity="0"/><stop offset="0.2" stop-color="${t.v}"/><stop offset="0.5" stop-color="${t.c}"/><stop offset="0.8" stop-color="${t.g}"/><stop offset="1" stop-color="${t.g}" stop-opacity="0"/></linearGradient>
<linearGradient id="sep-luz" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="sep-c"><rect x="0" y="11" width="${W}" height="2" rx="1"/></clipPath>`,
    `<rect x="0" y="11" width="${W}" height="2" rx="1" fill="url(#sep)" opacity="0.7"/>
<g clip-path="url(#sep-c)"><rect class="barrido" x="0" y="11" width="220" height="2" fill="url(#sep-luz)"/></g>`,
  );
}

function video(t) {
  const W = 1280;
  const H = 720;
  const card = tarjeta(t, W, H, "vid");
  const luz = resplandores(t, [
    ["v", 330, 220, 520, 340],
    ["c", 980, 520, 480, 320],
    ["g", 640, 760, 420, 200],
  ]);
  const filo = filoAurora(t, W, H, "vid");
  const logo = marca(t, 56, 52, 52, "vid-m", { dibuja: false });
  const nombre = trazo(F.bold, "Cartera", 124, 90, 30);
  const titulo = trazo(F.medium, "Vídeo de presentación", W / 2, 492, 46, { anchor: "middle" });
  const pronto = trazo(F.regular, "Próximamente", W / 2 - 14, 538, 24, { anchor: "middle" });
  const finPronto = W / 2 - 14 + pronto.ancho / 2;
  const cx = W / 2;
  const cy = 330;

  return documento(
    W,
    H,
    "Vídeo de presentación de Cartera — próximamente",
    `${card.defs}${luz.defs}${filo.defs}${logo.defs}
<linearGradient id="vid-anillo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.v}"/><stop offset="0.5" stop-color="${t.c}"/><stop offset="1" stop-color="${t.g}"/></linearGradient>`,
    `${card.fondo}
<g clip-path="url(#vid)">${luz.cuerpo}${estrellas(t, W, H, 70)}${filo.cuerpo}</g>
${logo.cuerpo}${path(nombre, `fill="${t.fg}"`)}
<circle class="pulso" cx="${cx}" cy="${cy}" r="78" fill="none" stroke="${t.c}" stroke-width="2"/>
<circle class="pulso" style="animation-delay:1.2s" cx="${cx}" cy="${cy}" r="78" fill="none" stroke="${t.v}" stroke-width="2"/>
<circle cx="${cx}" cy="${cy}" r="78" fill="${t.superficie}"/>
<circle class="gira" cx="${cx}" cy="${cy}" r="78" fill="none" stroke="url(#vid-anillo)" stroke-width="3"/>
<path d="M${cx - 20} ${cy - 32} L${cx + 34} ${cy} L${cx - 20} ${cy + 32} Z" fill="${t.fg}" stroke="${t.fg}" stroke-width="6" stroke-linejoin="round"/>
<g class="sube" style="animation-delay:.3s">${path(titulo, `fill="${t.fg}"`)}</g>
<g class="sube" style="animation-delay:.5s">${path(pronto, `fill="${t.muted}"`)}
${[0, 1, 2].map((i) => `<circle class="punto" style="animation-delay:${i * 0.25}s" cx="${(finPronto + 10 + i * 10).toFixed(1)}" cy="533" r="2.6" fill="${t.acento}"/>`).join("")}</g>
${card.filete}`,
    `.pulso { transform-origin: center; animation: pulso 2.4s ease-out infinite; }
     @keyframes pulso { from { transform: scale(1); opacity: .55; } to { transform: scale(1.55); opacity: 0; } }
     .gira { transform-origin: center; animation: gira 9s linear infinite; }
     @keyframes gira { to { transform: rotate(360deg); } }
     .punto { animation: punto 1.4s ease-in-out infinite; }
     @keyframes punto { 0%, 100% { opacity: .2; } 40% { opacity: 1; } }`,
  );
}

function pie(t) {
  const W = 1280;
  const H = 168;
  const card = tarjeta(t, W, H, "pie");
  const luz = resplandores(t, [
    ["v", 260, 168, 380, 140],
    ["g", 1040, 0, 360, 140],
  ]);
  const filo = filoAurora(t, W, H, "pie");
  // Logo y nombre centrados como un solo bloque.
  const lado = 60;
  const hueco = 20;
  const nombreMedida = trazo(F.bold, "Cartera", 0, 0, 44);
  const x0 = (W - (lado + hueco + nombreMedida.ancho)) / 2;
  const logo = marca(t, x0, (H - lado) / 2 - 2, lado, "pie-m", { retraso: 0.2 });
  const nombre = trazo(F.bold, "Cartera", x0 + lado + hueco, H / 2 + 13, 44);
  return documento(
    W,
    H,
    "Cartera",
    card.defs + luz.defs + filo.defs + logo.defs,
    `${card.fondo}
<g clip-path="url(#pie)">${luz.cuerpo}${estrellas(t, W, H, 20)}${filo.cuerpo}</g>
${logo.cuerpo}
<g class="sube" style="animation-delay:.5s">${path(nombre, `fill="${t.fg}"`)}</g>
${card.filete}`,
    ESTILO_MARCA,
  );
}

// ── Escribir ────────────────────────────────────────────────────────────────

mkdirSync(SALIDA, { recursive: true });
const BANNERS = { cabecera, banda, separador, video, pie };
for (const [nombre, hacer] of Object.entries(BANNERS)) {
  for (const [tema, t] of Object.entries(TEMAS)) {
    const fichero = join(SALIDA, `${nombre}-${tema}.svg`);
    const svg = hacer(t);
    writeFileSync(fichero, svg);
    console.log(`${nombre}-${tema}.svg  ${(svg.length / 1024).toFixed(1)} KB`);
  }
}
