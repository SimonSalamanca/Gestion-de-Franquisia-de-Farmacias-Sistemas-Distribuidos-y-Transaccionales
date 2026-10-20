import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function loadEnv() {
  const file = path.join(root, ".env");
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    env[line.slice(0, index)] = line.slice(index + 1).replace(/^"|"$/g, "");
  }
  return env;
}

const env = loadEnv();

export const LOCAL_TIENDA_ID = Number(process.env.LOCAL_TIENDA_ID || 1);
export const runtime = { tiendaId: LOCAL_TIENDA_ID };
export const PEPPER = process.env.AUTH_PEPPER || "farmahub-dev-pepper";

function config(url) {
  return { connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 };
}

export const central = new pg.Pool(config(env.CENTRAL_DATABASE_URL_UNPOOLED || env.CENTRAL_DATABASE_URL));
export const local = new pg.Pool(config(env.LOCAL_DATABASE_URL_UNPOOLED || env.LOCAL_DATABASE_URL));

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
