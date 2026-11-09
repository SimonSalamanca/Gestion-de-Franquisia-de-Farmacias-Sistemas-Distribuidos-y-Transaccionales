import { central, runtime } from "./db.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { ErrorNegocio, conflicto, invalido, noEncontrado } from "./errores.mjs";

// HU-17: traslado de medicamentos entre tiendas (RF-26). El central ORQUESTA una saga entre dos nodos que no se ven entre sí:
//   1. La tienda destino solicita (exige conexión): el central valida la tienda origen, el medicamento y la disponibilidad
//      según el consolidado menos lo ya comprometido en otros traslados, guarda el traslado SOLICITADO y manda
//      TRASLADO_DESCONTAR a la tienda origen (evento dirigido de replica_evento).
//   2. La tienda origen descuenta (o rechaza) en su base y responde por su outbox: TRASLADO_DESCONTADO -> EN_TRANSITO y el
//      central manda TRASLADO_INGRESAR al destino con los lotes; TRASLADO_RECHAZADO -> FALLIDO (nada se movió).
//   3. La tienda destino ingresa: TRASLADO_RECIBIDO -> COMPLETADO. Si falla: TRASLADO_INGRESO_FALLIDO -> COMPENSANDO y el
//      central manda TRASLADO_COMPENSAR al origen, que repone y responde TRASLADO_COMPENSADO -> COMPENSADO.
// Cada respuesta de una tienda se aplica una sola vez (inbox_sync) y solo si el traslado está en el estado que corresponde
// (más el disparador traslado_transicion de la base): un evento repetido o tardío no retrocede ni salta pasos.
// Cada cambio de estado se avisa a las dos tiendas (TRASLADO_ESTADO) y queda en la auditoría del central.

const MAX_CANTIDAD = 10000;

const entero = (valor, campo, maximo = 2_000_000_000) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > maximo) throw invalido(`${campo} no válido`, { campo });
  return n;
};
export const idTrasladoDe = (valor) => entero(valor, "id_traslado");

async function emitir(client, idTienda, tipo, payload) {
  await client.query("select append_replica_evento($1, $2, 1, $3::jsonb)", [idTienda, tipo, JSON.stringify(payload)]);
}

async function auditarCentral(client, idEmpleado, accion, idTraslado, detalle) {
  await client.query(
    `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
     values ($1, $2, 'traslado', $3, $4)`,
    [idEmpleado, accion, idTraslado, String(detalle).slice(0, 400)],
  );
}

// El traslado con lo que necesitan las tiendas para actuar y mostrarlo (nombres, solicitante, ítems y lotes).
async function trasladoDe(db, idTraslado, { bloquear = false } = {}) {
  const t = await db.query(
    `select t.id_traslado, t.id_tienda_origen, o.nombre as tienda_origen, t.id_tienda_destino, d.nombre as tienda_destino,
            t.estado, t.motivo, t.fecha_solicitud, t.fecha_confirmacion, t.actualizado_en, t.observaciones,
            t.id_empleado_solicitante, e.nombre_completo as solicitante
     from traslado t
     join tienda o on o.id_tienda = t.id_tienda_origen
     join tienda d on d.id_tienda = t.id_tienda_destino
     join empleado e on e.id_empleado = t.id_empleado_solicitante
     where t.id_traslado = $1 ${bloquear ? "for update of t" : ""}`,
    [idTraslado],
  );
  if (t.rowCount === 0) throw noEncontrado("El traslado no existe");
  const items = await db.query(
    `select d.id_medicamento, m.nombre_comercial, d.cantidad, d.lotes
     from detalle_traslado d join medicamento m on m.id_medicamento = d.id_medicamento
     where d.id_traslado = $1 order by d.id_medicamento`,
    [idTraslado],
  );
  return { ...t.rows[0], items: items.rows };
}

// Lo que viaja a las tiendas (sin datos internos del central).
const carga = (t) => ({
  id_traslado: t.id_traslado,
  id_tienda_origen: t.id_tienda_origen,
  tienda_origen: t.tienda_origen,
  id_tienda_destino: t.id_tienda_destino,
  tienda_destino: t.tienda_destino,
  solicitante: t.solicitante,
  items: t.items.map((i) => ({ id_medicamento: i.id_medicamento, nombre_comercial: i.nombre_comercial, cantidad: i.cantidad, ...(i.lotes ? { lotes: i.lotes } : {}) })),
});

