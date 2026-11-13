// Escrituras de las pruebas sobre el nodo central (docs/seguridad/escritura-central.md).
// Regla: en el central, todo cambio que se replica a las tiendas publica su evento en la MISMA transacción. Por eso las
// pruebas no hacen UPDATE/INSERT/DELETE directos sobre el catálogo, el personal, las tiendas, los precios, los permisos
// ni los bloqueos de acceso: usan estas funciones. Los resets de estado que NO se replican (política de acceso, reservas
// de recetas, consolidado de inventario) están aquí, marcados como tales.
// Requiere FARMAHUB_ROL=owner (scripts/lib/owner.mjs), porque las pruebas limpian datos.
import { central } from "../../apps/api/db.mjs";
import { aplicarEnCentral } from "../../apps/api/sync/central.mjs";

async function conTx(fn) {
  const cliente = await central.connect();
  try {
    await cliente.query("begin");
    const r = await fn(cliente);
    await cliente.query("commit");
    return r;
  } catch (error) {
    await cliente.query("rollback").catch(() => {});
    throw error;
  } finally {
    cliente.release();
  }
}

const publicar = (cliente, idTienda, tipo, version, payload) =>
  cliente.query("select append_replica_evento($1, $2, $3, $4::jsonb)", [idTienda, tipo, version, JSON.stringify(payload)]);

// ---- Catálogo ----

const COLUMNAS_MEDICAMENTO = "id_medicamento, codigo_interno, nombre_comercial, principio_activo, id_categoria, requiere_receta, requiere_refrigeracion, activo, tasa_impuesto";

// Da de baja los medicamentos que cumplen la condición (sin borrarlos: sus facturas los referencian) y publica cada cambio.
export function desactivarMedicamentos(condicion, valores = []) {
  return conTx(async (cliente) => {
    const filas = await cliente.query(`update medicamento set activo = false where ${condicion} returning ${COLUMNAS_MEDICAMENTO}`, valores);
    for (const fila of filas.rows) await publicar(cliente, null, "MEDICAMENTO_UPSERT", 1, fila);
    return filas.rowCount;
  });
}

// Crea un medicamento de prueba con su umbral en cada tienda activa, y publica ambos.
export function crearMedicamentoPrueba({ codigo, nombre, principio = "prueba", requiereReceta = false, tasa = 0 }) {
  return conTx(async (cliente) => {
    const med = await cliente.query(
      `insert into medicamento (codigo_interno, nombre_comercial, principio_activo, requiere_receta, tasa_impuesto)
       values ($1, $2, $3, $4, $5) returning ${COLUMNAS_MEDICAMENTO}`,
      [codigo, nombre, principio, requiereReceta, tasa],
    );
    const fila = med.rows[0];
    await publicar(cliente, null, "MEDICAMENTO_UPSERT", 1, fila);
    const umbrales = await cliente.query(
      `insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad)
       select t.id_tienda, $1, 0, 30 from tienda t where t.activa returning id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad`,
      [fila.id_medicamento],
    );
    for (const u of umbrales.rows) await publicar(cliente, u.id_tienda, "UMBRAL_UPSERT", 1, u);
    return fila.id_medicamento;
  });
}

// Publica el alta de un medicamento creado en la prueba (y sus umbrales). Va justo después de su INSERT, así el medicamento
// llega al log antes que sus precios (las tiendas no aceptan un precio de un medicamento que no conocen).
export function publicarAltaMedicamento(idMedicamento) {
  return conTx(async (cliente) => {
    const med = await cliente.query(`select ${COLUMNAS_MEDICAMENTO} from medicamento where id_medicamento = $1`, [idMedicamento]);
    await publicar(cliente, null, "MEDICAMENTO_UPSERT", 1, med.rows[0]);
    const umbrales = await cliente.query(
      "select id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad from umbral_stock where id_medicamento = $1",
      [idMedicamento],
    );
    for (const u of umbrales.rows) await publicar(cliente, u.id_tienda, "UMBRAL_UPSERT", 1, u);
    return med.rowCount;
  });
}

