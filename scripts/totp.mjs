/**
 * Genera el código TOTP de un secreto, para poder probar el acceso con segundo
 * factor de forma automática. Solo para pruebas: en producción el código lo
 * genera la app de autenticación del usuario.
 *
 *   node scripts/totp.mjs <secreto-base32>
 */
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input) {
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Carácter no válido en base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret, at = Date.now()) {
  const counter = Math.floor(at / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    1_000_000;

  return String(code).padStart(6, "0");
}

// Solo imprime cuando se lanza este fichero directamente. Sin esta guarda,
// importar `totp` desde otro script ejecutaba esta línea con el primer
// argumento de ESE script, que no es ningún secreto base32.
const esEntrada = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (esEntrada && process.argv[2]) console.log(totp(process.argv[2]));