async function avisarEstado(client, t, estado, motivo = null) {
  const p = { ...carga(t), items: t.items.map((i) => ({ id_medicamento: i.id_medicamento, cantidad: i.cantidad })), estado, motivo };
  await emitir(client, t.id_tienda_origen, "TRASLADO_ESTADO", p);
  await emitir(client, t.id_tienda_destino, "TRASLADO_ESTADO", p);
}

// Disponible para trasladar desde una tienda: su stock consolidado menos lo comprometido en traslados que la tienda origen
// todavía no descontó (si no, dos solicitudes simultáneas podrían prometer las mismas unidades).
async function disponibleEn(db, idOrigen, idMedicamento) {
  const r = await db.query(
    `select coalesce((select cantidad_disponible from inventario_consolidado where id_tienda = $1 and id_medicamento = $2), 0)::int as consolidado,
            (select fecha_sincronizacion from inventario_consolidado where id_tienda = $1 and id_medicamento = $2) as al,
            coalesce((select sum(d.cantidad) from traslado t join detalle_traslado d on d.id_traslado = t.id_traslado
                      where t.id_tienda_origen = $1 and d.id_medicamento = $2 and t.estado = 'SOLICITADO'), 0)::int as comprometido`,
    [idOrigen, idMedicamento],
  );
  const f = r.rows[0];
  return { disponible: Math.max(f.consolidado - f.comprometido, 0), consolidado: f.consolidado, comprometido: f.comprometido, al: f.al };
}

// Tiendas de las que se puede pedir un medicamento, con cuánto tienen disponible y desde cuándo es ese dato.
export async function origenesPara(idDestino, idMedicamento) {
  const r = await central.query(
    `select t.id_tienda, t.nombre, t.ciudad, i.cantidad_disponible::int as consolidado, i.fecha_sincronizacion as al,
            coalesce((select sum(d.cantidad) from traslado x join detalle_traslado d on d.id_traslado = x.id_traslado
                      where x.id_tienda_origen = t.id_tienda and d.id_medicamento = $2 and x.estado = 'SOLICITADO'), 0)::int as comprometido
     from tienda t join inventario_consolidado i on i.id_tienda = t.id_tienda and i.id_medicamento = $2
     where t.activa and t.id_tienda <> $1 and i.cantidad_disponible > 0
     order by i.cantidad_disponible desc, t.nombre`,
    [idDestino, idMedicamento],
  );
  return {
    origenes: r.rows
      .map((f) => ({ ...f, disponible: Math.max(f.consolidado - f.comprometido, 0) }))
      .filter((f) => f.disponible > 0),
  };
}

