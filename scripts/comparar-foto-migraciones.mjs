/**
 * ¿Qué cifras de los usuarios REALES cambia cada migración pendiente?
 *
 *   node --env-file=.env.local scripts/comparar-foto-migraciones.mjs [--desde=VERSION]
 *
 * Dentro de UNA transacción que se deshace: aplica las pendientes anteriores a
 * `--desde` (por defecto ninguna se salta: la foto «antes» es la base tal cual),
 * saca la foto de cada usuario (huellas md5 por apartado, ver foto-cifras.mjs)
 * y luego aplica las demás UNA A UNA, sacando la foto tras cada una. Informa,
 * por migración, qué apartados cambian y en cuántos usuarios. No imprime
 * ninguna cifra ni ningún identificador de usuario.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";
import { compararFotos, fotoUsuario } from "./foto-cifras.mjs";
import { migracionesPendientes } from "./migraciones-pendientes.mjs";

const desde = process.argv.find((a) => a.startsWith("--desde="))?.slice(8) ?? null;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslDb });

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const pendientes = await migracionesPendientes(client);
    const previas = desde ? pendientes.filter((m) => m.version < desde) : [];
    const objeto = desde ? pendientes.filter((m) => m.version >= desde) : pendientes;
    for (const m of previas) await client.query(m.sql);
    if (previas.length) console.log(`Aplicadas antes de la foto inicial: ${previas.map((m) => m.fichero).join(", ")}`);

    const usuarios = (await client.query("select id::text as id from auth.users order by created_at")).rows.map((r) => r.id);
    let fotos = [];
    for (const u of usuarios) fotos.push(await fotoUsuario(client, u));
    const errores = new Set(fotos.flatMap((f) => Object.entries(f).filter(([, v]) => v.startsWith("ERROR")).map(([k, v]) => `${k}: ${v}`)));
    console.log(`Foto inicial de ${usuarios.length} usuarios.${errores.size ? ` Apartados con error: ${[...errores].join("; ")}` : ""}\n`);

    const inicial = fotos;
    for (const m of objeto) {
      await client.query(m.sql);
      const nuevas = [];
      for (const u of usuarios) nuevas.push(await fotoUsuario(client, u));
      const cambios = {};
      nuevas.forEach((f, i) => {
        for (const k of compararFotos(fotos[i], f)) cambios[k] = (cambios[k] ?? 0) + 1;
      });
      const txt = Object.entries(cambios).map(([k, n]) => `${k} (${n} usuario${n === 1 ? "" : "s"})`).join(", ");
      console.log(`${m.fichero}: ${txt || "cifras IDÉNTICAS"}`);
      fotos = nuevas;
    }

    const total = {};
    fotos.forEach((f, i) => {
      for (const k of compararFotos(inicial[i], f)) total[k] = (total[k] ?? 0) + 1;
    });
    const txt = Object.entries(total).map(([k, n]) => `${k} (${n})`).join(", ");
    console.log(`\nTOTAL con todas aplicadas: ${txt || "cifras IDÉNTICAS"}`);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.code ?? "", e.message);
  process.exit(2);
});
