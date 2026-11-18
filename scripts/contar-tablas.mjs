import "./lib/owner.mjs";
// Cuenta las tablas y vistas de cada nodo (central, tienda del .env y, si está configurada, tienda 2). Solo lectura.
// Uso: node scripts/contar-tablas.mjs                                  (conteo)
//      node scripts/contar-tablas.mjs --esperado central=27,local=44   (sale con código 1 si no coincide)
//      node scripts/contar-tablas.mjs --filas archivo.json             (guarda además las filas de cada tabla)
// Respeta FARMAHUB_ENV_FILE (p. ej. .env.rama.local) y su candado de rama.
import fs from "fs";
import pg from "pg";
import { config, loadEnv } from "../apps/api/config.mjs";

const args = process.argv.slice(2);
const valor = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const esperado = Object.fromEntries(
  (valor("--esperado") || "")
    .split(",")
    .filter(Boolean)
    .map((par) => par.split("=").map((s) => s.trim()))
    .map(([nodo, n]) => [nodo, Number(n)]),
);
const archivoFilas = valor("--filas");

const env = loadEnv();
const nodos = [
  ["central", "central", config.centralUrl],
  ["tienda", "local", config.localUrl],
];
const tienda2 = env.LOCAL_DATABASE_URL_UNPOOLED_TIENDA2 || env.LOCAL_DATABASE_URL_TIENDA2;
if (tienda2) nodos.push(["tienda2", "local", tienda2]);

const foto = {};
let fallos = 0;
for (const [nombre, tipo, url] of nodos) {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("set default_transaction_read_only = on");
    const tablas = (
      await client.query(
        "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
      )
    ).rows.map((r) => r.table_name);
    const vistas = (await client.query("select viewname from pg_views where schemaname = 'public' order by 1")).rows.map((r) => r.viewname);
    const filas = {};
    if (archivoFilas) {
      for (const t of tablas) filas[t] = Number((await client.query(`select count(*) as n from "${t}"`)).rows[0].n);
    }
    foto[nombre] = { endpoint: new URL(url).hostname.split(".")[0].replace(/-pooler$/, ""), tablas: tablas.length, vistas, filas };
    const meta = esperado[tipo];
    const ok = meta === undefined || meta === tablas.length;
    if (!ok) fallos++;
    console.log(`${nombre.padEnd(8)} ${foto[nombre].endpoint.padEnd(28)} tablas ${String(tablas.length).padStart(3)}  vistas ${vistas.length}${meta === undefined ? "" : ok ? "  OK" : `  ESPERADO ${meta}`}`);
  } finally {
    await client.end();
  }
}

if (archivoFilas) {
  fs.writeFileSync(archivoFilas, JSON.stringify({ tomado_en: new Date().toISOString(), nodos: foto }, null, 2));
  console.log(`Filas por tabla guardadas en ${archivoFilas}`);
}
process.exit(fallos ? 1 : 0);
