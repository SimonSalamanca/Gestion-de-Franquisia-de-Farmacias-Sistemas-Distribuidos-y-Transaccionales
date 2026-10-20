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

async function dump(name, key, queries) {
  const client = new Client({
    connectionString: env[key],
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("\n==", name, "==");
  for (const [label, sql] of queries) {
    const result = await client.query(sql);
    console.log("--", label, result.rows.length);
    console.log(JSON.stringify(result.rows, null, 2));
  }
  await client.end();
}

await dump("central", "CENTRAL_DATABASE_URL_UNPOOLED", [
  ["roles", "select id_rol, nombre from rol order by id_rol"],
  ["permisos", "select id_permiso, codigo from permiso order by id_permiso"],
  ["rol_permiso", "select rp.id_rol, r.nombre, p.codigo from rol_permiso rp join rol r on r.id_rol = rp.id_rol join permiso p on p.id_permiso = rp.id_permiso order by 1, 3"],
  ["tiendas", "select id_tienda, nombre, ciudad, activa from tienda order by id_tienda"],
  ["empleados", "select id_empleado, id_tienda, id_rol, nombre_completo, usuario, activo, fecha_baja, length(contrasena_hash) as hash_len, left(contrasena_hash, 4) as hash_pref from empleado order by id_empleado"],
]);

await dump("local", "LOCAL_DATABASE_URL_UNPOOLED", [
  ["roles", "select id_rol, nombre from rol_ref order by id_rol"],
  ["tiendas", "select id_tienda, nombre, activa, es_tienda_local from tienda_ref order by id_tienda"],
  ["empleados", "select id_empleado, id_rol, nombre_completo, usuario, activo, contrasena_hash is null as hash_null from empleado_ref order by id_empleado"],
]);
