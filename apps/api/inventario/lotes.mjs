import { conflicto, invalido, noEncontrado, ErrorNegocio } from "../errores.mjs";
import { registrarMovimiento } from "./movimientos.mjs";
import { encolarStockSnapshot } from "./stock.mjs";

// HU-02 (RF-02, RF-04, RF-23). Todas las funciones corren dentro de la transacción del llamador.

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function obligatorio(campo, mensaje) {
  return new ErrorNegocio(400, "CAMPO_OBLIGATORIO", mensaje, { campo });
}

function entero(valor) {
  const numero = Number(valor);
  return Number.isInteger(numero) ? numero : NaN;
}

export async function auditar(client, idEmpleado, accion, entidad, idEntidad, detalle) {
  await client.query(
    `insert into registro_actividad (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
     values ($1, $2, $3, $4, $5)`,
    [idEmpleado, accion, entidad, idEntidad, detalle ? String(detalle).slice(0, 400) : null],
  );
}

// Criterios 1 y 5: número de lote, caducidad y proveedor obligatorios, con el campo exacto en el error.
async function validarDatosLote(client, datos, { conProveedor = true } = {}) {
  const numeroLote = String(datos.numero_lote ?? "").trim();
  if (!numeroLote) throw obligatorio("numero_lote", "El número de lote es obligatorio");
  if (numeroLote.length > 60) throw invalido("El número de lote admite máximo 60 caracteres", { campo: "numero_lote" });

  const fecha = String(datos.fecha_caducidad ?? "").trim();
  if (!fecha) throw obligatorio("fecha_caducidad", "La fecha de caducidad es obligatoria");
  if (!FECHA_RE.test(fecha)) throw invalido("La fecha de caducidad debe tener el formato AAAA-MM-DD", { campo: "fecha_caducidad" });

  let idProveedor = null;
  if (conProveedor) {
    if (datos.id_proveedor == null || datos.id_proveedor === "") throw obligatorio("id_proveedor", "El proveedor es obligatorio");
    idProveedor = entero(datos.id_proveedor);
    if (Number.isNaN(idProveedor)) throw invalido("Proveedor no válido", { campo: "id_proveedor" });
  }

  if (datos.id_medicamento == null || datos.id_medicamento === "") throw obligatorio("id_medicamento", "El medicamento es obligatorio");
  const idMedicamento = entero(datos.id_medicamento);
  if (Number.isNaN(idMedicamento)) throw invalido("Medicamento no válido", { campo: "id_medicamento" });

  const cantidad = entero(datos.cantidad);
  if (Number.isNaN(cantidad) || cantidad <= 0) throw invalido("La cantidad debe ser un entero mayor que cero", { campo: "cantidad" });

  // La validez y la comparación con "hoy" las decide la base (current_date), no el reloj del API.
  let futura;
  try {
    const result = await client.query("select $1::date > current_date as futura", [fecha]);
    futura = result.rows[0].futura;
  } catch {
    throw invalido("La fecha de caducidad no es una fecha válida", { campo: "fecha_caducidad" });
  }
  if (!futura) throw invalido("La fecha de caducidad debe ser posterior a hoy", { campo: "fecha_caducidad" });

  const medicamento = await client.query(
    "select nombre_comercial from medicamento_ref where id_medicamento = $1 and activo = true",
    [idMedicamento],
  );
  if (medicamento.rowCount === 0) throw invalido("El medicamento no existe o está inactivo", { campo: "id_medicamento" });
  if (conProveedor) {
    const proveedor = await client.query("select 1 from proveedor_ref where id_proveedor = $1 and activo = true", [idProveedor]);
    if (proveedor.rowCount === 0) throw invalido("El proveedor no existe o está inactivo", { campo: "id_proveedor" });
  }

  return { numeroLote, fecha, idProveedor, idMedicamento, cantidad };
}

