import pg from "pg";
import { config, loadEnv } from "./config.mjs";

export { loadEnv };

// Las columnas "timestamp without time zone" guardan hora UTC (Neon corre en GMT).
// Sin esto, node-pg las interpreta como hora local de la máquina y las desplaza.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (value) =>
  value === "infinity" || value === "-infinity" ? value : new Date(`${value.replace(" ", "T")}Z`),
);
pg.defaults.parseInputDatesAsUTC = true;
// Las columnas "date" (p. ej. fecha_caducidad) se leen como texto AAAA-MM-DD: un Date de JavaScript
// las pondría a medianoche local y podría correr el día.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const LOCAL_TIENDA_ID = config.tiendaId;
export const runtime = { tiendaId: LOCAL_TIENDA_ID };
export const PEPPER = config.pepper;

// Abrir una conexión TLS hacia Neon cuesta ~0,8 s: se conservan las conexiones inactivas 2 minutos
// (el valor por defecto de pg es 10 s) y keepAlive detecta las que Neon cierre por su lado.
function poolConfig(url) {
  return { connectionString: url, ssl: { rejectUnauthorized: false }, max: 4, idleTimeoutMillis: 120000, keepAlive: true };
}

function crearPool(nombre, url) {
  const pool = new pg.Pool(poolConfig(url));
  // Neon cierra conexiones inactivas; sin este handler el proceso se cae.
  pool.on("error", (error) => console.error(`pool ${nombre}:`, error.message));
  return pool;
}

export const central = crearPool("central", config.centralUrl);
export const local = crearPool("local", config.localUrl);

export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