// Criterio 1: el administrador de la tienda destino solicita el traslado desde una tienda origen con stock disponible.
export async function solicitarTraslado(sesion, key, body) {
  const idOrigen = entero(body?.id_tienda_origen, "id_tienda_origen");
  const idMedicamento = entero(body?.id_medicamento, "id_medicamento");
  const cantidad = entero(body?.cantidad, "cantidad", MAX_CANTIDAD);
  const observaciones = String(body?.observaciones ?? "").trim().slice(0, 300) || null;
  const idDestino = runtime.tiendaId;
  if (Number(sesion.id_tienda) !== Number(idDestino)) throw new ErrorNegocio(403, "ACCESO_DENEGADO", "Solo se solicitan traslados hacia la propia tienda");
  if (idOrigen === idDestino) throw invalido("La tienda origen debe ser otra tienda de la red", { campo: "id_tienda_origen" });

  return conIdempotencia(central, { key, operacion: "TRASLADO_SOLICITAR", idEmpleado: sesion.id_empleado, body }, async (client) => {
    // Quien solicita se relee en el central (la réplica del POS puede ir atrasada).
    const actor = await client.query(
      `select e.id_empleado from empleado e
       where e.id_empleado = $1 and e.id_tienda = $2 and e.activo and e.fecha_baja is null
         and exists (select 1 from rol_permiso rp join permiso p on p.id_permiso = rp.id_permiso where rp.id_rol = e.id_rol and p.codigo = 'INVENTARIO_GESTIONAR')`,
      [sesion.id_empleado, idDestino],
    );
    if (actor.rowCount === 0) throw new ErrorNegocio(403, "ACCESO_DENEGADO", "Solo un administrador de la tienda puede solicitar traslados");
    const tiendas = await client.query("select id_tienda, activa from tienda where id_tienda = any($1::int[])", [[idOrigen, idDestino]]);
    const origen = tiendas.rows.find((t) => t.id_tienda === idOrigen);
    if (!origen) throw invalido("La tienda origen no existe", { campo: "id_tienda_origen" });
    if (!origen.activa) throw conflicto("TIENDA_INACTIVA", "La tienda origen está inactiva");
    const med = await client.query("select activo from medicamento where id_medicamento = $1", [idMedicamento]);
    if (!med.rows[0]?.activo) throw invalido("El medicamento no existe o está inactivo", { campo: "id_medicamento" });

    // Criterio 5 (primera barrera): dos solicitudes simultáneas sobre la misma tienda y medicamento se hacen en fila, y cada una
    // ve lo que la otra ya comprometió. La barrera definitiva es la tienda origen, con sus lotes bloqueados.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`hu17:${idOrigen}:${idMedicamento}`]);
    const d = await disponibleEn(client, idOrigen, idMedicamento);
    if (cantidad > d.disponible) {
      throw conflicto("STOCK_INSUFICIENTE_ORIGEN", `La tienda origen tiene ${d.disponible} unidades disponibles para trasladar`, {
        disponible: d.disponible,
        consolidado: d.consolidado,
        comprometido: d.comprometido,
        al: d.al,
      });
    }

    const creado = await client.query(
      `insert into traslado (id_tienda_origen, id_tienda_destino, id_empleado_solicitante, estado, observaciones, idempotency_key, actualizado_en)
       values ($1, $2, $3, 'SOLICITADO', $4, $5, now()) returning id_traslado`,
      [idOrigen, idDestino, sesion.id_empleado, observaciones, key],
    );
    const id = creado.rows[0].id_traslado;
    await client.query("insert into detalle_traslado (id_traslado, id_medicamento, cantidad) values ($1, $2, $3)", [id, idMedicamento, cantidad]);
    const t = await trasladoDe(client, id);
    await emitir(client, idOrigen, "TRASLADO_DESCONTAR", carga(t));
    await auditarCentral(client, sesion.id_empleado, "TRASLADO_SOLICITAR", id, `de ${t.tienda_origen} a ${t.tienda_destino}: ${cantidad} u. de ${t.items[0].nombre_comercial}`);
    return { status: 201, body: t };
  });
}

// ---- Respuestas de las tiendas (outbox -> central) ----

// Se aplica una sola vez por clave (inbox_sync) y solo si la tienda que responde es la que corresponde.
async function recibir(client, idTienda, event, rol) {
  const inbox = await client.query(
    `insert into inbox_sync (id_tienda_origen, idempotency_key, tipo_evento, payload)
     values ($1, $2, $3, $4::jsonb) on conflict (id_tienda_origen, idempotency_key) do nothing`,
    [idTienda, event.idempotency_key, event.tipo_evento, JSON.stringify(event.payload)],
  );
  if (inbox.rowCount === 0) return null; // duplicado
  const t = await trasladoDe(client, event.payload.id_traslado, { bloquear: true }).catch(() => null);
  if (!t) return null;
  const esperada = rol === "ORIGEN" ? t.id_tienda_origen : t.id_tienda_destino;
  if (Number(esperada) !== Number(idTienda)) return null; // una tienda que no es parte del traslado no lo mueve
  return t;
}

async function cambiar(client, t, desde, hacia, { motivo = null, confirmar = false } = {}) {
  if (t.estado !== desde) return false; // tardío o fuera de orden: el estado ya avanzó
  await client.query(
    `update traslado set estado = $2, motivo = coalesce($3, motivo), actualizado_en = now()${confirmar ? ", fecha_confirmacion = now()" : ""} where id_traslado = $1`,
    [t.id_traslado, hacia, motivo],
  );
  await auditarCentral(client, null, `TRASLADO_${hacia}`, t.id_traslado, `${t.tienda_origen} -> ${t.tienda_destino}${motivo ? `: ${motivo}` : ""}`);
  return true;
}

