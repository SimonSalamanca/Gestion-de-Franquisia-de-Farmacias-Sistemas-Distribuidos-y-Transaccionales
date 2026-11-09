import crypto from "crypto";
import { ErrorNegocio, conflicto } from "./errores.mjs";
import { registrarMovimiento } from "./inventario/movimientos.mjs";
import { encolarStockSnapshot } from "./inventario/stock.mjs";
import { dejarConflicto } from "./sync/conflictos.mjs";

// HU-17: el paso de CADA TIENDA en un traslado (saga coordinada por el central, apps/api/traslados.mjs).
// La tienda recibe su orden como evento dirigido de replica_evento y la ejecuta dentro de la transacción del pull
// (sync.mjs): el stock, el traslado_local, la auditoría y la respuesta al central en el outbox se confirman juntos o nada.
//
//   TRASLADO_DESCONTAR  (origen):  descuenta por FEFO sin quedar en negativo, o rechaza si no hay stock.  -> DESCONTADO | RECHAZADO
//   TRASLADO_INGRESAR   (destino): ingresa los mismos lotes, o informa el fallo.                          -> RECIBIDO | INGRESO_FALLIDO
//   TRASLADO_COMPENSAR  (origen):  devuelve las unidades a los lotes de los que salieron.                 -> COMPENSADO
//   TRASLADO_ESTADO     (ambas):   el estado de red que fija el central, para que las dos expliquen lo mismo.
//
// Idempotencia: cada orden mira el estado de su traslado_local antes de actuar; un evento repetido (reintento del pull) no
// descuenta, ingresa ni repone dos veces. Las respuestas al outbox llevan una clave estable por traslado y paso.
// Un fallo de NEGOCIO (no hay stock, lote inconsistente...) se revierte con un savepoint y se responde como rechazo o fallo;
// un fallo técnico (conexión) se propaga: el pull se revierte entero y se reintenta en el próximo ciclo sin perder la orden.

const ROL = { ORIGEN: "ORIGEN", DESTINO: "DESTINO" };