// Crea el lote o, si ya existe con la misma caducidad, le suma una entrada.
async function entradaEnLote(client, datos, ctx) {
  const existente = await client.query(
    `select id_lote, fecha_caducidad from lote
     where id_medicamento = $1 and id_proveedor = $2 and numero_lote = $3
     for update`,
    [datos.idMedicamento, datos.idProveedor, datos.numeroLote],
  );
  let idLote;
  let nuevo = false;
  if (existente.rowCount > 0) {
    const lote = existente.rows[0];
    if (lote.fecha_caducidad !== datos.fecha) {
      throw conflicto(
        "LOTE_INCONSISTENTE",
        `El lote ${datos.numeroLote} ya existe con caducidad ${lote.fecha_caducidad}`,
        { id_lote: lote.id_lote, fecha_caducidad: lote.fecha_caducidad },
      );
    }
    idLote = lote.id_lote;
  } else {
    // Se crea en 0 y la primera ENTRADA lo lleva a cantidad_inicial: el saldo siempre es la suma de movimientos.
    const creado = await client.query(
      `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
       values ($1, $2, $3, $4, $5, 0, 'AGOTADO')
       returning id_lote`,
      [datos.idMedicamento, datos.idProveedor, datos.numeroLote, datos.fecha, datos.cantidad],
    );
    idLote = creado.rows[0].id_lote;
    nuevo = true;
  }
  const movimiento = await registrarMovimiento(client, {
    idLote,
    tipo: "ENTRADA",
    cantidad: datos.cantidad,
    idEmpleado: ctx.idEmpleado,
    idTienda: ctx.idTienda,
    referencia: ctx.referencia,
    observaciones: ctx.observaciones,
    publicarStock: ctx.publicarStock,
  });
  return { id_lote: idLote, nuevo, movimiento };
}

export async function registrarLote(client, body, ctx) {
  const datos = await validarDatosLote(client, body);
  const observaciones = body.observaciones ? String(body.observaciones).trim().slice(0, 300) : null;
  const resultado = await entradaEnLote(client, datos, { ...ctx, referencia: "REGISTRO_MANUAL", observaciones });
  await auditar(
    client,
    ctx.idEmpleado,
    "LOTE_REGISTRAR",
    "lote",
    resultado.id_lote,
    `${resultado.nuevo ? "nuevo" : "entrada adicional"} lote ${datos.numeroLote}, ${datos.cantidad} u.`,
  );
  return { ...(await detalleLote(client, resultado.id_lote)), nuevo: resultado.nuevo };
}

// RF-23 / Pedido.confirmarRecepcion(): todo o nada.
export async function recibirPedido(client, idPedido, body, ctx) {
  const lineas = Array.isArray(body?.lineas) ? body.lineas : [];
  if (lineas.length === 0) throw invalido("La recepción debe tener al menos una línea");

  const pedido = await client.query("select * from pedido where id_pedido = $1 for update", [idPedido]);
  if (pedido.rowCount === 0) throw noEncontrado(`El pedido ${idPedido} no existe`);
  const { estado, id_proveedor: idProveedor } = pedido.rows[0];
  if (!["SOLICITADO", "RECIBIDO_PARCIAL"].includes(estado)) {
    throw conflicto("PEDIDO_CERRADO", `El pedido está ${estado} y no admite recepciones`);
  }

  const detalle = await client.query(
    "select id_medicamento, cantidad_solicitada, cantidad_recibida from detalle_pedido where id_pedido = $1 for update",
    [idPedido],
  );
  const pendiente = new Map(detalle.rows.map((row) => [row.id_medicamento, row.cantidad_solicitada - row.cantidad_recibida]));

  // Validar todas las líneas antes de escribir nada.
  const validadas = [];
  for (const [indice, linea] of lineas.entries()) {
    let datos;
    try {
      datos = await validarDatosLote(client, { ...linea, id_proveedor: idProveedor });
    } catch (error) {
      if (error instanceof ErrorNegocio) error.extra = { ...error.extra, linea: indice + 1 };
      throw error;
    }
    if (!pendiente.has(datos.idMedicamento)) {
      throw invalido(`Línea ${indice + 1}: el medicamento no está en este pedido`, { linea: indice + 1 });
    }
    const resta = pendiente.get(datos.idMedicamento) - datos.cantidad;
    if (resta < 0) {
      throw invalido(`Línea ${indice + 1}: se reciben más unidades de las pendientes (${pendiente.get(datos.idMedicamento)})`, {
        linea: indice + 1,
        pendiente: pendiente.get(datos.idMedicamento),
      });
    }
    pendiente.set(datos.idMedicamento, resta);
    validadas.push(datos);
  }

  const referencia = `PEDIDO-${idPedido}`;
  const lotes = [];
  for (const datos of validadas) {
    const resultado = await entradaEnLote(client, datos, { ...ctx, referencia, publicarStock: false });
    await client.query(
      "update detalle_pedido set cantidad_recibida = cantidad_recibida + $3 where id_pedido = $1 and id_medicamento = $2",
      [idPedido, datos.idMedicamento, datos.cantidad],
    );
    lotes.push(resultado.id_lote);
  }
  const completo = [...pendiente.values()].every((valor) => valor === 0);
  const nuevoEstado = completo ? "RECIBIDO_TOTAL" : "RECIBIDO_PARCIAL";
  await client.query("update pedido set estado = $2, fecha_recepcion = now() where id_pedido = $1", [idPedido, nuevoEstado]);
  await encolarStockSnapshot(client, { idTienda: ctx.idTienda, idsMedicamento: validadas.map((datos) => datos.idMedicamento) });
  await auditar(client, ctx.idEmpleado, "PEDIDO_RECIBIR", "pedido", idPedido, `${validadas.length} línea(s); estado ${nuevoEstado}`);
  return { id_pedido: idPedido, estado: nuevoEstado, lotes };
}

