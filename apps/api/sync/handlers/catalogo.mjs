import { dejarConflicto } from "../conflictos.mjs";

// Datos maestros globales replicados desde el central a las tablas _ref.

async function tiendaUpsert(client, event, idTienda) {
  const payload = event.payload;
  await client.query(
    `insert into tienda_ref (id_tienda, nombre, activa, es_tienda_local)
     values ($1, $2, $3, $4)
     on conflict (id_tienda) do update
     set nombre = excluded.nombre, activa = excluded.activa, es_tienda_local = excluded.es_tienda_local`,
    [payload.id_tienda, payload.nombre, payload.activa, Number(payload.id_tienda) === Number(idTienda)],
  );
}

async function rolUpsert(client, event) {
  const payload = event.payload;
  await client.query(
    `insert into rol_ref (id_rol, nombre) values ($1, $2)
     on conflict (id_rol) do update set nombre = excluded.nombre`,
    [payload.id_rol, payload.nombre],
  );
}

async function permisoUpsert(client, event) {
  const payload = event.payload;
  await client.query(
    `insert into permiso_ref (id_permiso, codigo, descripcion) values ($1, $2, $3)
     on conflict (id_permiso) do update set codigo = excluded.codigo, descripcion = excluded.descripcion`,
    [payload.id_permiso, payload.codigo, payload.descripcion],
  );
}

async function rolPermisoSet(client, event) {
  const payload = event.payload;
  await client.query("delete from rol_permiso_ref where id_rol = $1", [payload.id_rol]);
  for (const permiso of payload.permisos || []) {
    await client.query(
      `insert into permiso_ref (id_permiso, codigo) values ($1, $2)
       on conflict (id_permiso) do update set codigo = excluded.codigo`,
      [permiso.id_permiso, permiso.codigo],
    );
    await client.query(
      "insert into rol_permiso_ref (id_rol, id_permiso) values ($1, $2) on conflict do nothing",
      [payload.id_rol, permiso.id_permiso],
    );
  }
}

// HU-01/HU-02: catálogo de medicamentos y proveedores (RNF-11: agregar uno es un insert).

async function categoriaUpsert(client, event) {
  const payload = event.payload;
  await client.query(
    `insert into categoria_ref (id_categoria, nombre) values ($1, $2)
     on conflict (id_categoria) do update set nombre = excluded.nombre`,
    [payload.id_categoria, payload.nombre],
  );
}

async function medicamentoUpsert(client, event) {
  const payload = event.payload;
  let idCategoria = payload.id_categoria ?? null;
  if (idCategoria != null) {
    const categoria = await client.query("select 1 from categoria_ref where id_categoria = $1", [idCategoria]);
    if (categoria.rowCount === 0) {
      await dejarConflicto(
        client,
        null,
        "DEPENDENCIA_FALTANTE",
        `evento ${event.id_evento} MEDICAMENTO_UPSERT: categoría ${idCategoria} no está en categoria_ref`,
      );
      idCategoria = null;
    }
  }
  await client.query(
    `insert into medicamento_ref (
       id_medicamento, codigo_interno, nombre_comercial, principio_activo, id_categoria,
       requiere_receta, requiere_refrigeracion, activo
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id_medicamento) do update set
       codigo_interno = excluded.codigo_interno,
       nombre_comercial = excluded.nombre_comercial,
       principio_activo = excluded.principio_activo,
       id_categoria = excluded.id_categoria,
       requiere_receta = excluded.requiere_receta,
       requiere_refrigeracion = excluded.requiere_refrigeracion,
       activo = excluded.activo`,
    [
      payload.id_medicamento,
      payload.codigo_interno,
      payload.nombre_comercial,
      payload.principio_activo,
      idCategoria,
      Boolean(payload.requiere_receta),
      Boolean(payload.requiere_refrigeracion),
      payload.activo !== false,
    ],
  );
}

async function proveedorUpsert(client, event) {
  const payload = event.payload;
  await client.query(
    `insert into proveedor_ref (id_proveedor, nombre_empresa, activo) values ($1, $2, $3)
     on conflict (id_proveedor) do update set nombre_empresa = excluded.nombre_empresa, activo = excluded.activo`,
    [payload.id_proveedor, payload.nombre_empresa, payload.activo !== false],
  );
}

export default {
  TIENDA_UPSERT: tiendaUpsert,
  ROL_UPSERT: rolUpsert,
  PERMISO_UPSERT: permisoUpsert,
  ROL_PERMISO_SET: rolPermisoSet,
  CATEGORIA_UPSERT: categoriaUpsert,
  MEDICAMENTO_UPSERT: medicamentoUpsert,
  PROVEEDOR_UPSERT: proveedorUpsert,
};
