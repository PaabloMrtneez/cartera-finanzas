#!/usr/bin/env node
/**
 * Comprueba que NINGUNA clave `service_role` en formato JWT heredado (`eyJ...`)
 * haya acabado en el paquete que descarga el navegador.
 *
 * El grep de `sb_secret_` del workflow solo pilla el formato NUEVO de claves.
 * Una `service_role` en el formato JWT clásico empieza igual que la `anon`
 * (`eyJhbGci...`), que SÍ es pública y vive legítimamente en el bundle; lo único
 * que las distingue es el claim `role` del payload. Por eso aquí no se busca el
 * prefijo a secas —daría un falso positivo en cada build por la anon—, sino que
 * se decodifica cada JWT y se falla solo si su rol es `service_role`.
 *
 * Uso: node scripts/comprobar-bundle-cliente.mjs [directorio]
 *   directorio: por defecto `.next/static` (el paquete del cliente).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RAIZ = process.argv[2] ?? ".next/static";

// Un JWT: tres segmentos base64url separados por puntos, los dos primeros
// empezando por `eyJ` (que es `{"` codificado).
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

function ficheros(dir, acc = []) {
  let entradas;
  try {
    entradas = readdirSync(dir);
  } catch {
    return acc; // Sin `.next/static` (no se ha compilado): nada que revisar.
  }
  for (const entrada of entradas) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) ficheros(ruta, acc);
    else acc.push(ruta);
  }
  return acc;
}

function esServiceRole(token) {
  const payload = token.split(".")[1];
  try {
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return json?.role === "service_role";
  } catch {
    return false; // Lo que no decodifica a JSON con `role` no es una clave de Supabase.
  }
}

const culpables = new Set();
for (const fichero of ficheros(RAIZ)) {
  let texto;
  try {
    texto = readFileSync(fichero, "utf8");
  } catch {
    continue; // Binarios y demás: no llevan la clave en claro.
  }
  const encontrados = texto.match(JWT);
  if (!encontrados) continue;
  for (const token of encontrados) {
    if (esServiceRole(token)) culpables.add(fichero);
  }
}

if (culpables.size > 0) {
  console.error("::error::Se ha encontrado una clave service_role (JWT) en el paquete del cliente");
  for (const fichero of culpables) console.error(fichero);
  process.exit(1);
}

console.log("Paquete del cliente limpio: sin JWT service_role.");
