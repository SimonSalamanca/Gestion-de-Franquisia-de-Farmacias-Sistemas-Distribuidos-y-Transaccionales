import { local } from "./db.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { conflicto, invalido, noEncontrado } from "./errores.mjs";
import { auditar } from "./inventario/lotes.mjs";

// HU-13: solicitudes de reabastecimiento (RF-09, regla de negocio 11). Una solicitud es una fila de pedido con sus
// líneas en detalle_pedido, todo en la base de la tienda: se genera y se consulta aunque no haya conexión con el central
// (RNF-04). El único dato que viene de la red es el proveedor, que la tienda ya tiene replicado en proveedor_ref.
// La recepción de la mercancía es de HU-02/HU-14 (recibirPedido); aquí se crea la solicitud y se sigue su estado.

// Estado interno -> estado que ve el usuario (criterio 5: pendiente, enviada, recibida).
export const ESTADO_VISIBLE = {
  SOLICITADO: "PENDIENTE",
  ENVIADO: "ENVIADA",
  RECIBIDO_PARCIAL: "RECIBIDA_PARCIAL",
  RECIBIDO_TOTAL: "RECIBIDA",
  CANCELADO: "CANCELADA",
};
const INTERNO_DE = Object.fromEntries(Object.entries(ESTADO_VISIBLE).map(([interno, visible]) => [visible, interno]));
const ABIERTOS = ["SOLICITADO", "ENVIADO", "RECIBIDO_PARCIAL"];
const TIPOS_REABASTECIBLES = ["STOCK_BAJO", "STOCK_AGOTADO"];
const MAX_LINEAS = 50;
const MAX_CANTIDAD = 100000;
const MAX_RESULTADOS = 100;

const entero = (valor, campo) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw invalido(`${campo} no válido`, { campo });
  return n;
};
export const idSolicitudDe = (valor) => entero(valor, "id_pedido");
export const idAlertaDe = (valor) => entero(valor, "id_alerta");

function cantidadDe(valor, campo = "cantidad") {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CANTIDAD) {
    throw invalido(`La cantidad debe ser un entero entre 1 y ${MAX_CANTIDAD}`, { campo });
  }
  return n;
}

const observacionesDe = (valor) => {
  const limpio = String(valor ?? "").trim();
  if (limpio.length > 300) throw invalido("Las observaciones admiten máximo 300 caracteres", { campo: "observaciones" });
  return limpio || null;
};

// ---- Consultas ----

const SELECT_SOLICITUD = `
  select p.id_pedido, p.estado, p.origen_solicitud, p.id_alerta, p.fecha_solicitud, p.fecha_envio, p.fecha_recepcion,
         p.con_diferencia, p.observaciones, p.id_proveedor, pr.nombre_empresa as proveedor, e.nombre_completo as solicitante,
         a.tipo as alerta_tipo,
         coalesce(json_agg(json_build_object(
           'id_medicamento', d.id_medicamento,
           'codigo_interno', m.codigo_interno,
           'nombre_comercial', m.nombre_comercial,
           'cantidad_solicitada', d.cantidad_solicitada,
           'cantidad_recibida', d.cantidad_recibida
         ) order by m.nombre_comercial) filter (where d.id_medicamento is not null), '[]') as lineas
  from pedido p
  join proveedor_ref pr on pr.id_proveedor = p.id_proveedor
  join empleado_ref e on e.id_empleado = p.id_empleado_solicitante
  left join alerta a on a.id_alerta = p.id_alerta
  left join detalle_pedido d on d.id_pedido = p.id_pedido
  left join medicamento_ref m on m.id_medicamento = d.id_medicamento`;
const GRUPO_SOLICITUD = "group by p.id_pedido, pr.nombre_empresa, e.nombre_completo, a.tipo";

const conEstadoVisible = (fila) => ({ ...fila, estado_visible: ESTADO_VISIBLE[fila.estado] });

export async function detalleSolicitud(db, idPedido) {
  const r = await db.query(`${SELECT_SOLICITUD} where p.id_pedido = $1 ${GRUPO_SOLICITUD}`, [idPedido]);
  if (r.rowCount === 0) throw noEncontrado("La solicitud no existe");
  return conEstadoVisible(r.rows[0]);
}

