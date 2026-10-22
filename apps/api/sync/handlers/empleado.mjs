import { dejarConflicto } from "../conflictos.mjs";

// Cuenta del empleado. El hash solo se guarda en su tienda hogar.
async function empleadoUpsert(client, event, idTienda) {
  const payload = event.payload;
  const current = await client.query(
    "select version_credencial from empleado_ref where id_empleado = $1",
    [payload.id_empleado],
  );
  if (current.rowCount > 0 && Number(event.version_credencial) < Number(current.rows[0].version_credencial)) {
    await dejarConflicto(
      client,
      payload.id_empleado,
      "VERSION",
      `empleado version ${event.version_credencial} < local ${current.rows[0].version_credencial}`,
    );
    return;
  }
  const fuera = Number(payload.id_tienda) !== Number(idTienda);
  await client.query(
    `insert into empleado_ref (
       id_empleado, id_rol, id_tienda, nombre_completo, usuario, activo, contrasena_hash, version_credencial, fecha_baja
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id_empleado) do update set
       id_rol = excluded.id_rol,
       id_tienda = excluded.id_tienda,
       nombre_completo = excluded.nombre_completo,
       usuario = excluded.usuario,
       activo = excluded.activo,
       contrasena_hash = excluded.contrasena_hash,
       version_credencial = excluded.version_credencial,
       fecha_baja = excluded.fecha_baja`,
    [
      payload.id_empleado,
      payload.id_rol,
      payload.id_tienda,
      payload.nombre_completo,
      payload.usuario,
      fuera ? false : payload.activo,
      fuera ? null : payload.contrasena_hash,
      payload.version_credencial,
      payload.fecha_baja || null,
    ],
  );
  if (fuera || payload.activo === false || payload.fecha_baja) {
    await client.query("update sesion_activa set revocada = true where id_empleado = $1 and revocada = false", [
      payload.id_empleado,
    ]);
  }
}

export default {
  EMPLEADO_UPSERT: empleadoUpsert,
};
