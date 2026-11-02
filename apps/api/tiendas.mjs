import crypto from "crypto";
import { central, PEPPER, withTx } from "./db.mjs";
import { sesionDe } from "./auth.mjs";
import { estadoReal, link } from "./sync.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status, codigo, mensaje, extra = {}) {
  return { status, body: { codigo, mensaje, ...extra } };
}

function firma(op, body) {
  return crypto.createHmac("sha256", PEPPER).update(`${op}|${JSON.stringify(body)}`).digest("hex");
}

function texto(value, max) {
  const limpio = String(value ?? "").trim();
  if (!limpio || limpio.length > max) return null;
  return limpio;
}

function fecha(value) {
  if (value == null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return undefined;
  return String(value);
}

function entero(value, min = 0) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) return null;
  return n;
}

async function exigir(token, permiso) {
  if (estadoReal() === "offline") {
    return fail(503, "SIN_CONEXION", "sin conexión con el nodo central", {
      estado_real: "offline",
      forzado: link.force,
      ultima_sync: link.ultimaSync,
    });
  }
  const sesion = await sesionDe(token, "central");
  if (!sesion) return fail(401, "SESION", "Sesión inválida o expirada");
  if (!sesion.permisos.includes(permiso)) {
    await central.query(
      `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, detalle)
       values ($1, 'ACCESO_DENEGADO', 'tienda', $2)`,
      [sesion.id_empleado, permiso.slice(0, 400)],
    );
    return fail(403, "ACCESO_DENEGADO", "Su rol no puede ejecutar esta acción");
  }
  return { sesion };
}

async function previa(client, key, hmac) {
  const row = await client.query("select * from tienda_operacion where idempotency_key = $1", [key]);
  if (row.rowCount === 0) return null;
  if (row.rows[0].payload_hmac !== hmac) return fail(409, "IDEMPOTENCY_CONFLICT", "La clave ya se usó con otros datos");
  return { status: row.rows[0].resultado_http, body: row.rows[0].cuerpo_json };
}

async function guardar(client, key, hmac, result) {
  await client.query(
    `insert into tienda_operacion (idempotency_key, payload_hmac, resultado_http, cuerpo_json)
     values ($1, $2, $3, $4::jsonb)`,
    [key, hmac, result.status, JSON.stringify(result.body)],
  );
  return result;
}

async function publicarTienda(client, row) {
  await client.query("select append_replica_evento($1, $2, $3, $4::jsonb)", [
    null,
    "TIENDA_UPSERT",
    Number(row.version_tienda),
    JSON.stringify({
      id_tienda: row.id_tienda,
      nombre: row.nombre,
      activa: row.activa,
    }),
  ]);
}

function tiendaDe(row) {
  return {
    id_tienda: row.id_tienda,
    nombre: row.nombre,
    direccion: row.direccion,
    ciudad: row.ciudad,
    telefono: row.telefono,
    fecha_apertura: row.fecha_apertura,
    activa: row.activa,
    version_tienda: Number(row.version_tienda),
  };
}

async function auditar(client, idEmpleado, accion, idTienda, detalle) {
  await client.query(
    `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
     values ($1, $2, 'tienda', $3, $4)`,
    [idEmpleado, accion, idTienda, String(detalle || "").slice(0, 400)],
  );
}

function datosTienda(body, previaActiva = true) {
  const nombre = texto(body.nombre, 120);
  const direccion = texto(body.direccion, 200);
  const ciudad = texto(body.ciudad, 80);
  if (!nombre || !direccion || !ciudad) return { error: "Nombre, dirección y ciudad son obligatorios" };
  const telefono = body.telefono == null || String(body.telefono).trim() === "" ? null : String(body.telefono).trim();
  if (telefono && telefono.length > 30) return { error: "Teléfono demasiado largo" };
  const apertura = fecha(body.fecha_apertura);
  if (apertura === undefined) return { error: "Fecha de apertura inválida" };
  const activa = body.activa == null ? previaActiva : Boolean(body.activa);
  return { nombre, direccion, ciudad, telefono, apertura, activa };
}

export async function listarTiendas(token) {
  const acceso = await exigir(token, "TIENDA_GESTIONAR");
  if (acceso.status) return acceso;
  const rows = await central.query(
    `select id_tienda, nombre, direccion, ciudad, telefono, fecha_apertura, activa, version_tienda
     from tienda order by nombre, id_tienda`,
  );
  return { status: 200, body: { tiendas: rows.rows.map(tiendaDe) } };
}