// Criterio 5: el estado de cada solicitud. Filtros: estado (visible: PENDIENTE, ENVIADA, RECIBIDA, RECIBIDA_PARCIAL,
// CANCELADA) y proveedor.
export async function listarSolicitudes(query = {}) {
  const visible = query.estado ? String(query.estado).toUpperCase() : null;
  if (visible && !INTERNO_DE[visible]) throw invalido("Estado no válido", { campo: "estado" });
  const idProveedor = query.id_proveedor ? entero(query.id_proveedor, "id_proveedor") : null;
  const filas = await local.query(
    `${SELECT_SOLICITUD}
     where ($1::text is null or p.estado = $1) and ($2::int is null or p.id_proveedor = $2)
     ${GRUPO_SOLICITUD}
     order by p.fecha_solicitud desc, p.id_pedido desc
     limit ${MAX_RESULTADOS}`,
    [visible ? INTERNO_DE[visible] : null, idProveedor],
  );
  const resumen = await local.query("select estado, count(*)::int as total from pedido group by estado");
  const porEstado = Object.fromEntries(Object.values(ESTADO_VISIBLE).map((v) => [v, 0]));
  for (const f of resumen.rows) porEstado[ESTADO_VISIBLE[f.estado]] = f.total;
  return { solicitudes: filas.rows.map(conEstadoVisible), resumen: porEstado };
}

// Medicamentos para armar una solicitud manual, con su stock vendible y su mínimo para decidir la cantidad.
export async function buscarMedicamentos(query = {}) {
  const termino = String(query.q ?? "").trim().toLowerCase();
  if (termino.length > 80) throw invalido("El término admite máximo 80 caracteres", { campo: "q" });
  const patron = `%${termino.replace(/[\\%_]/g, "\\$&")}%`;
  const filas = await local.query(
    `select m.id_medicamento, m.codigo_interno, m.nombre_comercial, m.principio_activo,
            coalesce(s.vendible, 0)::int as stock, u.stock_minimo
     from medicamento_ref m
     left join umbral_stock_ref u on u.id_medicamento = m.id_medicamento
     left join lateral (
       select sum(l.cantidad_disponible) as vendible from lote l
       where l.id_medicamento = m.id_medicamento and l.estado = 'DISPONIBLE' and l.fecha_caducidad >= current_date
     ) s on true
     where m.activo = true
       and ($1 = '%%' or lower(m.nombre_comercial) like $1 escape '\\' or lower(m.principio_activo) like $1 escape '\\'
            or lower(m.codigo_interno) like $1 escape '\\')
     order by m.nombre_comercial
     limit 30`,
    [patron],
  );
  return { medicamentos: filas.rows };
}

// Criterio 2: lo que la solicitud necesita saber de una alerta de stock, sin volver a teclear el producto. La cantidad
// sugerida repone hasta el doble del mínimo; el proveedor sugerido es el del último lote recibido de ese medicamento.
export async function sugerenciaDeAlerta(idAlerta) {
  const alerta = await local.query(
    `select a.id_alerta, a.tipo, a.nivel, a.estado, a.detalle, a.id_medicamento, m.codigo_interno, m.nombre_comercial,
            m.principio_activo
     from alerta a join medicamento_ref m on m.id_medicamento = a.id_medicamento
     where a.id_alerta = $1`,
    [idAlerta],
  );
  if (alerta.rowCount === 0) throw noEncontrado("La alerta no existe");
  const a = alerta.rows[0];
  if (!TIPOS_REABASTECIBLES.includes(a.tipo)) {
    throw conflicto("ALERTA_NO_REABASTECIBLE", "Solo las alertas de stock bajo o agotado generan una solicitud de reabastecimiento");
  }
  if (a.estado !== "ACTIVA") throw conflicto("ALERTA_RESUELTA", "La alerta ya se resolvió: el stock se repuso");
  const stock = Number(a.detalle.stock ?? 0);
  const minimo = Number(a.detalle.stock_minimo ?? 0);
  const proveedor = await local.query(
    `select pr.id_proveedor, pr.nombre_empresa
     from lote l join proveedor_ref pr on pr.id_proveedor = l.id_proveedor and pr.activo
     where l.id_medicamento = $1 order by l.fecha_registro desc, l.id_lote desc limit 1`,
    [a.id_medicamento],
  );
  const abierta = await local.query(
    "select id_pedido, estado from pedido where id_alerta = $1 and estado = any($2::text[]) limit 1",
    [idAlerta, ABIERTOS],
  );
  return {
    alerta: { id_alerta: a.id_alerta, tipo: a.tipo, nivel: a.nivel, detalle: a.detalle },
    medicamento: { id_medicamento: a.id_medicamento, codigo_interno: a.codigo_interno, nombre_comercial: a.nombre_comercial, principio_activo: a.principio_activo },
    stock,
    stock_minimo: minimo,
    cantidad_sugerida: Math.max(minimo * 2 - stock, 1),
    proveedor_sugerido: proveedor.rows[0] ?? null,
    solicitud_abierta: abierta.rows[0] ? { id_pedido: abierta.rows[0].id_pedido, estado_visible: ESTADO_VISIBLE[abierta.rows[0].estado] } : null,
  };
}

