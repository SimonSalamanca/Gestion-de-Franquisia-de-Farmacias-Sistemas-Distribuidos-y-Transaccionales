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

const local = new pg.Client({
  connectionString: env.LOCAL_DATABASE_URL_UNPOOLED,
  ssl: { rejectUnauthorized: false },
});
await local.connect();
const cols = await local.query(
  "select column_name, is_nullable from information_schema.columns where table_name = 'empleado_ref' order by ordinal_position",
);
console.log("empleado_ref", cols.rows);
const idx = await local.query("select indexname, indexdef from pg_indexes where tablename = 'empleado_ref'");
console.log("idx", idx.rows);
const ca = await local.query("select * from control_acceso");
console.log("local control", ca.rows);
const cur = await local.query("select * from replica_cursor");
console.log("cursor", cur.rows);
const emp = await local.query("select id_empleado, id_tienda, usuario, version_credencial from empleado_ref");
console.log("local emp", emp.rows);
await local.end();

const central = new pg.Client({
  connectionString: env.CENTRAL_DATABASE_URL_UNPOOLED,
  ssl: { rejectUnauthorized: false },
});
await central.connect();
const seq = await central.query(
  "select sequencename from pg_sequences where sequencename like '%snapshot%' or sequencename like '%replica%'",
);
console.log("seqs", seq.rows);
const rev = await central.query(
  "select id_evento, id_tienda_destino, tipo_evento, version_credencial from replica_evento order by id_evento",
);
console.log("eventos", rev.rows);
const cac = await central.query("select * from control_acceso");
console.log("central control", cac.rows);
await central.end();
