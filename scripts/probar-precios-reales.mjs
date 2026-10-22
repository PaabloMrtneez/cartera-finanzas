/**
 * Prueba REAL, de solo lectura, del cliente de precios contra Yahoo Finance y
 * el BCE. No toca la base de datos ni necesita secretos.
 *
 *   node scripts/probar-precios-reales.mjs
 *
 * No va en la CI a propósito: depende de la red y de una API no oficial que
 * puede cambiar o limitar. Sirve para comprobar, el día que haga falta, que el
 * parseo sigue funcionando con las respuestas de HOY.
 *
 * Importa src/lib/precios/fuentes.ts tal cual (Node quita los tipos): se prueba
 * el MISMO código que usan la ruta /api/precios y las server actions.
 *
 * Instrumentos de referencia (verificados con el usuario):
 *   · 0P0001CLDK.F  Fidelity MSCI World Index Fund P-ACC-EUR (IE00BYX5NX33)
 *   · 0P00008T3U.F  DWS Invest Gold and Precious Metals Equities LC (LU0273159177)
 *   · GOOGL         Alphabet (USD), con el cambio USD del BCE
 */
import {
  buscarCandidatos,
  descargarHistorico,
  descargarTiposDeCambio,
  descargarUltimos,
} from "../src/lib/precios/fuentes.ts";

let ok = 0;
let mal = 0;
function check(nombre, condicion, detalle = "") {
  if (condicion) {
    ok++;
    console.log(`  OK    ${nombre}${detalle ? `  (${detalle})` : ""}`);
  } else {
    mal++;
    console.log(`  FALLO ${nombre}${detalle ? `\n        ${detalle}` : ""}`);
  }
}

const DECIMAL = /^\d+(\.\d{1,6})?$/;
const hace = (dias) => new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);

async function intento(nombre, trabajo) {
  try {
    await trabajo();
  } catch (e) {
    mal++;
    console.log(`  FALLO ${nombre}: ${e?.codigo ?? ""} ${e?.message ?? e}`);
  }
}

async function main() {
  console.log("— Yahoo: últimos días —\n");
  for (const [simbolo, tipo, divisa] of [
    ["0P0001CLDK.F", "FONDO", "EUR"],
    ["0P00008T3U.F", "FONDO", "EUR"],
    ["GOOGL", "ACCION", "USD"],
  ]) {
    await intento(simbolo, async () => {
      const c = await descargarUltimos(simbolo, 14);
      const ultimo = c.precios.at(-1);
      check(
        `${simbolo}: ${c.nombre} · ${c.tipo} · ${c.divisa} · ${c.mercado}`,
        c.tipo === tipo && c.divisa === divisa && c.precios.length > 0,
        `${c.precios.length} cierres, último ${ultimo?.cierre} del ${ultimo?.fecha}`,
      );
      check(
        `${simbolo}: todos los cierres son decimales exactos en texto, con fecha y sin repetir`,
        c.precios.every((p) => typeof p.cierre === "string" && DECIMAL.test(p.cierre) && /^\d{4}-\d{2}-\d{2}$/.test(p.fecha)) &&
          new Set(c.precios.map((p) => p.fecha)).size === c.precios.length,
      );
    });
  }

  console.log("\n— Yahoo: histórico (para el alta) —\n");
  await intento("histórico", async () => {
    const c = await descargarHistorico("0P0001CLDK.F", hace(400));
    check("0P0001CLDK.F: algo más de un año de cierres diarios", c.precios.length > 200, `${c.precios.length} cierres desde ${c.precios[0]?.fecha}`);
    const ordenados = c.precios.every((p, i, a) => i === 0 || a[i - 1].fecha < p.fecha);
    check("ordenados por fecha", ordenados);
  });

  console.log("\n— Yahoo: búsqueda —\n");
  await intento("búsqueda por ISIN", async () => {
    const c = await buscarCandidatos("IE00BYX5NX33");
    check(
      "por ISIN IE00BYX5NX33 aparece 0P0001CLDK.F con precio y fecha",
      c.some((x) => x.simbolo === "0P0001CLDK.F" && x.ultimoPrecio && x.fechaUltimoPrecio),
      c.map((x) => `${x.simbolo} ${x.divisa} ${x.ultimoPrecio}@${x.fechaUltimoPrecio}`).join(" | "),
    );
  });
  await intento("búsqueda por nombre", async () => {
    const c = await buscarCandidatos("DWS Invest Gold");
    check(
      "por nombre «DWS Invest Gold» aparece la clase LC (0P00008T3U.F) entre varias clases",
      c.some((x) => x.simbolo === "0P00008T3U.F") && c.length > 1,
      c.map((x) => `${x.simbolo} ${x.divisa} ${x.ultimoPrecio}@${x.fechaUltimoPrecio}`).join(" | "),
    );
  });
  await intento("búsqueda por símbolo", async () => {
    const c = await buscarCandidatos("GOOGL");
    check("por símbolo «GOOGL» aparece GOOGL en USD", c.some((x) => x.simbolo === "GOOGL" && x.divisa === "USD"));
  });
  await intento("símbolo inexistente", async () => {
    try {
      await descargarUltimos("NOEXISTE123XYZ", 10);
      check("un símbolo inexistente da NO_ENCONTRADO", false, "no ha fallado");
    } catch (e) {
      check("un símbolo inexistente da NO_ENCONTRADO", e?.codigo === "NO_ENCONTRADO", e?.codigo);
    }
  });

  console.log("\n— BCE —\n");
  await intento("BCE USD", async () => {
    const t = await descargarTiposDeCambio("USD", hace(14));
    const ultimo = t.at(-1);
    check(
      "USD: tipos de referencia de los últimos días, como texto decimal",
      t.length > 0 && t.every((x) => /^\d+(\.\d+)?$/.test(x.tasa)),
      `${t.length} tipos, último ${ultimo?.tasa} del ${ultimo?.fecha}`,
    );
  });
  await intento("BCE divisa desconocida", async () => {
    const t = await descargarTiposDeCambio("XXX", hace(14));
    check("una divisa que el BCE no publica devuelve lista vacía", t.length === 0);
  });

  console.log(`\n${ok} correctas · ${mal} fallidas`);
  process.exit(mal === 0 ? 0 : 1);
}

main();
