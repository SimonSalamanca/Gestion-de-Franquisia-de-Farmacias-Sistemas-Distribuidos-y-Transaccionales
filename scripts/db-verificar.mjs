// Compara el esquema que definen los scripts de db/<nodo>/ con el que tiene la base del .env.
// Solo lectura: abre la sesión con default_transaction_read_only.
// Uso: npm run db:verificar            (informa diferencias)
//      npm run db:verificar -- --estricto   (sale con código 1 si hay diferencias)
import fs from "fs";
import pg from "pg";
import { config } from "../apps/api/config.mjs";
import { scriptsDe } from "../apps/api/migrate.mjs";

const estricto = process.argv.includes("--estricto");

// Objetos que el código crea fuera de los .sql (ver migrate.mjs: asegurarUsuarioUnico).
const CREADOS_EN_CODIGO = { central: [], local: ["empleado_ref_usuario_key"] };

function esperado(nodo) {
  const cols = {};
  const nombres = new Set();
  const vistas = new Set();
  const funciones = new Set();
  for (const script of scriptsDe(nodo)) {
    const sql = fs.readFileSync(script.ruta, "utf8").replace(/\r/g, "").replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      cols[m[1]] ??= new Set();
      for (const linea of m[2].split(/,\n/)) {
        const c = linea.trim().match(/^(\w+)\s+/);
        if (c && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)$/i.test(c[1])) cols[m[1]].add(c[1]);
      }
    }
    for (const m of sql.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)/gi)) {
      (cols[m[1]] ??= new Set()).add(m[2]);
    }
    for (const m of sql.matchAll(/(?:ADD )?CONSTRAINT (\w+)/gi)) nombres.add(m[1]);
    for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+)/gi)) nombres.add(m[1]);
    for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?VIEW (\w+)/gi)) vistas.add(m[1]);
    for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+)/gi)) funciones.add(m[1]);
  }
  for (const nombre of CREADOS_EN_CODIGO[nodo]) nombres.add(nombre);
  return { cols, nombres, vistas, funciones };
}

async function real(url) {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("set default_transaction_read_only = on");
    const q = async (sql) => (await client.query(sql)).rows;
    return {
      columnas: await q(`select c.table_name, c.column_name from information_schema.columns c
                         join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
                         where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`),
      constraints: await q(`select conrelid::regclass::text as tabla, conname from pg_constraint
                            where connamespace = 'public'::regnamespace and contype in ('c', 'f', 'p', 'u')`),
      indices: await q(`select tablename as tabla, indexname from pg_indexes where schemaname = 'public'`),
      vistas: (await q("select viewname from pg_views where schemaname = 'public'")).map((r) => r.viewname),
      funciones: (await q("select proname from pg_proc where pronamespace = 'public'::regnamespace")).map((r) => r.proname),
    };
  } finally {
    await client.end();
  }
}

// Nombres que PostgreSQL genera solo para restricciones/índices declarados en línea (PRIMARY KEY, REFERENCES, UNIQUE).
const autogenerado = (nombre) => /_(pkey|fkey|key|check)$/.test(nombre);

let diferencias = 0;
function reportar(titulo, items) {
  if (!items.length) return;
  diferencias += items.length;
  console.log(`  ${titulo}:`);
  for (const item of items) console.log(`    - ${item}`);
}

for (const [nodo, url] of [["central", config.centralUrl], ["local", config.localUrl]]) {
  const exp = esperado(nodo);
  const db = await real(url);
  const tablasDb = {};
  for (const r of db.columnas) (tablasDb[r.table_name] ??= new Set()).add(r.column_name);
  console.log(`\n${nodo.toUpperCase()}`);
  const antes = diferencias;

  reportar("Tablas en la base que no están en los scripts", Object.keys(tablasDb).filter((t) => !exp.cols[t]));
  reportar("Tablas de los scripts que faltan en la base", Object.keys(exp.cols).filter((t) => !tablasDb[t]));
  const colsExtra = [];
  const colsFaltan = [];
  for (const [tabla, columnas] of Object.entries(exp.cols)) {
    if (!tablasDb[tabla]) continue;
    for (const c of tablasDb[tabla]) if (!columnas.has(c)) colsExtra.push(`${tabla}.${c}`);
    for (const c of columnas) if (!tablasDb[tabla].has(c)) colsFaltan.push(`${tabla}.${c}`);
  }
  reportar("Columnas en la base que no están en los scripts", colsExtra);
  reportar("Columnas de los scripts que faltan en la base", colsFaltan);

  const tablasConocidas = new Set(Object.keys(exp.cols));
  const nombresDb = [...db.constraints, ...db.indices.map((i) => ({ tabla: i.tabla, conname: i.indexname }))];
  const setDb = new Set(nombresDb.map((n) => n.conname));
  reportar(
    "Restricciones/índices de los scripts que faltan en la base",
    [...exp.nombres].filter((n) => !setDb.has(n)),
  );
  reportar(
    "Restricciones/índices en la base que no están en los scripts",
    nombresDb
      .filter((n) => tablasConocidas.has(n.tabla) && !exp.nombres.has(n.conname) && !autogenerado(n.conname))
      .map((n) => `${n.tabla}: ${n.conname}`),
  );
  reportar("Vistas", [
    ...[...exp.vistas].filter((v) => !db.vistas.includes(v)).map((v) => `falta ${v}`),
    ...db.vistas.filter((v) => !exp.vistas.has(v)).map((v) => `sobra ${v}`),
  ]);
  reportar("Funciones", [
    ...[...exp.funciones].filter((f) => !db.funciones.includes(f)).map((f) => `falta ${f}`),
    ...db.funciones.filter((f) => !exp.funciones.has(f)).map((f) => `sobra ${f}`),
  ]);
  if (diferencias === antes) console.log("  Sin diferencias.");
}

console.log(diferencias ? `\n${diferencias} diferencia(s). Revise si falta subir un script a db/ o aplicarlo en la base.` : "\nLa base coincide con los scripts.");
process.exit(estricto && diferencias ? 1 : 0);