// Da de baja proveedores (no se borran: los lotes y pedidos los referencian).
export function desactivarProveedores(condicion, valores = []) {
  return conTx(async (cliente) => {
    const filas = await cliente.query(
      `update proveedor set activo = false where ${condicion} returning id_proveedor, nombre_empresa, nit, telefono, correo, direccion, activo`,
      valores,
    );
    for (const fila of filas.rows) await publicar(cliente, null, "PROVEEDOR_UPSERT", 1, fila);
    return filas.rowCount;
  });
}

// Cuenta de prueba (con su alta publicada a la tienda de la cuenta).
export function crearEmpleadoPrueba({ usuario, nombre, idRol, idTienda = 1, hash }) {
  return conTx(async (cliente) => {
    const r = await cliente.query(
      `insert into empleado (id_tienda, id_rol, nombre_completo, usuario, contrasena_hash, correo, activo, version_credencial)
       values ($1, $2, $3, $4, $5, null, true, 1)
       returning id_empleado, id_tienda, id_rol, nombre_completo, usuario, activo, contrasena_hash, fecha_baja, version_credencial`,
      [idTienda, idRol, nombre, usuario, hash],
    );
    await publicar(cliente, r.rows[0].id_tienda, "EMPLEADO_UPSERT", 1, r.rows[0]);
    return r.rows[0].id_empleado;
  });
}

// ---- Tiendas ----

export function desactivarTiendaCentral(idTienda) {
  return conTx(async (cliente) => {
    const fila = await cliente.query("update tienda set activa = false, version_tienda = version_tienda + 1 where id_tienda = $1 returning id_tienda, nombre, activa, version_tienda", [idTienda]);
    if (fila.rowCount === 0) return 0;
    await publicar(cliente, null, "TIENDA_UPSERT", Number(fila.rows[0].version_tienda), { id_tienda: fila.rows[0].id_tienda, nombre: fila.rows[0].nombre, activa: false });
    return 1;
  });
}

// ---- Precios ----

// Registra un precio que empieza en el instante indicado (SQL) y recalcula el fin de los periodos, publicando lo que cambia.
export function registrarPrecioCentral({ idMedicamento, precio, inicioSql = "now()::timestamp - interval '1 hour'" }) {
  return conTx(async (cliente) => {
    const nuevo = await cliente.query(
      `insert into precio_medicamento (id_medicamento, precio, fecha_inicio_vigencia) values ($1, $2, ${inicioSql}) returning id_precio`,
      [idMedicamento, precio],
    );
    const cambiadas = await cliente.query(
      `update precio_medicamento p set fecha_fin_vigencia = s.siguiente
       from (select id_precio, lead(fecha_inicio_vigencia) over (order by fecha_inicio_vigencia) as siguiente
             from precio_medicamento where id_medicamento = $1) s
       where p.id_precio = s.id_precio and p.fecha_fin_vigencia is distinct from s.siguiente
       returning p.id_precio`,
      [idMedicamento],
    );
    const ids = [...new Set([nuevo.rows[0].id_precio, ...cambiadas.rows.map((r) => r.id_precio)])];
    const filas = await cliente.query(
      `select p.id_precio, p.id_medicamento, p.precio, p.fecha_inicio_vigencia, p.fecha_fin_vigencia, p.id_empleado_registro, e.nombre_completo as registrado_por
       from precio_medicamento p left join empleado e on e.id_empleado = p.id_empleado_registro where p.id_precio = any($1::int[])`,
      [ids],
    );
    for (const fila of filas.rows) await publicar(cliente, null, "PRECIO_UPSERT", 1, fila);
    return nuevo.rows[0].id_precio;
  });
}

// ---- Personal y accesos ----

