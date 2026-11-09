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
  if (items.length === 0) return;
  // Una sola sentencia para toda la foto (HU-16: la completa trae todos los medicamentos y con Neon cada ida y vuelta
  // cuesta ~130 ms). Una foto vieja que llega tarde no pisa una más nueva.
  await client.query(
    `insert into inventario_consolidado (id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion)
     select distinct on (i.id_medicamento) $1, i.id_medicamento, i.cantidad, $2::timestamp
     from jsonb_to_recordset($3::jsonb) as i(id_medicamento int, cantidad int)
     order by i.id_medicamento
     on conflict (id_tienda, id_medicamento) do update
     set cantidad_disponible = excluded.cantidad_disponible,
         fecha_sincronizacion = excluded.fecha_sincronizacion
     where inventario_consolidado.fecha_sincronizacion <= excluded.fecha_sincronizacion`,
    [idTienda, calculadoEn, JSON.stringify(items)],
  );
}

// HU-16: ventas por categoría (signo 1 en una venta, -1 en una devolución). Los eventos anteriores a HU-16 no traen
// `categorias` y solo alimentan venta_consolidada.
async function sumarCategorias(client, idTienda, fecha, categorias, signo) {
  if (!Array.isArray(categorias) || categorias.length === 0) return;
  await client.query(
    `insert into venta_categoria_consolidada (id_tienda, fecha, id_categoria, unidades, ingresos, fecha_sincronizacion)
     select $1, $2::date, c.id_categoria, $4::int * sum(c.unidades)::int, $4::int * sum(c.ingresos), now()
     from jsonb_to_recordset($3::jsonb) as c(id_categoria int, unidades int, ingresos numeric)
     group by c.id_categoria
     on conflict (id_tienda, fecha, id_categoria) do update
     set unidades = venta_categoria_consolidada.unidades + excluded.unidades,
         ingresos = venta_categoria_consolidada.ingresos + excluded.ingresos,
         fecha_sincronizacion = now()`,
    [idTienda, fecha, JSON.stringify(categorias.map((c) => ({ ...c, id_categoria: c.id_categoria ?? 0 }))), signo],
  );
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

// HU-12: baja de una receta validada con el central. Import perezoso: recetas-red usa el enlace con el central.
async function recetaDispensada(client, idTienda, event) {
  const { aplicarBajaReceta } = await import("../recetas-red.mjs");
  await aplicarBajaReceta(client, idTienda, event);
}

// HU-08: una venta de la tienda alimenta el consolidado por tienda, día y método de pago. Idempotente por inbox_sync:
// un reintento no suma dos veces. total_facturas cuenta la factura en cada método con que se pagó.
async function ventaRegistrada(client, idTienda, event) {
  const inbox = await client.query(
    `insert into inbox_sync (id_tienda_origen, idempotency_key, tipo_evento, payload)
     values ($1, $2, $3, $4::jsonb) on conflict (id_tienda_origen, idempotency_key) do nothing`,
    [idTienda, event.idempotency_key, event.tipo_evento, JSON.stringify(event.payload)],
  );
  if (inbox.rowCount === 0) return; // duplicado
  const { fecha, pagos = [] } = event.payload;
  for (const pago of pagos) {
    await client.query(
      `insert into venta_consolidada (id_tienda, fecha, id_metodo_pago, total_vendido, total_facturas, fecha_sincronizacion)
       values ($1, $2::date, $3, $4::numeric, 1, now())
       on conflict (id_tienda, fecha, id_metodo_pago) do update
       set total_vendido = venta_consolidada.total_vendido + excluded.total_vendido,
           total_facturas = venta_consolidada.total_facturas + 1,
           fecha_sincronizacion = now()`,
      [idTienda, fecha, pago.id_metodo_pago, pago.monto],
    );
  }
  await sumarCategorias(client, idTienda, fecha, event.payload.categorias, 1);
}

// HU-10: una anulación o devolución resta el valor reintegrado del consolidado por tienda, día y método de pago. Se
// registra en el día de la nota (nota de crédito), no en el de la venta, para no reescribir días ya cerrados.
// Idempotente por inbox_sync: un reintento no resta dos veces.
async function devolucionRegistrada(client, idTienda, event) {
  const inbox = await client.query(
    `insert into inbox_sync (id_tienda_origen, idempotency_key, tipo_evento, payload)
     values ($1, $2, $3, $4::jsonb) on conflict (id_tienda_origen, idempotency_key) do nothing`,
    [idTienda, event.idempotency_key, event.tipo_evento, JSON.stringify(event.payload)],
  );
  if (inbox.rowCount === 0) return; // duplicado
  const { fecha, pagos = [] } = event.payload;
  for (const pago of pagos) {
    await client.query(
      `insert into venta_consolidada (id_tienda, fecha, id_metodo_pago, total_vendido, total_facturas, fecha_sincronizacion)
       values ($1, $2::date, $3, -$4::numeric, 0, now())
       on conflict (id_tienda, fecha, id_metodo_pago) do update
       set total_vendido = venta_consolidada.total_vendido - $4::numeric,
           fecha_sincronizacion = now()`,
      [idTienda, fecha, pago.id_metodo_pago, pago.monto],
    );
  }
  await sumarCategorias(client, idTienda, fecha, event.payload.categorias, -1);
}

const APLICADORES = {
  DEVOLUCION_REGISTRADA: devolucionRegistrada,
  STOCK_SNAPSHOT: stockSnapshot,
  VENTA_REGISTRADA: ventaRegistrada,
  RECETA_DISPENSADA: recetaDispensada,
};

export async function aplicarEnCentral(client, idTienda, event) {
  const aplicar = APLICADORES[event.tipo_evento] || foldEvento;
  await aplicar(client, idTienda, event);
}
