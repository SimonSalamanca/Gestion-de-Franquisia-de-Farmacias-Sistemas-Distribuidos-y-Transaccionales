import { dejarConflicto } from "../conflictos.mjs";

// Eventos de configuración por tienda. UMBRAL_UPSERT lo publica HU-15 (gestión de tiendas);
// el código que lo emite vive en esa historia, aquí solo se aplica en el nodo local.

// payload: { id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad }
async function umbralUpsert(client, event, idTienda) {
  const payload = event.payload;
  if (Number(payload.id_tienda) !== Number(idTienda)) return;
  // umbral_stock_ref tiene FK a medicamento_ref: si el medicamento aún no llegó, se deja constancia
  // en vez de abortar el lote completo (lo que bloquearía la réplica de esta tienda).
  const medicamento = await client.query("select 1 from medicamento_ref where id_medicamento = $1", [
    payload.id_medicamento,
  ]);
  if (medicamento.rowCount === 0) {
    await dejarConflicto(
      client,
      null,
      "DEPENDENCIA_FALTANTE",
      `evento ${event.id_evento} UMBRAL_UPSERT: medicamento ${payload.id_medicamento} no está en medicamento_ref`,
    );
    return;
  }
  await client.query(
    `insert into umbral_stock_ref (id_medicamento, stock_minimo, dias_alerta_caducidad)
     values ($1, $2, $3)
     on conflict (id_medicamento) do update
     set stock_minimo = excluded.stock_minimo, dias_alerta_caducidad = excluded.dias_alerta_caducidad`,
    [payload.id_medicamento, payload.stock_minimo, payload.dias_alerta_caducidad],
  );
}

export default {
  UMBRAL_UPSERT: umbralUpsert,
};