export async function ajustarLote(client, idLote, body, ctx) {
  const sentidos = { SUMA: 1, RESTA: -1 };
  const sentido = sentidos[String(body?.sentido || "").toUpperCase()];
  if (!sentido) throw obligatorio("sentido", "Indique si el ajuste suma o resta unidades");
  const cantidad = entero(body?.cantidad);
  if (Number.isNaN(cantidad) || cantidad <= 0) throw invalido("La cantidad debe ser un entero mayor que cero", { campo: "cantidad" });
  const motivo = String(body?.motivo ?? "").trim();
  if (motivo.length < 5) throw obligatorio("motivo", "El motivo es obligatorio (mínimo 5 caracteres)");

  const movimiento = await registrarMovimiento(client, {
    idLote,
    tipo: "AJUSTE",
    sentido,
    cantidad,
    idEmpleado: ctx.idEmpleado,
    idTienda: ctx.idTienda,
    referencia: "AJUSTE_MANUAL",
    observaciones: motivo,
  });
  await auditar(client, ctx.idEmpleado, "LOTE_AJUSTAR", "lote", idLote, `${sentido > 0 ? "+" : "-"}${cantidad} u. ${motivo}`);
  return { ...(await detalleLote(client, idLote)), movimiento };
}

// ---- Consultas ----

const SELECT_LOTE = `
  select l.id_lote, l.numero_lote, l.fecha_ingreso, l.fecha_caducidad, l.cantidad_inicial, l.cantidad_disponible,
         l.estado, l.fecha_registro, l.fecha_caducidad < current_date as vencido,
         (l.fecha_caducidad - current_date) as dias_para_vencer,
         l.id_medicamento, m.codigo_interno, m.nombre_comercial, m.principio_activo,
         m.requiere_refrigeracion, m.requiere_receta,
         l.id_proveedor, p.nombre_empresa as proveedor,
         coalesce(u.dias_alerta_caducidad, 30) as dias_alerta_caducidad
  from lote l
  join medicamento_ref m on m.id_medicamento = l.id_medicamento
  join proveedor_ref p on p.id_proveedor = l.id_proveedor
  left join umbral_stock_ref u on u.id_medicamento = l.id_medicamento`;

export async function detalleLote(client, idLote) {
  const result = await client.query(`${SELECT_LOTE} where l.id_lote = $1`, [idLote]);
  if (result.rowCount === 0) throw noEncontrado(`El lote ${idLote} no existe`);
  return result.rows[0];
}