// Da de baja una cuenta: se marca inactiva, se sube la versión de la credencial y la tienda recibe el cambio.
export function desactivarEmpleado(idEmpleado) {
  return conTx(async (cliente) => {
    const fila = await cliente.query(
      `update empleado set activo = false, fecha_baja = coalesce(fecha_baja, now()), version_credencial = version_credencial + 1
       where id_empleado = $1 returning id_empleado, id_tienda, id_rol, nombre_completo, usuario, activo, contrasena_hash, fecha_baja, version_credencial`,
      [idEmpleado],
    );
    if (fila.rowCount === 0) return 0;
    const e = fila.rows[0];
    await publicar(cliente, e.id_tienda, "EMPLEADO_UPSERT", e.version_credencial, e);
    await cliente.query("select publicar_snapshot($1, true)", [idEmpleado]);
    return 1;
  });
}

export function fijarVersionCredencial(idEmpleado, version) {
  return conTx(async (cliente) => {
    const fila = await cliente.query(
      `update empleado set version_credencial = $2 where id_empleado = $1
       returning id_empleado, id_tienda, id_rol, nombre_completo, usuario, activo, contrasena_hash, fecha_baja, version_credencial`,
      [idEmpleado, version],
    );
    const e = fila.rows[0];
    await publicar(cliente, e.id_tienda, "EMPLEADO_UPSERT", e.version_credencial, e);
  });
}

// Estado de bloqueo de una cuenta: se limpia (o se fija) y se publica el snapshot de acceso a sus tiendas.
export function fijarEstadoAcceso(idEmpleado, { control = null, bloqueos = false, revocar = false } = {}) {
  return conTx(async (cliente) => {
    if (bloqueos) await cliente.query("delete from bloqueo_canonico where id_empleado = $1", [idEmpleado]);
    await cliente.query("delete from control_acceso where id_empleado = $1", [idEmpleado]);
    if (control) {
      await cliente.query("insert into control_acceso (id_empleado, epoch, intentos_en_epoch, estado) values ($1, $2, $3, $4)", [
        idEmpleado,
        control.epoch,
        control.intentos,
        control.estado,
      ]);
    }
    if (revocar) await cliente.query("delete from sesion_activa where id_empleado = $1", [idEmpleado]);
    await cliente.query("select publicar_snapshot($1, $2)", [idEmpleado, revocar]);
  });
}

// Quita un permiso de un rol y publica la lista completa del rol (ROL_PERMISO_SET reemplaza todo el rol).
export function quitarPermisoRol(idRol, idPermiso) {
  return conTx(async (cliente) => {
    await cliente.query("delete from rol_permiso where id_rol = $1 and id_permiso = $2", [idRol, idPermiso]);
    const permisos = await cliente.query(
      `select p.id_permiso, p.codigo from rol_permiso rp join permiso p on p.id_permiso = rp.id_permiso where rp.id_rol = $1 order by p.codigo`,
      [idRol],
    );
    await publicar(cliente, null, "ROL_PERMISO_SET", 1, { id_rol: idRol, permisos: permisos.rows });
  });
}

// Dato heredado que no cumple la regla de umbrales (la restricción se apaga un instante, solo para simularlo). Se confirma y
// se publica, igual que cualquier alta: las tiendas deben recibirlo.
export function crearMedicamentoHeredado({ codigo, nombre, unidadesEnRed = 0, idTienda = 1 }) {
  return conTx(async (cliente) => {
    await cliente.query("alter table medicamento disable trigger medicamento_con_umbral");
    const r = await cliente.query(
      `insert into medicamento (codigo_interno, nombre_comercial, principio_activo) values ($1, $2, 'heredado') returning ${COLUMNAS_MEDICAMENTO}`,
      [codigo, nombre],
    );
    await cliente.query("alter table medicamento enable trigger medicamento_con_umbral");
    await publicar(cliente, null, "MEDICAMENTO_UPSERT", 1, r.rows[0]);
    if (unidadesEnRed > 0) {
      await cliente.query(
        "insert into inventario_consolidado (id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion) values ($1, $2, $3, now())",
        [idTienda, r.rows[0].id_medicamento, unidadesEnRed],
      );
    }
    return r.rows[0].id_medicamento;
  });
}

