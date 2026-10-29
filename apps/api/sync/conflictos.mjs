export async function dejarConflicto(client, idEmpleado, tipo, detalle) {
  await client.query(
    `insert into sync_conflicto (id_empleado, tipo, detalle) values ($1, $2, $3)`,
    [idEmpleado, tipo, String(detalle || "").slice(0, 400)],
  );
}