export async function crearTienda(token, key, body) {
  const acceso = await exigir(token, "TIENDA_GESTIONAR");
  if (acceso.status) return acceso;
  if (!UUID_RE.test(String(key || ""))) return fail(400, "IDEMPOTENCY", "Falta Idempotency-Key");
  const datos = datosTienda(body, true);
  const hmac = firma("crear", { key, ...body });
  if (datos.error) return fail(400, "DATOS", datos.error);
  try {
    return await withTx(central, async (client) => {
      const ya = await previa(client, key, hmac);
      if (ya) return ya;
      const inserted = await client.query(
        `insert into tienda (nombre, direccion, ciudad, telefono, fecha_apertura, activa)
         values ($1, $2, $3, $4, $5, true)
         returning *`,
        [datos.nombre, datos.direccion, datos.ciudad, datos.telefono, datos.apertura],
      );
      const row = inserted.rows[0];
      await publicarTienda(client, row);
      await auditar(client, acceso.sesion.id_empleado, "TIENDA_CREAR", row.id_tienda, row.nombre);
      return guardar(client, key, hmac, { status: 201, body: { tienda: tiendaDe(row) } });
    });
  } catch (error) {
    if (error.code !== "23505") throw error;
    const prev = await central.query("select * from tienda_operacion where idempotency_key = $1", [key]);
    if (prev.rowCount === 0 || prev.rows[0].payload_hmac !== hmac) {
      return fail(409, "IDEMPOTENCY_CONFLICT", "La clave ya se usó con otros datos");
    }
    return { status: prev.rows[0].resultado_http, body: prev.rows[0].cuerpo_json };
  }
}

export async function editarTienda(token, key, idTienda, body) {
  const acceso = await exigir(token, "TIENDA_GESTIONAR");
  if (acceso.status) return acceso;
  if (!UUID_RE.test(String(key || ""))) return fail(400, "IDEMPOTENCY", "Falta Idempotency-Key");
  const version = entero(body.version_tienda, 1);
  if (!version) return fail(400, "VERSION", "Falta version_tienda");
  const actual = await central.query("select * from tienda where id_tienda = $1", [idTienda]);
  if (actual.rowCount === 0) return fail(404, "TIENDA", "Tienda no existe");
  const datos = datosTienda(body, actual.rows[0].activa);
  if (datos.error) return fail(400, "DATOS", datos.error);
  const hmac = firma("editar", { key, idTienda, ...body });
  return withTx(central, async (client) => {
    const ya = await previa(client, key, hmac);
    if (ya) return ya;
    const updated = await client.query(
      `update tienda
       set nombre = $2, direccion = $3, ciudad = $4, telefono = $5, fecha_apertura = $6,
           activa = $7, version_tienda = version_tienda + 1
       where id_tienda = $1 and version_tienda = $8
       returning *`,
      [idTienda, datos.nombre, datos.direccion, datos.ciudad, datos.telefono, datos.apertura, datos.activa, version],
    );
    if (updated.rowCount === 0) {
      return guardar(client, key, hmac, fail(409, "CONFLICTO", "La tienda cambió en otro puesto. Recargue e intente de nuevo"));
    }
    await publicarTienda(client, updated.rows[0]);
    await auditar(client, acceso.sesion.id_empleado, "TIENDA_EDITAR", idTienda, datos.nombre);
    return guardar(client, key, hmac, { status: 200, body: { tienda: tiendaDe(updated.rows[0]) } });
  });
}

export async function desactivarTienda(token, key, idTienda, body) {
  const acceso = await exigir(token, "TIENDA_GESTIONAR");
  if (acceso.status) return acceso;
  if (!UUID_RE.test(String(key || ""))) return fail(400, "IDEMPOTENCY", "Falta Idempotency-Key");
  const version = entero(body.version_tienda, 1);
  if (!version) return fail(400, "VERSION", "Falta version_tienda");
  const hmac = firma("desactivar", { key, idTienda, version });
  return withTx(central, async (client) => {
    const ya = await previa(client, key, hmac);
    if (ya) return ya;
    const current = await client.query("select * from tienda where id_tienda = $1 for update", [idTienda]);
    if (current.rowCount === 0) return guardar(client, key, hmac, fail(404, "TIENDA", "Tienda no existe"));
    if (Number(current.rows[0].version_tienda) !== version) {
      return guardar(client, key, hmac, fail(409, "CONFLICTO", "La tienda cambió en otro puesto. Recargue e intente de nuevo"));
    }
    if (current.rows[0].activa === false) {
      return guardar(client, key, hmac, { status: 200, body: { tienda: tiendaDe(current.rows[0]) } });
    }
    const updated = await client.query(
      `update tienda set activa = false, version_tienda = version_tienda + 1
       where id_tienda = $1
       returning *`,
      [idTienda],
    );
    await publicarTienda(client, updated.rows[0]);
    await auditar(client, acceso.sesion.id_empleado, "TIENDA_DESACTIVAR", idTienda, updated.rows[0].nombre);
    return guardar(client, key, hmac, { status: 200, body: { tienda: tiendaDe(updated.rows[0]) } });
  });
}

