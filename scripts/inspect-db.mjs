import fs from "fs";
import pg from "pg";

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "")];
    }),
);

const { Client } = pg;

for (const [name, key] of [
  ["central", "CENTRAL_DATABASE_URL_UNPOOLED"],
  ["local", "LOCAL_DATABASE_URL_UNPOOLED"],
]) {
  const client = new Client({
    connectionString: env[key],
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    const db = await client.query("select current_database() as db");
    const tables = await client.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
    );
    console.log(name, db.rows[0].db, "tables", tables.rows.length);
    console.log(tables.rows.map((row) => row.table_name).join(", ") || "(none)");
  } catch (error) {
    console.log(name, "ERROR", error.message);
  } finally {
    await client.end().catch(() => {});
  }
}