// ---- Intentos que la base debe rechazar ----

// Intenta crear un medicamento activo sin umbral (o una tienda activa sin umbrales). La base lo rechaza al confirmar; la
// transacción se deshace siempre, así que nada queda guardado.
export async function intentarCrearSinUmbral({ tipo, codigo, nombre }) {
  const cliente = await central.connect();
  try {
    await cliente.query("begin");
    if (tipo === "medicamento") {
      await cliente.query("insert into medicamento (codigo_interno, nombre_comercial, principio_activo) values ($1, $2, 'sin umbral')", [codigo, nombre]);
    } else {
      await cliente.query(
        "insert into tienda (nombre, direccion, ciudad, telefono, fecha_apertura, activa) values ($1, 'Calle 1', 'Bogotá', '6010000000', current_date, true)",
        [nombre],
      );
    }
    await cliente.query("commit");
    return { ok: true };
  } catch (error) {
    await cliente.query("rollback").catch(() => {});
    return { ok: false, code: error.code, message: error.message };
  } finally {
    cliente.release();
  }
}

// Concede un permiso a un rol y publica la lista completa del rol.
export function concederPermisoRol(idRol, idPermiso) {
  return conTx(async (cliente) => {
    await cliente.query("insert into rol_permiso (id_rol, id_permiso) values ($1, $2) on conflict do nothing", [idRol, idPermiso]);
    const permisos = await cliente.query(
      `select p.id_permiso, p.codigo from rol_permiso rp join permiso p on p.id_permiso = rp.id_permiso where rp.id_rol = $1 order by p.codigo`,
      [idRol],
    );
    await publicar(cliente, null, "ROL_PERMISO_SET", 1, { id_rol: idRol, permisos: permisos.rows });
  });
}

// Ajusta el control de acceso de una cuenta y publica el snapshot de acceso a sus tiendas.
export function ajustarControlAcceso(idEmpleado, { epoch, intentos, estado, bloqueadoHastaSql } = {}) {
  return conTx(async (cliente) => {
    const asignaciones = [];
    const valores = [idEmpleado];
    if (epoch !== undefined) { valores.push(epoch); asignaciones.push(`epoch = $${valores.length}`); }
    if (intentos !== undefined) { valores.push(intentos); asignaciones.push(`intentos_en_epoch = $${valores.length}`); }
    if (estado !== undefined) { valores.push(estado); asignaciones.push(`estado = $${valores.length}`); }
    if (bloqueadoHastaSql !== undefined) asignaciones.push(`bloqueado_hasta = ${bloqueadoHastaSql}`);
    if (asignaciones.length) await cliente.query(`update control_acceso set ${asignaciones.join(", ")} where id_empleado = $1`, valores);
    await cliente.query("select publicar_snapshot($1, false)", [idEmpleado]);
  });
}

// Aplica en el central una respuesta de una tienda, con la misma función que usa la aplicación (una vez por evento).
export async function aplicarRespuestaCentral(idTienda, evento) {
  const cliente = await central.connect();
  try {
    await cliente.query("begin");
    await aplicarEnCentral(cliente, idTienda, evento);
    await cliente.query("commit");
  } catch (error) {
    await cliente.query("rollback").catch(() => {});
    throw error;
  } finally {
    cliente.release();
  }
}

