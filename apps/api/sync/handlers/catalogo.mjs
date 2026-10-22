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

export default {
  TIENDA_UPSERT: tiendaUpsert,
  ROL_UPSERT: rolUpsert,
  PERMISO_UPSERT: permisoUpsert,
  ROL_PERMISO_SET: rolPermisoSet,
};