// UUID estable a partir de un texto: el mismo paso del mismo traslado siempre produce la misma clave de outbox.
function claveDe(texto) {
  const b = crypto.createHash("sha256").update(`hu17:${texto}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function responder(client, tipo, idTraslado, payload) {
  await client.query(
    `insert into outbox_sync (id_empleado, idempotency_key, tipo_evento, payload)
     values (null, $1, $2, $3::jsonb) on conflict (idempotency_key) do nothing`,
    [claveDe(`${tipo}:${idTraslado}`), tipo, JSON.stringify({ id_traslado: idTraslado, ...payload })],
  );
}

async function auditar(client, accion, idTraslado, detalle) {
  await client.query(
    `insert into registro_actividad (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
     values (null, $1, 'traslado', $2, $3)`,
    [accion, idTraslado, String(detalle).slice(0, 400)],
  );
}

// traslado_local referencia a tienda_ref: si la otra tienda aún no llegó por réplica, se deja su fila mínima.
async function asegurarTiendas(client, p) {
  for (const [id, nombre] of [[p.id_tienda_origen, p.tienda_origen], [p.id_tienda_destino, p.tienda_destino]]) {
    await client.query(
      "insert into tienda_ref (id_tienda, nombre, activa) values ($1, $2, true) on conflict (id_tienda) do nothing",
      [id, nombre || `Tienda ${id}`],
    );
  }
}

async function guardarTraslado(client, p, rol, estadoLocal, { estadoRed = null, motivo = null } = {}) {
  await client.query(
    `insert into traslado_local (id_traslado, rol_tienda, id_tienda_origen, id_tienda_destino, estado_local, estado_red, motivo, solicitante, actualizado_en)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (id_traslado, rol_tienda) do update
     set estado_local = excluded.estado_local,
         estado_red = coalesce(excluded.estado_red, traslado_local.estado_red),
         motivo = coalesce(excluded.motivo, traslado_local.motivo),
         actualizado_en = now()`,
    [p.id_traslado, rol, p.id_tienda_origen, p.id_tienda_destino, estadoLocal, estadoRed, motivo ? String(motivo).slice(0, 300) : null, p.solicitante ?? null],
  );
  for (const item of p.items ?? []) {
    await client.query(
      `insert into detalle_traslado_local (id_traslado, rol_tienda, id_medicamento, cantidad) values ($1, $2, $3, $4)
       on conflict (id_traslado, rol_tienda, id_medicamento) do nothing`,
      [p.id_traslado, rol, item.id_medicamento, item.cantidad],
    );
  }
}

const estadoLocalDe = async (client, idTraslado, rol) =>
  (await client.query("select estado_local from traslado_local where id_traslado = $1 and rol_tienda = $2 for update", [idTraslado, rol])).rows[0]?.estado_local ?? null;

// Un error de negocio (o una restricción de la base) se trata como resultado del paso; uno técnico, como reintento.
const esDeNegocio = (error) => error instanceof ErrorNegocio || /^(22|23)/.test(String(error?.code ?? ""));

async function enPaso(client, hacer, alFallar) {
  await client.query("savepoint traslado_paso");
  try {
    await hacer();
    await client.query("release savepoint traslado_paso");
  } catch (error) {
    await client.query("rollback to savepoint traslado_paso");
    if (!esDeNegocio(error)) throw error;
    await alFallar(error.message);
  }
}

// ---- Origen: descontar (criterios 2 y 5) ----

async function descontar(client, event, idTienda) {
  const p = event.payload;
  if (Number(p.id_tienda_origen) !== Number(idTienda)) return;
  if (await estadoLocalDe(client, p.id_traslado, ROL.ORIGEN)) return; // ya se descontó o se rechazó: evento repetido
  await asegurarTiendas(client, p);
  const referencia = `TR-${p.id_traslado}`;
  await enPaso(
    client,
    async () => {
      // La fila del traslado primero: los movimientos la referencian (fk_movimiento_traslado).
      await guardarTraslado(client, p, ROL.ORIGEN, "DESCONTADO", { estadoRed: "SOLICITADO" });
      const salidas = [];
      for (const item of [...p.items].sort((a, b) => a.id_medicamento - b.id_medicamento)) {
        // Criterio 5: la disponibilidad real se valida aquí, con los lotes bloqueados (mismo orden que la venta: id_lote).
        const lotes = await client.query(
          `select l.id_lote, l.numero_lote, l.fecha_caducidad::text as fecha_caducidad, l.id_proveedor, l.cantidad_disponible, m.nombre_comercial
           from lote l join medicamento_ref m on m.id_medicamento = l.id_medicamento
           where l.id_medicamento = $1 and l.estado = 'DISPONIBLE' and l.fecha_caducidad >= current_date and l.cantidad_disponible > 0
           order by l.id_lote for update of l`,
          [item.id_medicamento],
        );
        const disponible = lotes.rows.reduce((s, l) => s + Number(l.cantidad_disponible), 0);
        if (disponible < item.cantidad) {
          throw conflicto("STOCK_INSUFICIENTE", `${item.nombre_comercial ?? `Medicamento ${item.id_medicamento}`}: la tienda origen tiene ${disponible} unidades vendibles y se pidieron ${item.cantidad}`);
        }
        // FEFO: sale primero lo que vence antes.
        const fefo = [...lotes.rows].sort((a, b) => a.fecha_caducidad.localeCompare(b.fecha_caducidad) || a.id_lote - b.id_lote);
        let falta = item.cantidad;
        const deEste = [];
        for (const lote of fefo) {
          if (falta === 0) break;
          const q = Math.min(falta, Number(lote.cantidad_disponible));
          falta -= q;
          await registrarMovimiento(client, {
            idLote: lote.id_lote,
            tipo: "TRASLADO_SALIDA",
            cantidad: q,
            idEmpleado: null,
            idTienda,
            referencia,
            observaciones: `Traslado ${p.id_traslado} a ${p.tienda_destino}, solicitado por ${p.solicitante}`,
            idTraslado: p.id_traslado,
            rolTraslado: ROL.ORIGEN,
            publicarStock: false,
          });
          deEste.push({ numero_lote: lote.numero_lote, fecha_caducidad: lote.fecha_caducidad, id_proveedor: lote.id_proveedor, cantidad: q });
        }
        salidas.push({ id_medicamento: item.id_medicamento, cantidad: item.cantidad, lotes: deEste });
      }
      await encolarStockSnapshot(client, { idTienda, idsMedicamento: p.items.map((i) => i.id_medicamento) });
      await auditar(client, "TRASLADO_SALIDA", p.id_traslado, `${referencia} a ${p.tienda_destino}: ${resumen(salidas)}; solicitado por ${p.solicitante}`);
      await responder(client, "TRASLADO_DESCONTADO", p.id_traslado, { items: salidas });
    },
    async (motivo) => {
      // Nada se descontó (el savepoint lo revirtió): queda constancia del rechazo.
      await guardarTraslado(client, p, ROL.ORIGEN, "RECHAZADO", { estadoRed: "SOLICITADO", motivo });
      await auditar(client, "TRASLADO_RECHAZADO", p.id_traslado, `${referencia} a ${p.tienda_destino}: ${motivo}`);
      await responder(client, "TRASLADO_RECHAZADO", p.id_traslado, { motivo });
    },
  );
}

const resumen = (items) => items.map((i) => `${i.cantidad} u. de ${i.id_medicamento}${i.lotes ? ` (lotes ${i.lotes.map((l) => l.numero_lote).join(", ")})` : ""}`).join("; ");

// ---- Destino: ingresar (criterio 2) ----

async function ingresar(client, event, idTienda) {
  const p = event.payload;
  if (Number(p.id_tienda_destino) !== Number(idTienda)) return;
  const previo = await estadoLocalDe(client, p.id_traslado, ROL.DESTINO);
  if (previo === "RECIBIDO" || previo === "FALLIDO") return; // evento repetido
  await asegurarTiendas(client, p);
  const referencia = `TR-${p.id_traslado}`;
  await enPaso(
    client,
    async () => {
      await guardarTraslado(client, p, ROL.DESTINO, "RECIBIDO", { estadoRed: "EN_TRANSITO" });
      for (const item of p.items) {
        const med = await client.query("select nombre_comercial, activo from medicamento_ref where id_medicamento = $1", [item.id_medicamento]);
        if (!med.rows[0]?.activo) throw conflicto("MEDICAMENTO_NO_VALIDO", `El medicamento ${item.id_medicamento} no existe o está inactivo en la tienda destino`);
        for (const l of item.lotes) {
          const prov = await client.query("select 1 from proveedor_ref where id_proveedor = $1", [l.id_proveedor]);
          if (prov.rowCount === 0) throw conflicto("PROVEEDOR_DESCONOCIDO", `El proveedor ${l.id_proveedor} del lote ${l.numero_lote} no está en la tienda destino`);
          const vencido = await client.query("select $1::date < current_date as v", [l.fecha_caducidad]);
          if (vencido.rows[0].v) throw conflicto("LOTE_VENCIDO", `El lote ${l.numero_lote} venció (${l.fecha_caducidad})`);
          const existente = await client.query(
            "select id_lote, fecha_caducidad from lote where id_medicamento = $1 and id_proveedor = $2 and numero_lote = $3 for update",
            [item.id_medicamento, l.id_proveedor, l.numero_lote],
          );
          let idLote;
          if (existente.rowCount > 0) {
            if (existente.rows[0].fecha_caducidad !== l.fecha_caducidad) {
              throw conflicto("LOTE_INCONSISTENTE", `El lote ${l.numero_lote} ya existe en la tienda destino con caducidad ${existente.rows[0].fecha_caducidad} (llegó con ${l.fecha_caducidad})`);
            }
            idLote = existente.rows[0].id_lote;
          } else {
            // Igual que HU-02: el lote nace en 0 y la entrada lo lleva a su cantidad; el saldo es la suma de movimientos.
            const creado = await client.query(
              `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
               values ($1, $2, $3, $4, $5, 0, 'AGOTADO') returning id_lote`,
              [item.id_medicamento, l.id_proveedor, l.numero_lote, l.fecha_caducidad, l.cantidad],
            );
            idLote = creado.rows[0].id_lote;
          }
          await registrarMovimiento(client, {
            idLote,
            tipo: "TRASLADO_ENTRADA",
            cantidad: l.cantidad,
            idEmpleado: null,
            idTienda,
            referencia,
            observaciones: `Traslado ${p.id_traslado} desde ${p.tienda_origen}`,
            idTraslado: p.id_traslado,
            rolTraslado: ROL.DESTINO,
            publicarStock: false,
          });
        }
      }
      await encolarStockSnapshot(client, { idTienda, idsMedicamento: p.items.map((i) => i.id_medicamento) });
      await auditar(client, "TRASLADO_ENTRADA", p.id_traslado, `${referencia} desde ${p.tienda_origen}: ${resumen(p.items)}`);
      await responder(client, "TRASLADO_RECIBIDO", p.id_traslado, {});
    },
    async (motivo) => {
      // Criterio 3: el ingreso no se hizo (el savepoint lo revirtió); el central ordenará la compensación en el origen.
      await guardarTraslado(client, p, ROL.DESTINO, "FALLIDO", { estadoRed: "EN_TRANSITO", motivo });
      await auditar(client, "TRASLADO_INGRESO_FALLIDO", p.id_traslado, `${referencia} desde ${p.tienda_origen}: ${motivo}`);
      await responder(client, "TRASLADO_INGRESO_FALLIDO", p.id_traslado, { motivo });
    },
  );
}

// ---- Origen: compensar (criterio 3) ----

async function compensar(client, event, idTienda) {
  const p = event.payload;
  if (Number(p.id_tienda_origen) !== Number(idTienda)) return;
  const estado = await estadoLocalDe(client, p.id_traslado, ROL.ORIGEN);
  if (estado !== "DESCONTADO") return; // ya compensado (evento repetido) o nunca descontado: no hay nada que reponer
  const referencia = `TR-${p.id_traslado}-COMP`;
  // Se repone exactamente lo que salió, a los mismos lotes, aunque mientras tanto hayan vencido o se hayan agotado.
  const salidas = await client.query(
    `select id_lote, cantidad from movimiento_inventario
     where id_traslado = $1 and rol_tienda_traslado = 'ORIGEN' and tipo_movimiento = 'TRASLADO_SALIDA'
     order by id_lote`,
    [p.id_traslado],
  );
  try {
    await client.query("savepoint traslado_comp");
    for (const s of salidas.rows) {
      await registrarMovimiento(client, {
        idLote: s.id_lote,
        tipo: "TRASLADO_ENTRADA",
        cantidad: s.cantidad,
        idEmpleado: null,
        idTienda,
        referencia,
        observaciones: `Compensación del traslado ${p.id_traslado}: ${p.motivo ?? "el ingreso en destino falló"}`.slice(0, 300),
        idTraslado: p.id_traslado,
        rolTraslado: ROL.ORIGEN,
        publicarStock: false,
      });
    }
    await guardarTraslado(client, { ...p, items: [] }, ROL.ORIGEN, "COMPENSADO", { estadoRed: "COMPENSANDO", motivo: p.motivo });
    const ids = await client.query("select distinct l.id_medicamento from lote l where l.id_lote = any($1::int[])", [salidas.rows.map((s) => s.id_lote)]);
    await encolarStockSnapshot(client, { idTienda, idsMedicamento: ids.rows.map((r) => r.id_medicamento) });
    await auditar(client, "TRASLADO_COMPENSADO", p.id_traslado, `${referencia}: se repusieron ${salidas.rows.reduce((s, x) => s + x.cantidad, 0)} u. Motivo: ${p.motivo ?? ""}`);
    await responder(client, "TRASLADO_COMPENSADO", p.id_traslado, {});
    await client.query("release savepoint traslado_comp");
  } catch (error) {
    await client.query("rollback to savepoint traslado_comp");
    if (!esDeNegocio(error)) throw error;
    // Nunca en silencio (regla 5): queda en la cola de conflictos de la tienda y la réplica sigue.
    await dejarConflicto(client, null, "TRASLADO_COMPENSACION", `traslado ${p.id_traslado}: ${error.message}`);
  }
}

// ---- Ambas: estado de red ----

async function estadoDeRed(client, event, idTienda) {
  const p = event.payload;
  const rol = Number(p.id_tienda_origen) === Number(idTienda) ? ROL.ORIGEN : Number(p.id_tienda_destino) === Number(idTienda) ? ROL.DESTINO : null;
  if (!rol) return;
  const r = await client.query(
    `update traslado_local
     set estado_red = $3::varchar, motivo = coalesce($4::varchar, motivo), actualizado_en = now(),
         -- Si el origen rechazó, la tienda destino deja de esperar la mercancía.
         estado_local = case when $2::varchar = 'DESTINO' and $3::varchar = 'FALLIDO' and estado_local = 'PENDIENTE' then 'RECHAZADO' else estado_local end
     where id_traslado = $1 and rol_tienda = $2::varchar`,
    [p.id_traslado, rol, p.estado, p.motivo ?? null],
  );
  if (r.rowCount === 0 && rol === ROL.DESTINO) {
    // La solicitud se hizo con el central y la fila local no llegó a guardarse (corte justo después): se crea ahora.
    await asegurarTiendas(client, p);
    await guardarTraslado(client, p, ROL.DESTINO, p.estado === "FALLIDO" ? "RECHAZADO" : "PENDIENTE", { estadoRed: p.estado, motivo: p.motivo });
  }
}

export default {
  TRASLADO_DESCONTAR: descontar,
  TRASLADO_INGRESAR: ingresar,
  TRASLADO_COMPENSAR: compensar,
  TRASLADO_ESTADO: estadoDeRed,
};

// La solicitud vista desde la tienda que la pide (destino), justo después de que el central la aceptó. Idempotente.
export async function registrarSolicitudLocal(client, traslado, idEmpleado) {
  const p = { ...traslado, items: traslado.items.map((i) => ({ id_medicamento: i.id_medicamento, cantidad: i.cantidad })) };
  await asegurarTiendas(client, p);
  const previo = await estadoLocalDe(client, p.id_traslado, ROL.DESTINO);
  if (previo) return;
  await guardarTraslado(client, p, ROL.DESTINO, "PENDIENTE", { estadoRed: traslado.estado });
  await client.query(
    `insert into registro_actividad (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
     values ($1, 'TRASLADO_SOLICITAR', 'traslado', $2, $3)`,
    [idEmpleado, p.id_traslado, `TR-${p.id_traslado} desde ${p.tienda_origen}: ${resumen(p.items)}`.slice(0, 400)],
  );
}

// Traslados de esta tienda (como origen o destino) desde su base: se consulta sin conexión con el central.
export async function listarTrasladosLocales(db) {
  const r = await db.query(
    `select t.id_traslado, t.rol_tienda, t.id_tienda_origen, o.nombre as tienda_origen, t.id_tienda_destino, d.nombre as tienda_destino,
            t.estado_local, t.estado_red, t.motivo, t.solicitante, t.fecha_hora, t.actualizado_en,
            coalesce(json_agg(json_build_object('id_medicamento', x.id_medicamento, 'nombre_comercial', m.nombre_comercial, 'cantidad', x.cantidad))
                     filter (where x.id_medicamento is not null), '[]') as items
     from traslado_local t
     join tienda_ref o on o.id_tienda = t.id_tienda_origen
     join tienda_ref d on d.id_tienda = t.id_tienda_destino
     left join detalle_traslado_local x on x.id_traslado = t.id_traslado and x.rol_tienda = t.rol_tienda
     left join medicamento_ref m on m.id_medicamento = x.id_medicamento
     group by t.id_traslado, t.rol_tienda, o.nombre, d.nombre
     order by t.fecha_hora desc, t.id_traslado desc
     limit 100`,
  );
  return { traslados: r.rows };
}