// Repara el log: publica el estado actual de cada registro que el último evento no refleja (el caso de los cambios que se
// hicieron sin evento). Lo usa scripts/reparar-eventos.mjs; después scripts/verificar-eventos.mjs debe dar cero.
export function repararEventos() {
  return conTx(async (cliente) => {
    const contar = { medicamentos: 0, empleados: 0, precios: 0 };
    const medicamentos = await cliente.query(
      `with ult as (select distinct on ((payload->>'id_medicamento')::int) (payload->>'id_medicamento')::int k, (payload->>'activo')::boolean act
                    from replica_evento where tipo_evento = 'MEDICAMENTO_UPSERT' order by (payload->>'id_medicamento')::int, id_evento desc)
       select m.* from medicamento m left join ult u on u.k = m.id_medicamento
       where u.k is null or u.act is distinct from m.activo`,
    );
    for (const m of medicamentos.rows) {
      await publicar(cliente, null, "MEDICAMENTO_UPSERT", 1, {
        id_medicamento: m.id_medicamento, codigo_interno: m.codigo_interno, nombre_comercial: m.nombre_comercial, principio_activo: m.principio_activo,
        id_categoria: m.id_categoria, requiere_receta: m.requiere_receta, requiere_refrigeracion: m.requiere_refrigeracion, activo: m.activo, tasa_impuesto: m.tasa_impuesto,
      });
      contar.medicamentos += 1;
    }
    const personal = await cliente.query(
      `with ult as (select distinct on ((payload->>'id_empleado')::int) (payload->>'id_empleado')::int k, payload
                    from replica_evento where tipo_evento = 'EMPLEADO_UPSERT' order by (payload->>'id_empleado')::int, id_evento desc)
       select e.id_empleado, e.id_tienda, e.id_rol, e.nombre_completo, e.usuario, e.activo, e.contrasena_hash, e.fecha_baja, e.version_credencial
       from empleado e left join ult u on u.k = e.id_empleado
       where u.k is null or u.payload->>'activo' is distinct from e.activo::text or u.payload->>'version_credencial' is distinct from e.version_credencial::text`,
    );
    for (const e of personal.rows) {
      await publicar(cliente, e.id_tienda, "EMPLEADO_UPSERT", e.version_credencial, e);
      contar.empleados += 1;
    }
    const precios = await cliente.query(
      `with ult as (select distinct on ((payload->>'id_precio')::int) (payload->>'id_precio')::int k, payload
                    from replica_evento where tipo_evento = 'PRECIO_UPSERT' order by (payload->>'id_precio')::int, id_evento desc)
       select p.id_precio, p.id_medicamento, p.precio, p.fecha_inicio_vigencia, p.fecha_fin_vigencia, p.id_empleado_registro, e.nombre_completo as registrado_por
       from precio_medicamento p left join empleado e on e.id_empleado = p.id_empleado_registro left join ult u on u.k = p.id_precio
       where u.k is null or u.payload->>'precio' is distinct from p.precio::text
          or (u.payload->>'fecha_fin_vigencia')::timestamp is distinct from date_trunc('milliseconds', p.fecha_fin_vigencia)`,
    );
    for (const p of precios.rows) {
      await publicar(cliente, null, "PRECIO_UPSERT", 1, p);
      contar.precios += 1;
    }
    return contar;
  });
}

// ---- Estado que NO se replica (solo el central) ----

// Consolidado de stock de una tienda para un medicamento. Lo reconstruye la foto de stock; no se replica.
export const fijarConsolidadoTienda = (idTienda, idMedicamento, cantidad) =>
  central.query(
    `insert into inventario_consolidado (id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion)
     values ($1, $2, $3, now())
     on conflict (id_tienda, id_medicamento) do update set cantidad_disponible = excluded.cantidad_disponible`,
    [idTienda, idMedicamento, cantidad],
  );

// Política de intentos de acceso: vive solo en el central.
export const fijarPoliticaAcceso = (intentos, minutos) =>
  central.query("update politica_acceso set intentos_maximos = $1, minutos_bloqueo = $2 where id = 1", [intentos, minutos]);

// Hace vencer una reserva de receta (simula el paso del tiempo). La reserva vive solo en el central.
export const vencerReservaReceta = (codigo) =>
  central.query("update receta_emitida set reservada_hasta = now()::timestamp - interval '1 minute' where codigo = $1", [codigo]);

// Limpia el consolidado de una tienda (lo reconstruye la siguiente foto de stock). No se replica.
export const limpiarConsolidadoTienda = (idTienda) => central.query("delete from inventario_consolidado where id_tienda = $1", [idTienda]);
