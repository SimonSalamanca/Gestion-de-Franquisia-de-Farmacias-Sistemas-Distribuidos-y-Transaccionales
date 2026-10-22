import fs from "fs";
import path from "path";
import { central, local, runtime } from "./db.mjs";
import { config, ROOT } from "./config.mjs";
import { hashPassword } from "./crypto.mjs";

const dbDir = path.join(ROOT, "db");

// Scripts por nodo en db/<nodo>/NN_nombre.sql, aplicados en orden alfabético.
// 00_base.sql crea el esquema y solo corre si la base está vacía (no es idempotente).
// Todos los demás deben ser idempotentes: se ejecutan en cada arranque.
const NODOS = {
  central: { pool: central, carpeta: "central", tablaBase: "empleado" },
  local: { pool: local, carpeta: "local", tablaBase: "empleado_ref" },
};

const LOCK_MIGRACION = 814207;

const DEMO_PASSWORD = "Farma123";

const DEMO_USERS = [
  {
    usuario: "cajero1",
    nombre: "Ana Ruiz",
    rol: "cajero",
    correo: "ana.ruiz@farmahub.local",
  },
  {
    usuario: "admin.tienda",
    nombre: "Luis Mora",
    rol: "administrador_tienda",
    correo: "luis.mora@farmahub.local",
  },
  {
    usuario: "admin.general",
    nombre: "Carmen Díaz",
    rol: "administrador_general",
    correo: "carmen.diaz@farmahub.local",
  },
];

export function scriptsDe(nodo) {
  const carpeta = path.join(dbDir, NODOS[nodo].carpeta);
  return fs
    .readdirSync(carpeta)
    .filter((file) => /^\d{2,}_[\w-]+\.sql$/.test(file))
    .sort()
    .map((file) => ({ file, base: file.startsWith("00_"), ruta: path.join(carpeta, file) }));
}

async function aplicarScripts(nodo) {
  const { pool, tablaBase } = NODOS[nodo];
  const client = await pool.connect();
  try {
    // Evita que dos procesos apliquen scripts a la vez sobre la misma base.
    await client.query("select pg_advisory_lock($1)", [LOCK_MIGRACION]);
    const existe = await client.query("select to_regclass($1) is not null as ok", [`public.${tablaBase}`]);
    const aplicados = [];
    for (const script of scriptsDe(nodo)) {
      if (script.base && existe.rows[0].ok) continue;
      await client.query(fs.readFileSync(script.ruta, "utf8"));
      aplicados.push(script.file);
    }
    return aplicados;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_MIGRACION]).catch(() => {});
    client.release();
  }
}

async function seedCentral() {
  await central.query(
    `insert into tienda (nombre, direccion, ciudad, telefono, activa)
     select $1::varchar, $2::varchar, $3::varchar, $4::varchar, true
     where not exists (select 1 from tienda where nombre = $5::varchar)`,
    ["Farmacia Centro", "Calle 72 #10-20", "Bogotá", "6015550101", "Farmacia Centro"],
  );

  const tienda = await central.query(
    "select id_tienda from tienda where nombre = $1 order by id_tienda limit 1",
    ["Farmacia Centro"],
  );
  const idTienda = tienda.rows[0].id_tienda;

  for (const user of DEMO_USERS) {
    const exists = await central.query("select id_empleado from empleado where usuario = $1", [user.usuario]);
    if (exists.rowCount > 0) continue;
    const rol = await central.query("select id_rol from rol where nombre = $1", [user.rol]);
    if (rol.rowCount === 0) throw new Error(`Rol no encontrado: ${user.rol}`);
    await central.query(
      `insert into empleado (id_tienda, id_rol, nombre_completo, usuario, contrasena_hash, correo, activo, version_credencial)
       values ($1, $2, $3, $4, $5, $6, true, 1)`,
      [idTienda, rol.rows[0].id_rol, user.nombre, user.usuario, hashPassword(DEMO_PASSWORD), user.correo],
    );
  }

  return idTienda;
}