export async function listarLotes(client, query) {
  const condiciones = [];
  const valores = [];
  if (query.id_medicamento) {
    valores.push(entero(query.id_medicamento));
    condiciones.push(`l.id_medicamento = $${valores.length}`);
  }
  if (query.estado) {
    valores.push(String(query.estado).toUpperCase());
    condiciones.push(`l.estado = $${valores.length}`);
  }
  if (query.vence_en_dias) {
    valores.push(entero(query.vence_en_dias));
    condiciones.push(`l.fecha_caducidad <= current_date + $${valores.length}::int`);
  }
  if (valores.some((valor) => Number.isNaN(valor))) throw invalido("Filtro no válido");
  const where = condiciones.length ? `where ${condiciones.join(" and ")}` : "";
  const result = await client.query(`${SELECT_LOTE} ${where} order by l.fecha_caducidad, l.id_lote limit 200`, valores);
  return result.rows;
}

// Criterio 4: historial completo con saldo acumulado y verificación contra el saldo del lote.
export async function historialLote(client, idLote) {
  const lote = await detalleLote(client, idLote);
  const movimientos = await client.query(
    `select mi.id_movimiento, mi.tipo_movimiento, mi.sentido, mi.cantidad, mi.fecha_hora,
            mi.referencia_documento, mi.observaciones, mi.id_empleado, e.nombre_completo as empleado, e.usuario
     from movimiento_inventario mi
     join empleado_ref e on e.id_empleado = mi.id_empleado
     where mi.id_lote = $1
     order by mi.fecha_hora, mi.id_movimiento`,
    [idLote],
  );
  let saldo = 0;
  const filas = movimientos.rows.map((movimiento) => {
    saldo += movimiento.sentido * movimiento.cantidad;
    return { ...movimiento, saldo };
  });
  return { lote, movimientos: filas, saldo_reconstruido: saldo, consistente: saldo === Number(lote.cantidad_disponible) };
}

export async function detalleMedicamento(client, idMedicamento) {
  const medicamento = await client.query(
    `select m.*, c.nombre as categoria, u.stock_minimo, u.dias_alerta_caducidad
     from medicamento_ref m
     left join categoria_ref c on c.id_categoria = m.id_categoria
     left join umbral_stock_ref u on u.id_medicamento = m.id_medicamento
     where m.id_medicamento = $1`,
    [idMedicamento],
  );
  if (medicamento.rowCount === 0) throw noEncontrado(`El medicamento ${idMedicamento} no existe`);
  const lotes = await listarLotes(client, { id_medicamento: idMedicamento });
  return { ...medicamento.rows[0], lotes };
}

export async function listarProveedores(client) {
  const result = await client.query(
    "select id_proveedor, nombre_empresa from proveedor_ref where activo = true order by nombre_empresa",
  );
  return result.rows;
}

export async function listarPedidosPendientes(client) {
  const result = await client.query(
    `select p.id_pedido, p.estado, p.fecha_solicitud, p.origen_solicitud, p.id_proveedor, pr.nombre_empresa as proveedor,
            coalesce(json_agg(json_build_object(
              'id_medicamento', d.id_medicamento,
              'nombre_comercial', m.nombre_comercial,
              'requiere_refrigeracion', m.requiere_refrigeracion,
              'cantidad_solicitada', d.cantidad_solicitada,
              'cantidad_recibida', d.cantidad_recibida
            ) order by m.nombre_comercial) filter (where d.id_medicamento is not null), '[]') as lineas
     from pedido p
     join proveedor_ref pr on pr.id_proveedor = p.id_proveedor
     left join detalle_pedido d on d.id_pedido = p.id_pedido
     left join medicamento_ref m on m.id_medicamento = d.id_medicamento
     where p.estado in ('SOLICITADO', 'RECIBIDO_PARCIAL')
     group by p.id_pedido, pr.nombre_empresa
     order by p.fecha_solicitud`,
  );
  return result.rows;
}
