import crypto from "crypto";

// Stock vendible de una tienda (HU-01): lotes DISPONIBLE y no vencidos según la fecha de la base.
// vw_stock_tienda no sirve aquí porque cuenta los lotes vencidos.
export const SQL_STOCK_VENDIBLE = `
  select l.id_medicamento,
         coalesce(sum(l.cantidad_disponible) filter (
           where l.estado = 'DISPONIBLE' and l.fecha_caducidad >= current_date
         ), 0)::int as stock
  from lote l
  group by l.id_medicamento`;

export function estadoStock(stock, stockMinimo) {
  if (stock <= 0) return "agotado";
  if (stockMinimo != null && stock <= Number(stockMinimo)) return "bajo";
  return "disponible";
}

export async function stockDe(client, idsMedicamento) {
  const result = await client.query(
    `select m.id_medicamento, coalesce(s.stock, 0)::int as stock
     from unnest($1::int[]) as m(id_medicamento)
     left join (${SQL_STOCK_VENDIBLE}) s on s.id_medicamento = m.id_medicamento`,
    [idsMedicamento],
  );
  return result.rows;
}

// Encola en el outbox la cantidad ABSOLUTA de los medicamentos indicados, en la transacción del llamador.
// Con cantidades absolutas un reintento o un duplicado nunca descuadran el consolidado del central.
// Va con id_empleado NULL: el outbox ordena por empleado, y así un evento de login atascado de quien
// hizo el movimiento no frena la publicación del stock (el responsable ya queda en movimiento_inventario).
// Stock y hora (now() de la base, en UTC ISO) se calculan y encolan en una sola sentencia: con la base
// remota (Neon) cada ida y vuelta cuesta ~130 ms, y esto corre dentro de cada movimiento.
export async function encolarStockSnapshot(client, { idTienda, idsMedicamento }) {
  const ids = [...new Set(idsMedicamento.map(Number))];
  if (ids.length === 0) return null;
  const key = crypto.randomUUID();
  await client.query(
    `insert into outbox_sync (id_empleado, idempotency_key, tipo_evento, payload)
     select null, $1, 'STOCK_SNAPSHOT', jsonb_build_object(
              'id_tienda', $2::int,
              'calculado_en', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'items', jsonb_agg(jsonb_build_object('id_medicamento', m.id_medicamento, 'cantidad', coalesce(s.stock, 0)) order by m.ord))
     from unnest($3::int[]) with ordinality as m(id_medicamento, ord)
     left join (${SQL_STOCK_VENDIBLE}) s on s.id_medicamento = m.id_medicamento`,
    [key, Number(idTienda), ids],
  );
  return key;
}

// Reconciliación: foto completa de todo medicamento que tenga o haya tenido lotes (incluye los que quedaron en 0).
export async function encolarStockCompleto(client, idTienda) {
  const ids = await client.query("select distinct id_medicamento from lote order by 1");
  return encolarStockSnapshot(client, { idTienda, idsMedicamento: ids.rows.map((row) => row.id_medicamento) });
}
