/**
 * Auditoría de seguridad del esquema.
 *
 * Comprueba las cosas que, si fallan, filtran datos entre los cuatro usuarios
 * sin que salte ningún error visible. Son fallos silenciosos: por eso se
 * verifican con una consulta y no a ojo.
 *
 *   node scripts/audit-db.mjs
 *
 * Necesita DATABASE_URL en el entorno.
 */
import pg from "pg";
import { sslDb } from "./db-ssl.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL");
  process.exit(2);
}

const client = new pg.Client({ connectionString: url, ssl: sslDb });

/** Cada comprobación debe devolver CERO filas. Cualquier fila es un fallo. */
const CHECKS = [
  {
    name: "Toda tabla de public tiene seguridad por filas activada",
    why: "Sin ella, cualquier usuario autenticado lee las filas de los demás.",
    sql: `select c.relname as objeto
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and (not c.relrowsecurity or not c.relforcerowsecurity)`,
  },
  {
    name: "Toda tabla con seguridad por filas tiene al menos una política",
    why: "Una tabla con RLS y sin políticas no filtra datos, pero deja la app inservible.",
    sql: `select c.relname as objeto
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
            and c.relname <> 'ingest_bucket'
            and not exists (select 1 from pg_policy p where p.polrelid = c.oid)`,
  },
  {
    name: "Toda vista se ejecuta con los permisos de quien consulta",
    why: "Sin security_invoker la vista salta la seguridad por filas y expone a los cuatro usuarios.",
    sql: `select c.relname as objeto
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'v'
            and coalesce((select option_value from pg_options_to_table(c.reloptions)
                          where option_name = 'security_invoker'), 'false') <> 'true'`,
  },
  {
    name: "Toda función con privilegios elevados fija su search_path",
    why: "Un search_path mutable permite secuestrar la función y escalar privilegios.",
    sql: `select p.proname as objeto
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public','private') and p.prosecdef
            and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) cfg
                            where cfg like 'search_path=%')`,
  },
  {
    name: "Ningún saldo almacenado",
    why: "Un saldo en columna se desincroniza de los movimientos y miente sin avisar.",
    // Solo tablas base: en las vistas el saldo SÍ debe aparecer, porque ahí es
    // donde se calcula a partir de los movimientos.
    sql: `select c.relname || '.' || a.attname as objeto
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and a.attnum > 0 and not a.attisdropped
            and a.attname ~ '^balance'`,
  },
  {
    name: "Ninguna clave foránea a tabla de usuario sin llevar user_id",
    why: "La seguridad por filas no cubre las claves foráneas: sin user_id se pueden referenciar filas ajenas.",
    sql: `with fk as (
            select con.conname, con.conrelid::regclass::text as tabla,
                   con.confrelid::regclass::text as referencia,
                   array(select attname from pg_attribute
                         where attrelid = con.conrelid and attnum = any(con.conkey)) as cols
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
            where con.contype = 'f' and n.nspname = 'public'
          )
          select conname || ' (' || tabla || ' -> ' || referencia || ')' as objeto
          from fk
          where referencia not in ('auth.users')
            and not ('user_id' = any(cols))
            -- Excepciones justificadas: apuntan a ingest_device por su clave
            -- primaria global. El usuario no tiene ningún privilegio de
            -- escritura sobre estas dos tablas (ingest_bucket las tiene todas
            -- revocadas, e ingest_dead_letter solo permite SELECT de lo suyo);
            -- las escribe la función de ingesta, que ya resuelve el dueño a
            -- partir del token del dispositivo.
            and conname not in ('ingest_bucket_device_id_fkey',
                                'ingest_dead_letter_device_id_fkey')`,
  },
];

async function main() {
  await client.connect();

  const version = (await client.query("select version()")).rows[0].version;
  console.log(version.split(",")[0]);
  console.log();

  let failed = 0;
  for (const check of CHECKS) {
    const { rows } = await client.query(check.sql);
    if (rows.length === 0) {
      console.log(`  OK   ${check.name}`);
    } else {
      failed++;
      console.log(`  FALLO ${check.name}`);
      console.log(`        ${check.why}`);
      for (const row of rows) console.log(`        -> ${row.objeto}`);
    }
  }

  console.log();
  const counts = await client.query(`
    select
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='r') as tablas,
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='v') as vistas,
      (select count(*) from pg_policy) as politicas,
      (select count(*) from pg_constraint con join pg_class c on c.oid=con.conrelid
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and con.contype='c') as checks,
      (select count(*) from pg_constraint con join pg_class c on c.oid=con.conrelid
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and con.contype='f') as claves_foraneas
  `);
  const c = counts.rows[0];
  console.log(
    `  ${c.tablas} tablas · ${c.vistas} vistas · ${c.politicas} políticas · ` +
      `${c.checks} restricciones CHECK · ${c.claves_foraneas} claves foráneas`,
  );

  await client.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error.message);
  await client.end().catch(() => {});
  process.exit(2);
});
