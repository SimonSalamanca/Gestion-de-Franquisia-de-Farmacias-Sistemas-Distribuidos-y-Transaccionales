import { conflicto, invalido, noEncontrado } from "../errores.mjs";
import { encolarStockSnapshot } from "./stock.mjs";

// RF-04: ÚNICO camino para cambiar existencias. Lo usan HU-02 (entradas, recepción, ajustes) y las
// historias de venta, devolución y traslados. Corre dentro de la transacción del llamador.

// Sentido fijo por tipo; AJUSTE lo recibe explícito (+1 sobrante, -1 merma). Coincide con
// movimiento_sentido_check (db/local/02_hu02_movimiento_sentido.sql).
const SENTIDO_FIJO = {
  ENTRADA: 1,
  DEVOLUCION: 1,
  TRASLADO_ENTRADA: 1,
  VENTA: -1,
  TRASLADO_SALIDA: -1,
};
export const TIPOS = [...Object.keys(SENTIDO_FIJO), "AJUSTE"];

export async function registrarMovimiento(
  client,
  {
    idLote,
    tipo,
    sentido,
    cantidad,
    idEmpleado,
    idTienda,
    referencia = null,
    observaciones = null,
    idTraslado = null,
    // false cuando el llamador registra varios movimientos y publica el stock una sola vez al final.
    publicarStock = true,
  },
) {
  if (!TIPOS.includes(tipo)) throw invalido(`Tipo de movimiento desconocido: ${tipo}`);
  const signo = tipo === "AJUSTE" ? Number(sentido) : SENTIDO_FIJO[tipo];
  if (signo !== 1 && signo !== -1) throw invalido("El ajuste debe indicar si suma o resta");
  if (!Number.isInteger(cantidad) || cantidad <= 0) throw invalido("La cantidad debe ser un entero mayor que cero");
  if (!idEmpleado) throw invalido("Falta el empleado responsable");

  // RNF-06: el bloqueo de fila serializa movimientos concurrentes sobre el mismo lote.
  const result = await client.query(
    `select id_lote, id_medicamento, numero_lote, cantidad_disponible, estado,
            fecha_caducidad < current_date as vencido
     from lote where id_lote = $1 for update`,
    [idLote],
  );
  if (result.rowCount === 0) throw noEncontrado(`El lote ${idLote} no existe`);
  const lote = result.rows[0];

  // Lote.estaVencido(): solo un AJUSTE puede tocar un lote vencido o bloqueado (p. ej. darlo de baja).
  if (signo < 0 && tipo !== "AJUSTE" && (lote.vencido || lote.estado === "BLOQUEADO")) {
    throw conflicto("LOTE_NO_DISPONIBLE", `El lote ${lote.numero_lote} está ${lote.vencido ? "vencido" : "bloqueado"}`);
  }
  const nuevo = Number(lote.cantidad_disponible) + signo * cantidad;
  if (nuevo < 0) {
    throw conflicto("STOCK_INSUFICIENTE", `El lote ${lote.numero_lote} solo tiene ${lote.cantidad_disponible} unidades`, {
      disponible: Number(lote.cantidad_disponible),
    });
  }
  const estado = lote.estado === "BLOQUEADO" ? "BLOQUEADO" : nuevo === 0 ? "AGOTADO" : "DISPONIBLE";

  // Saldo del lote y movimiento en una sola sentencia (una ida y vuelta menos por movimiento).
  const movimiento = await client.query(
    `with saldo as (
       update lote set cantidad_disponible = $9, estado = $10 where id_lote = $1
     )
     insert into movimiento_inventario (
       id_lote, tipo_movimiento, sentido, cantidad, id_empleado, referencia_documento, id_traslado, observaciones
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id_movimiento, fecha_hora`,
    [
      idLote,
      tipo,
      signo,
      cantidad,
      idEmpleado,
      referencia ? String(referencia).slice(0, 60) : null,
      idTraslado,
      observaciones ? String(observaciones).slice(0, 300) : null,
      nuevo,
      estado,
    ],
  );

  // HU-01: el central conoce el nuevo stock vendible en el próximo ciclo del outbox.
  if (publicarStock) await encolarStockSnapshot(client, { idTienda, idsMedicamento: [lote.id_medicamento] });

  return {
    id_movimiento: movimiento.rows[0].id_movimiento,
    id_medicamento: lote.id_medicamento,
    fecha_hora: movimiento.rows[0].fecha_hora,
    id_lote: idLote,
    saldo: nuevo,
    estado,
  };
}
