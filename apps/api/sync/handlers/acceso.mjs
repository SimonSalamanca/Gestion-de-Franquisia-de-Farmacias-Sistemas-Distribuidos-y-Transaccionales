import { dejarConflicto } from "../conflictos.mjs";

// Estado canónico de bloqueo publicado por el central (HU-06).
async function controlAccesoSnapshot(client, event) {
  const payload = event.payload;
  const row = await client.query(
    `select c.id_snapshot, c.epoch, c.provisional, c.bloqueado_hasta, e.version_credencial,
            (c.provisional and c.bloqueado_hasta > now()) as provisional_vigente
     from empleado_ref e
     left join control_acceso c on c.id_empleado = e.id_empleado
     where e.id_empleado = $1`,
    [payload.id_empleado],
  );
  if (row.rowCount === 0) return;
  const localRow = row.rows[0];
  if (localRow.id_snapshot != null && Number(payload.id_snapshot) <= Number(localRow.id_snapshot)) return;
  if (Number(event.version_credencial) < Number(localRow.version_credencial)) {
    await dejarConflicto(
      client,
      payload.id_empleado,
      "VERSION",
      `snapshot ${payload.id_snapshot} version ${event.version_credencial} < local ${localRow.version_credencial}`,
    );
    return;
  }
  if (
    localRow.provisional_vigente &&
    payload.estado === "ACTIVO" &&
    Number(payload.epoch) === Number(localRow.epoch)
  ) {
    return;
  }
  await client.query(
    `insert into control_acceso (id_empleado, epoch, intentos_en_epoch, estado, bloqueado_hasta, provisional, provisional_hasta, id_snapshot)
     values ($1, $2, $3, $4, $5, false, null, $6)
     on conflict (id_empleado) do update set
       epoch = excluded.epoch,
       intentos_en_epoch = excluded.intentos_en_epoch,
       estado = excluded.estado,
       bloqueado_hasta = excluded.bloqueado_hasta,
       provisional = false,
       provisional_hasta = null,
       id_snapshot = excluded.id_snapshot`,
    [
      payload.id_empleado,
      payload.epoch,
      payload.intentos_en_epoch,
      payload.estado,
      payload.bloqueado_hasta,
      payload.id_snapshot,
    ],
  );
}

async function sesionRevocar(client, event) {
  await client.query("update sesion_activa set revocada = true where id_empleado = $1 and revocada = false", [
    event.payload.id_empleado,
  ]);
}

export default {
  CONTROL_ACCESO_SNAPSHOT: controlAccesoSnapshot,
  SESION_REVOCAR: sesionRevocar,
};