// Catálogo global (tienda, roles, permisos): una sola vez, cuando el log está vacío.
// Una tienda que se une después lo recibe igual, porque lee el log desde el evento 1.
async function emitirCatalogoGlobal(client, idTienda) {
  const already = await client.query("select count(*)::int as n from replica_evento");
  if (already.rows[0].n > 0) return;
  const tienda = await client.query(
    "select id_tienda, nombre, activa from tienda where id_tienda = $1",
    [idTienda],
  );
  await client.query("select append_replica_evento($1, $2, $3, $4::jsonb)", [
    null,
    "TIENDA_UPSERT",
    1,
    JSON.stringify({ ...tienda.rows[0], es_tienda_local: true }),
  ]);

  const roles = await client.query("select id_rol, nombre from rol order by id_rol");
  for (const rol of roles.rows) {
    await client.query("select append_replica_evento($1, $2, $3, $4::jsonb)", [
      null,
      "ROL_UPSERT",
      1,
      JSON.stringify(rol),
    ]);
  }

  const permisos = await client.query("select id_permiso, codigo, descripcion from permiso order by id_permiso");
  for (const permiso of permisos.rows) {
    await client.query("select append_replica_evento($1, $2, $3, $4::jsonb)", [
      null,
      "PERMISO_UPSERT",
      1,
      JSON.stringify(permiso),
    ]);
  }

  for (const rol of roles.rows) {
    const codes = await client.query(
      `select p.id_permiso, p.codigo
       from rol_permiso rp
       join permiso p on p.id_permiso = rp.id_permiso
       where rp.id_rol = $1
       order by p.codigo`,
      [rol.id_rol],
    );
    await client.query("select append_replica_evento($1, $2, $3, $4::jsonb)", [
      null,
      "ROL_PERMISO_SET",
      1,
      JSON.stringify({ id_rol: rol.id_rol, permisos: codes.rows }),
    ]);
  }
}

// Empleados de la tienda que todavía no tienen ningún EMPLEADO_UPSERT en el log.
// Antes solo se emitían junto con el catálogo inicial, así que una tienda nueva nunca recibía los suyos.
async function emitirEmpleadosPendientes(client, idTienda) {
  const empleados = await client.query(
    `select e.id_empleado, e.id_tienda, e.id_rol, e.nombre_completo, e.usuario, e.activo, e.contrasena_hash,
            e.fecha_baja, e.version_credencial
     from empleado e
     where e.id_tienda = $1
       and not exists (
         select 1 from replica_evento r
         where r.tipo_evento = 'EMPLEADO_UPSERT'
           and (r.payload ->> 'id_empleado')::integer = e.id_empleado
       )
     order by e.id_empleado`,
    [idTienda],
  );
  for (const empleado of empleados.rows) {
    await client.query("select append_replica_evento($1, $2, $3, $4::jsonb)", [
      empleado.id_tienda,
      "EMPLEADO_UPSERT",
      empleado.version_credencial,
      JSON.stringify(empleado),
    ]);
  }
  return empleados.rowCount;
}