// ---- Escritura ----

// Criterio 4: sin proveedor no hay solicitud. Debe existir y estar activo en el registro que tiene la tienda.
async function exigirProveedor(client, valor) {
  if (valor == null || valor === "") {
    throw invalido("La solicitud necesita un proveedor", { campo: "id_proveedor", codigo: "PROVEEDOR_OBLIGATORIO" });
  }
  const idProveedor = entero(valor, "id_proveedor");
  const proveedor = await client.query("select id_proveedor, nombre_empresa, activo from proveedor_ref where id_proveedor = $1", [idProveedor]);
  if (proveedor.rowCount === 0) throw invalido("El proveedor no existe", { campo: "id_proveedor" });
  if (!proveedor.rows[0].activo) throw conflicto("PROVEEDOR_INACTIVO", "El proveedor está inactivo: elija otro o actívelo antes");
  return proveedor.rows[0];
}

// Criterios 2 y 3: desde una alerta (con id_alerta: el producto y la cantidad sugerida salen de ella) o manual.
// Misma Idempotency-Key = misma solicitud: un doble clic o un reintento tras un corte no crea otra.
export async function crearSolicitud(sesion, key, body) {
  const idAlerta = body?.id_alerta == null || body.id_alerta === "" ? null : idAlertaDe(body.id_alerta);
  const observaciones = observacionesDe(body?.observaciones);
  return conIdempotencia(local, { key, operacion: "SOLICITUD_CREAR", idEmpleado: sesion.id_empleado, body }, async (client) => {
    const proveedor = await exigirProveedor(client, body?.id_proveedor);

    let lineas;
    if (idAlerta) {
      const a = await client.query(
        `select a.tipo, a.estado, a.detalle, a.id_medicamento, m.activo as medicamento_activo
         from alerta a join medicamento_ref m on m.id_medicamento = a.id_medicamento where a.id_alerta = $1`,
        [idAlerta],
      );
      if (a.rowCount === 0) throw noEncontrado("La alerta no existe");
      const alerta = a.rows[0];
      if (!TIPOS_REABASTECIBLES.includes(alerta.tipo)) {
        throw conflicto("ALERTA_NO_REABASTECIBLE", "Solo las alertas de stock bajo o agotado generan una solicitud de reabastecimiento");
      }
      if (alerta.estado !== "ACTIVA") throw conflicto("ALERTA_RESUELTA", "La alerta ya se resolvió: el stock se repuso");
      if (!alerta.medicamento_activo) throw conflicto("MEDICAMENTO_INACTIVO", "El medicamento está dado de baja");
      const sugerida = Math.max(Number(alerta.detalle.stock_minimo ?? 0) * 2 - Number(alerta.detalle.stock ?? 0), 1);
      lineas = [{ id_medicamento: alerta.id_medicamento, cantidad: body?.cantidad == null || body.cantidad === "" ? sugerida : cantidadDe(body.cantidad) }];
    } else {
      const crudas = Array.isArray(body?.lineas) ? body.lineas : [];
      if (crudas.length === 0) throw invalido("La solicitud necesita al menos un producto", { campo: "lineas" });
      if (crudas.length > MAX_LINEAS) throw invalido(`Una solicitud admite máximo ${MAX_LINEAS} productos`, { campo: "lineas" });
      lineas = crudas.map((linea, i) => ({
        id_medicamento: entero(linea?.id_medicamento, `lineas[${i + 1}].id_medicamento`),
        cantidad: cantidadDe(linea?.cantidad, `lineas[${i + 1}].cantidad`),
      }));
      if (new Set(lineas.map((l) => l.id_medicamento)).size !== lineas.length) {
        throw invalido("Un producto no puede repetirse en la misma solicitud", { campo: "lineas" });
      }
      const activos = await client.query(
        "select id_medicamento from medicamento_ref where activo = true and id_medicamento = any($1::int[])",
        [lineas.map((l) => l.id_medicamento)],
      );
      if (activos.rowCount !== lineas.length) throw invalido("Algún medicamento no existe o está dado de baja", { campo: "lineas" });
    }

    let id;
    try {
      const creada = await client.query(
        `insert into pedido (id_proveedor, id_empleado_solicitante, origen_solicitud, id_alerta, observaciones)
         values ($1, $2, $3, $4, $5) returning id_pedido`,
        [proveedor.id_proveedor, sesion.id_empleado, idAlerta ? "ALERTA_AUTOMATICA" : "MANUAL", idAlerta, observaciones],
      );
      id = creada.rows[0].id_pedido;
    } catch (error) {
      // Dos administradores sobre la misma alerta: el índice único deja pasar a uno solo.
      if (error?.code === "23505") throw conflicto("SOLICITUD_DUPLICADA", "Esa alerta ya tiene una solicitud abierta");
      throw error;
    }
    await client.query(
      `insert into detalle_pedido (id_pedido, id_medicamento, cantidad_solicitada)
       select $1, l.id_medicamento, l.cantidad from unnest($2::int[], $3::int[]) as l(id_medicamento, cantidad)`,
      [id, lineas.map((l) => l.id_medicamento), lineas.map((l) => l.cantidad)],
    );
    await auditar(
      client,
      sesion.id_empleado,
      "SOLICITUD_CREAR",
      "pedido",
      id,
      `${idAlerta ? `desde la alerta ${idAlerta}` : "manual"}; ${proveedor.nombre_empresa}; ${lineas.length} línea(s)`,
    );
    return { status: 201, body: await detalleSolicitud(client, id) };
  });
}

