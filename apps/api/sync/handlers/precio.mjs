import { dejarConflicto } from "../conflictos.mjs";

// HU-03: historial de precios de red. El central publica un PRECIO_UPSERT por cada fila que crea o cambia
// (alta, corrección de un precio programado o el fin que se ajusta al programar el siguiente).
// payload: { id_precio, id_medicamento, precio, fecha_inicio_vigencia, fecha_fin_vigencia, id_empleado_registro, registrado_por }
async function precioUpsert(client, event) {
  const p = event.payload;
  const medicamento = await client.query("select 1 from medicamento_ref where id_medicamento = $1", [p.id_medicamento]);
  if (medicamento.rowCount === 0) {
    await dejarConflicto(
      client,
      null,
      "DEPENDENCIA_FALTANTE",
      `evento ${event.id_evento} PRECIO_UPSERT: medicamento ${p.id_medicamento} no está en medicamento_ref`,
    );
    return;
  }
  // Idempotente por id_precio: el log se aplica en orden, así que la última versión de la fila gana.
  await client.query(
    `insert into precio_ref (
       id_precio, id_medicamento, precio, fecha_inicio_vigencia, fecha_fin_vigencia, id_empleado_registro, registrado_por
     ) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id_precio) do update set
       id_medicamento = excluded.id_medicamento,
       precio = excluded.precio,
       fecha_inicio_vigencia = excluded.fecha_inicio_vigencia,
       fecha_fin_vigencia = excluded.fecha_fin_vigencia,
       id_empleado_registro = excluded.id_empleado_registro,
       registrado_por = excluded.registrado_por`,
    [
      p.id_precio,
      p.id_medicamento,
      p.precio,
      p.fecha_inicio_vigencia,
      p.fecha_fin_vigencia || null,
      p.id_empleado_registro ?? null,
      p.registrado_por ?? null,
    ],
  );
}

export default {
  PRECIO_UPSERT: precioUpsert,
};