async function descontado(client, idTienda, event) {
  const t = await recibir(client, idTienda, event, "ORIGEN");
  if (!t || !(await cambiar(client, t, "SOLICITADO", "EN_TRANSITO"))) return;
  for (const item of event.payload.items ?? []) {
    await client.query("update detalle_traslado set lotes = $3::jsonb where id_traslado = $1 and id_medicamento = $2", [t.id_traslado, item.id_medicamento, JSON.stringify(item.lotes)]);
  }
  const actual = await trasladoDe(client, t.id_traslado);
  await emitir(client, t.id_tienda_destino, "TRASLADO_INGRESAR", carga(actual));
  await avisarEstado(client, actual, "EN_TRANSITO");
}

async function rechazado(client, idTienda, event) {
  const t = await recibir(client, idTienda, event, "ORIGEN");
  if (!t || !(await cambiar(client, t, "SOLICITADO", "FALLIDO", { motivo: event.payload.motivo }))) return;
  await avisarEstado(client, t, "FALLIDO", event.payload.motivo);
}

async function recibido(client, idTienda, event) {
  const t = await recibir(client, idTienda, event, "DESTINO");
  if (!t || !(await cambiar(client, t, "EN_TRANSITO", "COMPLETADO", { confirmar: true }))) return;
  await avisarEstado(client, t, "COMPLETADO");
}

async function ingresoFallido(client, idTienda, event) {
  const t = await recibir(client, idTienda, event, "DESTINO");
  if (!t || !(await cambiar(client, t, "EN_TRANSITO", "COMPENSANDO", { motivo: event.payload.motivo }))) return;
  // Criterio 3: la compensación se ordena sola; nadie tiene que acordarse de devolver el stock al origen.
  await emitir(client, t.id_tienda_origen, "TRASLADO_COMPENSAR", { ...carga(t), motivo: event.payload.motivo });
  await avisarEstado(client, t, "COMPENSANDO", event.payload.motivo);
}

async function compensado(client, idTienda, event) {
  const t = await recibir(client, idTienda, event, "ORIGEN");
  if (!t || !(await cambiar(client, t, "COMPENSANDO", "COMPENSADO", { confirmar: true }))) return;
  await avisarEstado(client, t, "COMPENSADO", t.motivo);
}

export const APLICADORES_TRASLADO = {
  TRASLADO_DESCONTADO: descontado,
  TRASLADO_RECHAZADO: rechazado,
  TRASLADO_RECIBIDO: recibido,
  TRASLADO_INGRESO_FALLIDO: ingresoFallido,
  TRASLADO_COMPENSADO: compensado,
};

// ---- Consulta en el central ----

export async function detalleTraslado(idTraslado) {
  return trasladoDe(central, idTraslado);
}

export async function listarTraslados({ idTienda = null } = {}) {
  const r = await central.query(
    `select t.id_traslado, t.estado, t.motivo, t.fecha_solicitud, t.fecha_confirmacion, t.actualizado_en,
            t.id_tienda_origen, o.nombre as tienda_origen, t.id_tienda_destino, d.nombre as tienda_destino, e.nombre_completo as solicitante,
            (select json_agg(json_build_object('id_medicamento', x.id_medicamento, 'nombre_comercial', m.nombre_comercial, 'cantidad', x.cantidad))
             from detalle_traslado x join medicamento m on m.id_medicamento = x.id_medicamento where x.id_traslado = t.id_traslado) as items
     from traslado t
     join tienda o on o.id_tienda = t.id_tienda_origen
     join tienda d on d.id_tienda = t.id_tienda_destino
     join empleado e on e.id_empleado = t.id_empleado_solicitante
     where ($1::int is null or $1 in (t.id_tienda_origen, t.id_tienda_destino))
     order by t.fecha_solicitud desc, t.id_traslado desc limit 100`,
    [idTienda],
  );
  return { traslados: r.rows };
}