async function emitCatalog(idTienda) {
  const client = await central.connect();
  try {
    await client.query("begin");
    await emitirCatalogoGlobal(client, idTienda);
    await emitirEmpleadosPendientes(client, idTienda);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function asegurarUsuarioUnico() {
  const dups = await local.query(
    "select usuario from empleado_ref group by usuario having count(*) > 1",
  );
  if (dups.rowCount === 0) {
    await local.query("create unique index if not exists empleado_ref_usuario_key on empleado_ref (usuario)");
    return;
  }
  try {
    await central.query("select 1");
  } catch {
    console.error("HU-06: usuario duplicado y central no disponible; no se crea UNIQUE");
    return;
  }
  await local.query("drop index if exists empleado_ref_usuario_key");
  for (const dup of dups.rows) {
    const centralRow = await central.query("select id_empleado from empleado where usuario = $1", [dup.usuario]);
    if (centralRow.rowCount !== 1) {
      console.error(`HU-06: sin par central para ${dup.usuario}; no se crea UNIQUE`);
      return;
    }
    const keep = centralRow.rows[0].id_empleado;
    const localKeep = await local.query(
      "select 1 from empleado_ref where usuario = $1 and id_empleado = $2",
      [dup.usuario, keep],
    );
    if (localKeep.rowCount === 0) {
      console.error(`HU-06: la fila central no está en local para ${dup.usuario}; no se crea UNIQUE`);
      return;
    }
    const extras = await local.query(
      "select * from empleado_ref where usuario = $1 and id_empleado <> $2",
      [dup.usuario, keep],
    );
    for (const row of extras.rows) {
      await local.query(
        `insert into empleado_ref_cuarentena (
           id_empleado, id_rol, id_tienda, nombre_completo, usuario, activo, contrasena_hash, version_credencial, motivo
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'duplicado de usuario')`,
        [
          row.id_empleado,
          row.id_rol,
          row.id_tienda,
          row.nombre_completo,
          row.usuario,
          row.activo,
          row.contrasena_hash,
          row.version_credencial,
        ],
      );
      await local.query("delete from sesion_activa where id_empleado = $1", [row.id_empleado]);
      await local.query("delete from control_acceso where id_empleado = $1", [row.id_empleado]);
      await local.query("delete from registro_actividad where id_empleado = $1", [row.id_empleado]);
      await local.query("delete from empleado_ref where id_empleado = $1", [row.id_empleado]);
    }
  }
  const still = await local.query("select usuario from empleado_ref group by usuario having count(*) > 1");
  if (still.rowCount === 0) {
    await local.query("create unique index if not exists empleado_ref_usuario_key on empleado_ref (usuario)");
  }
}

async function backfillTienda() {
  const missing = await local.query("select id_empleado from empleado_ref where id_tienda is null");
  for (const row of missing.rows) {
    const centralRow = await central.query("select id_tienda from empleado where id_empleado = $1", [row.id_empleado]);
    if (centralRow.rowCount === 1) {
      await local.query("update empleado_ref set id_tienda = $2 where id_empleado = $1", [
        row.id_empleado,
        centralRow.rows[0].id_tienda,
      ]);
    }
  }
  const nulls = await local.query("select count(*)::int as n from empleado_ref where id_tienda is null");
  if (nulls.rows[0].n === 0) {
    await local.query("alter table empleado_ref alter column id_tienda set not null");
  }
}

export async function migrate({ log = () => {} } = {}) {
  const enCentral = await aplicarScripts("central");
  const enLocal = await aplicarScripts("local");
  log(`scripts central: ${enCentral.join(", ") || "-"} | local: ${enLocal.join(", ") || "-"}`);
  await asegurarUsuarioUnico();
  await backfillTienda();
  if (config.seedDemo) {
    const idDemo = await seedCentral();
    if (idDemo !== config.tiendaId) {
      console.warn(`SEED_DEMO: los usuarios demo están en la tienda ${idDemo}, pero LOCAL_TIENDA_ID=${config.tiendaId}.`);
    }
  }
  // La identidad del nodo viene de LOCAL_TIENDA_ID, no de la semilla.
  const idTienda = config.tiendaId;
  const existe = await centralTienda(idTienda);
  if (!existe) console.warn(`LOCAL_TIENDA_ID=${idTienda} no existe en el nodo central.`);
  runtime.tiendaId = idTienda;
  await localCursor(idTienda);
  if (existe) await emitCatalog(idTienda);
  return idTienda;
}

async function centralTienda(idTienda) {
  const result = await NODOS.central.pool.query("select 1 from tienda where id_tienda = $1", [idTienda]);
  return result.rowCount === 1;
}

async function localCursor(idTienda) {
  await NODOS.local.pool.query(
    "insert into replica_cursor (id_tienda) values ($1) on conflict (id_tienda) do nothing",
    [idTienda],
  );
}

export { DEMO_PASSWORD, DEMO_USERS };
