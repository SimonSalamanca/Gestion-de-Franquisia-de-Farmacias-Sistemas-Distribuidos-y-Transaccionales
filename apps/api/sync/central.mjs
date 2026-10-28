// Aplicación en el nodo central de los eventos que envía el outbox de una tienda.
// Para un tipo nuevo: agregar su función a APLICADORES. Corre en la transacción del central.

// HU-01: foto de stock absoluto de la tienda origen. Idempotente por inbox_sync y monótona por fecha.
async function stockSnapshot(client, idTienda, event) {
  const inbox = await client.query(
    `insert into inbox_sync (id_tienda_origen, idempotency_key, tipo_evento, payload)
     values ($1, $2, $3, $4::jsonb)
     on conflict (id_tienda_origen, idempotency_key) do nothing`,
    [idTienda, event.idempotency_key, event.tipo_evento, JSON.stringify(event.payload)],
  );
  if (inbox.rowCount === 0) return; // duplicado
  const { calculado_en: calculadoEn, items = [] } = event.payload;
  for (const item of items) {
    // Una foto vieja que llega tarde no pisa una más nueva.
    await client.query(
      `insert into inventario_consolidado (id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion)
       values ($1, $2, $3, $4)
       on conflict (id_tienda, id_medicamento) do update
       set cantidad_disponible = excluded.cantidad_disponible,
           fecha_sincronizacion = excluded.fecha_sincronizacion
       where inventario_consolidado.fecha_sincronizacion <= excluded.fecha_sincronizacion`,
      [idTienda, item.id_medicamento, item.cantidad, calculadoEn],
    );
  }
}

// HU-06: FAIL / SUCCESS / EXPIRADO se pliegan en fold_evento (estado canónico de bloqueo).
async function foldEvento(client, idTienda, event) {
  await client.query("select fold_evento($1, $2, $3, $4::jsonb)", [
    idTienda,
    event.idempotency_key,
    event.tipo_evento,
    JSON.stringify(event.payload),
  ]);
}

const APLICADORES = {
  STOCK_SNAPSHOT: stockSnapshot,
};

export async function aplicarEnCentral(client, idTienda, event) {
  const aplicar = APLICADORES[event.tipo_evento] || foldEvento;
  await aplicar(client, idTienda, event);
}