const ACCIONES = {
  enviar: { desde: ["SOLICITADO"], a: "ENVIADO", auditoria: "SOLICITUD_ENVIAR" },
  cancelar: { desde: ["SOLICITADO", "ENVIADO"], a: "CANCELADO", auditoria: "SOLICITUD_CANCELAR" },
};

// Criterio 5: pasar una solicitud de pendiente a enviada, o cancelarla (con motivo) mientras no haya recibido nada.
// El bloqueo FOR UPDATE y el trigger de la base impiden que dos usuarios la muevan a la vez o la lleven a un estado
// que ya no corresponde (p. ej. cancelar una que se acaba de recibir).
export async function cambiarEstado(sesion, key, idPedido, accion, body) {
  const regla = ACCIONES[accion];
  const motivo = accion === "cancelar" ? String(body?.motivo ?? "").trim() : null;
  if (accion === "cancelar" && (motivo.length < 5 || motivo.length > 300)) {
    throw invalido("El motivo de la cancelación es obligatorio (5 a 300 caracteres)", { campo: "motivo" });
  }
  return conIdempotencia(local, { key, operacion: `SOLICITUD_${accion.toUpperCase()}:${idPedido}`, idEmpleado: sesion.id_empleado, body }, async (client) => {
    const actual = await client.query("select estado from pedido where id_pedido = $1 for update", [idPedido]);
    if (actual.rowCount === 0) throw noEncontrado("La solicitud no existe");
    const estado = actual.rows[0].estado;
    if (!regla.desde.includes(estado)) {
      throw conflicto(
        "TRANSICION_INVALIDA",
        `La solicitud está ${ESTADO_VISIBLE[estado].toLowerCase().replace("_", " ")} y no se puede ${accion === "enviar" ? "marcar como enviada" : "cancelar"}`,
        { estado_visible: ESTADO_VISIBLE[estado] },
      );
    }
    if (accion === "enviar") {
      await client.query("update pedido set estado = 'ENVIADO', fecha_envio = now() where id_pedido = $1", [idPedido]);
    } else {
      await client.query("update pedido set estado = 'CANCELADO', observaciones = $2 where id_pedido = $1", [idPedido, motivo]);
    }
    await auditar(client, sesion.id_empleado, regla.auditoria, "pedido", idPedido, motivo ? `motivo: ${motivo}` : `de ${ESTADO_VISIBLE[estado]} a ${ESTADO_VISIBLE[regla.a]}`);
    return { status: 200, body: await detalleSolicitud(client, idPedido) };
  });
}