export async function guardarUmbral(token, key, idTienda, body) {
  const acceso = await exigir(token, "TIENDA_GESTIONAR");
  if (acceso.status) return acceso;
  if (!UUID_RE.test(String(key || ""))) return fail(400, "IDEMPOTENCY", "Falta Idempotency-Key");
  const idMedicamento = entero(body.id_medicamento, 1);
  const stock = entero(body.stock_minimo, 0);
  const dias = entero(body.dias_alerta_caducidad, 0);
  if (!idMedicamento || stock == null || dias == null) return fail(400, "DATOS", "Umbral inválido");
  const hmac = firma("umbral", { key, idTienda, idMedicamento, stock, dias });
  return withTx(central, async (client) => {
    const ya = await previa(client, key, hmac);
    if (ya) return ya;
    const tienda = await client.query("select id_tienda from tienda where id_tienda = $1", [idTienda]);
    if (tienda.rowCount === 0) return guardar(client, key, hmac, fail(404, "TIENDA", "Tienda no existe"));
    const med = await client.query("select id_medicamento from medicamento where id_medicamento = $1", [idMedicamento]);
    if (med.rowCount === 0) return guardar(client, key, hmac, fail(404, "MEDICAMENTO", "Medicamento no existe"));
    const saved = await client.query(
      `insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad)
       values ($1, $2, $3, $4)
       on conflict (id_tienda, id_medicamento) do update
       set stock_minimo = excluded.stock_minimo,
           dias_alerta_caducidad = excluded.dias_alerta_caducidad
       returning id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad`,
      [idTienda, idMedicamento, stock, dias],
    );
    await client.query("select append_replica_evento($1, $2, $3, $4::jsonb)", [
      idTienda,
      "UMBRAL_UPSERT",
      1,
      JSON.stringify(saved.rows[0]),
    ]);
    await auditar(client, acceso.sesion.id_empleado, "UMBRAL_CONFIGURAR", idTienda, `med ${idMedicamento}`);
    return guardar(client, key, hmac, { status: 200, body: { umbral: saved.rows[0] } });
  });
}

export async function listarUmbrales(token, idTienda) {
  const acceso = await exigir(token, "TIENDA_GESTIONAR");
  if (acceso.status) return acceso;
  const rows = await central.query(
    `select u.id_tienda, u.id_medicamento, u.stock_minimo, u.dias_alerta_caducidad, m.nombre_comercial
     from umbral_stock u
     join medicamento m on m.id_medicamento = u.id_medicamento
     where u.id_tienda = $1
     order by m.nombre_comercial`,
    [idTienda],
  );
  return { status: 200, body: { umbrales: rows.rows } };
}

export async function disponibilidad(token, query) {
  const acceso = await exigir(token, "RED_VISIBILIDAD");
  if (acceso.status) return acceso;
  const idMedicamento = query.get("id_medicamento");
  const q = String(query.get("q") || "").trim();
  const rows = await central.query(
    `select t.id_tienda, t.nombre, t.ciudad, m.id_medicamento, m.nombre_comercial,
            i.cantidad_disponible, i.fecha_sincronizacion
     from inventario_consolidado i
     join tienda t on t.id_tienda = i.id_tienda and t.activa = true
     join medicamento m on m.id_medicamento = i.id_medicamento
     where ($1::int is null or i.id_medicamento = $1)
       and ($2::text = '' or m.nombre_comercial ilike '%' || $2 || '%' or m.principio_activo ilike '%' || $2 || '%' or m.codigo_interno ilike '%' || $2 || '%')
     order by t.nombre, m.nombre_comercial`,
    [idMedicamento ? Number(idMedicamento) : null, q],
  );
  return { status: 200, body: { disponibilidad: rows.rows } };
}

export async function reporteConsolidado(token) {
  const acceso = await exigir(token, "REPORTE_CONSOLIDADO_VER");
  if (acceso.status) return acceso;
  const rows = await central.query(
    `select t.id_tienda, t.nombre, t.ciudad,
            coalesce(sum(v.total_vendido), 0) as total_vendido,
            coalesce(sum(v.total_facturas), 0) as total_facturas,
            max(v.fecha_sincronizacion) as ultima_sync_tienda,
            count(v.id_venta_consolidada) > 0 as tiene_datos
     from tienda t
     left join venta_consolidada v on v.id_tienda = t.id_tienda
     where t.activa = true
     group by t.id_tienda, t.nombre, t.ciudad
     order by t.nombre`,
  );
  return {
    status: 200,
    body: {
      reporte: rows.rows,
      ultima_sync: link.ultimaSync,
      nota: "Solo tiendas activas. Un total en cero con tiene_datos falso significa que esa tienda aún no consolidó ventas.",
    },
  };
}

export async function listarMedicamentos(token) {
  const acceso = await exigir(token, "TIENDA_GESTIONAR");
  if (acceso.status) return acceso;
  const rows = await central.query(
    `select id_medicamento, codigo_interno, nombre_comercial
     from medicamento where activo = true order by nombre_comercial limit 200`,
  );
  return { status: 200, body: { medicamentos: rows.rows } };
}
