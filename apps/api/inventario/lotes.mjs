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
// Primero el formato (sin base); luego una sola consulta verifica todas las líneas contra la base.
function validarFormatoLote(datos, { conProveedor = true } = {}) {
  const numeroLote = String(datos.numero_lote ?? "").trim();
  if (!numeroLote) throw obligatorio("numero_lote", "El número de lote es obligatorio");
  if (numeroLote.length > 60) throw invalido("El número de lote admite máximo 60 caracteres", { campo: "numero_lote" });

  const fecha = String(datos.fecha_caducidad ?? "").trim();
  if (!fecha) throw obligatorio("fecha_caducidad", "La fecha de caducidad es obligatoria");
  if (!FECHA_RE.test(fecha)) throw invalido("La fecha de caducidad debe tener el formato AAAA-MM-DD", { campo: "fecha_caducidad" });
  // Fecha de calendario real (rechaza 2027-02-30, 2027-13-01, año 0000) sin consultar la base.
  const calendario = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(calendario.getTime()) || calendario.toISOString().slice(0, 10) !== fecha || calendario.getUTCFullYear() < 1) {
    throw invalido("La fecha de caducidad no es una fecha válida", { campo: "fecha_caducidad" });
  }

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

  return { numeroLote, fecha, idProveedor, idMedicamento, cantidad };
}

// Verifica en la base, en una ida y vuelta, las líneas ya validadas en formato: caducidad posterior a
// current_date (la decide la base, no el reloj del API), medicamento activo y proveedor activo.
// alError(indice, error) permite al llamador anotar la línea. Lanza el primer error en orden de línea.
async function verificarLotesEnBase(client, lineas, { alError = (indice, error) => error } = {}) {
  let filas;
  try {
    const result = await client.query(
      `select l.fecha::date > current_date as futura,
              exists (select 1 from medicamento_ref m where m.id_medicamento = l.medicamento and m.activo = true) as medicamento,
              l.proveedor is null
                or exists (select 1 from proveedor_ref p where p.id_proveedor = l.proveedor and p.activo = true) as proveedor
       from unnest($1::text[], $2::int[], $3::int[]) with ordinality as l(fecha, medicamento, proveedor, orden)
       order by l.orden`,
      [lineas.map((l) => l.fecha), lineas.map((l) => l.idMedicamento), lineas.map((l) => l.idProveedor)],
    );
    filas = result.rows;
  } catch (error) {
    // validarFormatoLote ya garantiza fechas de calendario válidas; si aun así la base rechaza una, se
    // responde como dato inválido. Cualquier otro error (conexión, etc.) sigue su curso.
    if (String(error.code || "").startsWith("22")) {
      throw invalido("La fecha de caducidad no es una fecha válida", { campo: "fecha_caducidad" });
    }
    throw error;
  }
  for (const [indice, fila] of filas.entries()) {
    if (!fila.futura) throw alError(indice, invalido("La fecha de caducidad debe ser posterior a hoy", { campo: "fecha_caducidad" }));
    if (!fila.medicamento) throw alError(indice, invalido("El medicamento no existe o está inactivo", { campo: "id_medicamento" }));
    if (!fila.proveedor) throw alError(indice, invalido("El proveedor no existe o está inactivo", { campo: "id_proveedor" }));
  }
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
  const datos = validarFormatoLote(body);
  await verificarLotesEnBase(client, [datos]);
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

// RF-23 / HU-14 / Pedido.confirmarRecepcion(): todo o nada, en una transacción.
// Cada recepción es un documento (recepcion + detalle_recepcion) ligado al pedido original. Si lo recibido no coincide con lo
// solicitado queda constancia (diferencia_recepcion):
//   - sobrante: llega más de lo pendiente; exige `motivo_diferencia`;
//   - faltante: `cerrar_con_diferencia: true` da por terminado el pedido aunque falten unidades; exige `motivo_diferencia`.
// Sin ninguna de las dos, lo que falta sigue pendiente y el pedido queda RECIBIDO_PARCIAL.
const MOTIVO_MIN = 5;
const MOTIVO_MAX = 300;

function motivoDe(valor) {
  const motivo = String(valor ?? "").trim();
  if (motivo.length > MOTIVO_MAX) throw invalido(`El motivo admite máximo ${MOTIVO_MAX} caracteres`, { campo: "motivo_diferencia" });
  return motivo;
}

function exigirMotivo(motivo, mensaje) {
  if (motivo.length < MOTIVO_MIN) throw invalido(mensaje, { campo: "motivo_diferencia", codigo: "MOTIVO_DIFERENCIA_OBLIGATORIO" });
}

function textoOpcional(valor, max, campo, etiqueta) {
  const limpio = String(valor ?? "").trim();
  if (limpio.length > max) throw invalido(`${etiqueta} admite máximo ${max} caracteres`, { campo });
  return limpio || null;
}

export async function recibirPedido(client, idPedido, body, ctx) {
  const lineas = Array.isArray(body?.lineas) ? body.lineas : [];
  if (lineas.length === 0) throw invalido("La recepción debe tener al menos una línea");
  const motivo = motivoDe(body?.motivo_diferencia);
  const cerrar = body?.cerrar_con_diferencia === true;
  const documento = textoOpcional(body?.documento_proveedor, 60, "documento_proveedor", "El documento del proveedor");
  const observaciones = textoOpcional(body?.observaciones, 300, "observaciones", "Las observaciones");

  const pedido = await client.query("select * from pedido where id_pedido = $1 for update", [idPedido]);
  if (pedido.rowCount === 0) throw noEncontrado(`El pedido ${idPedido} no existe`);
  const { estado, id_proveedor: idProveedor } = pedido.rows[0];
  // HU-13: una solicitud pendiente o ya marcada como enviada se puede recibir (la recepción no exige el paso "enviada").
  if (!["SOLICITADO", "ENVIADO", "RECIBIDO_PARCIAL"].includes(estado)) {
    throw conflicto("PEDIDO_CERRADO", `El pedido está ${estado} y no admite recepciones`);
  }

  const detalle = await client.query(
    `select d.id_medicamento, m.nombre_comercial, d.cantidad_solicitada, d.cantidad_recibida
     from detalle_pedido d join medicamento_ref m on m.id_medicamento = d.id_medicamento
     where d.id_pedido = $1 for update of d`,
    [idPedido],
  );
  const filas = new Map(detalle.rows.map((row) => [row.id_medicamento, row]));
  const pendiente = new Map(detalle.rows.map((row) => [row.id_medicamento, row.cantidad_solicitada - row.cantidad_recibida]));

  // Validar todas las líneas antes de escribir nada: formato y pedido en el API, y una sola consulta a la base.
  const conLinea = (indice, error) => {
    if (error instanceof ErrorNegocio) error.extra = { ...error.extra, linea: indice + 1 };
    return error;
  };
  const validadas = [];
  for (const [indice, linea] of lineas.entries()) {
    let datos;
    try {
      datos = validarFormatoLote({ ...linea, id_proveedor: idProveedor });
    } catch (error) {
      throw conLinea(indice, error);
    }
    if (!pendiente.has(datos.idMedicamento)) {
      throw invalido(`Línea ${indice + 1}: el medicamento no está en este pedido`, { linea: indice + 1 });
    }
    const resta = pendiente.get(datos.idMedicamento) - datos.cantidad;
    // Recibir más de lo pendiente es posible, pero deja un sobrante que necesita su constancia (criterio 4 de HU-14).
    if (resta < 0 && motivo.length < MOTIVO_MIN) {
      throw invalido(
        `Línea ${indice + 1}: se reciben más unidades de las pendientes (${pendiente.get(datos.idMedicamento)}). Para registrar el sobrante indique el motivo de la diferencia`,
        { linea: indice + 1, pendiente: pendiente.get(datos.idMedicamento), campo: "motivo_diferencia" },
      );
    }
    pendiente.set(datos.idMedicamento, resta);
    validadas.push(datos);
  }
  await verificarLotesEnBase(client, validadas, { alError: conLinea });

  // Lo que queda por medicamento tras esta recepción: resta > 0 falta, < 0 sobra.
  const tocados = new Set(validadas.map((datos) => datos.idMedicamento));
  const sobrantes = [...pendiente.entries()].filter(([id, resta]) => resta < 0 && tocados.has(id));
  const faltantes = [...pendiente.entries()].filter(([, resta]) => resta > 0);
  if (cerrar) exigirMotivo(motivo, "Para cerrar el pedido con unidades faltantes indique el motivo de la diferencia (mínimo 5 caracteres)");
  if (cerrar && faltantes.length === 0 && sobrantes.length === 0) {
    throw invalido("No hay diferencia que registrar: la recepción completa el pedido", { campo: "cerrar_con_diferencia" });
  }

  const recepcion = await client.query(
    `insert into recepcion (id_pedido, id_empleado, documento_proveedor, observaciones)
     values ($1, $2, $3, $4) returning id_recepcion, fecha_hora`,
    [idPedido, ctx.idEmpleado, documento, observaciones],
  );
  const { id_recepcion: idRecepcion } = recepcion.rows[0];

  const referencia = `PEDIDO-${idPedido}`;
  const lotes = [];
  for (const datos of validadas) {
    const resultado = await entradaEnLote(client, datos, { ...ctx, referencia, publicarStock: false });
    lotes.push(resultado.id_lote);
    await client.query(
      `insert into detalle_recepcion (id_recepcion, id_medicamento, id_lote, id_proveedor, cantidad) values ($1, $2, $3, $4, $5)`,
      [idRecepcion, datos.idMedicamento, resultado.id_lote, idProveedor, datos.cantidad],
    );
  }
  // Cantidades recibidas de todas las líneas en una sola sentencia (varias líneas pueden ser del mismo medicamento).
  await client.query(
    `update detalle_pedido d set cantidad_recibida = d.cantidad_recibida + r.cantidad
     from (select id_medicamento, sum(cantidad)::int as cantidad
           from unnest($2::int[], $3::int[]) as l(id_medicamento, cantidad)
           group by id_medicamento) r
     where d.id_pedido = $1 and d.id_medicamento = r.id_medicamento`,
    [idPedido, validadas.map((datos) => datos.idMedicamento), validadas.map((datos) => datos.cantidad)],
  );

  // Constancia de las diferencias: lo solicitado y lo recibido acumulado en este instante, con el motivo.
  const diferencias = [];
  const constancia = async (idMedicamento, tipo) => {
    const fila = filas.get(idMedicamento);
    const recibida = fila.cantidad_solicitada - pendiente.get(idMedicamento);
    const guardada = await client.query(
      `insert into diferencia_recepcion (id_pedido, id_recepcion, id_medicamento, tipo, cantidad_solicitada, cantidad_recibida, diferencia, motivo, id_empleado)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id_diferencia, tipo, cantidad_solicitada, cantidad_recibida, diferencia`,
      [idPedido, idRecepcion, idMedicamento, tipo, fila.cantidad_solicitada, recibida, recibida - fila.cantidad_solicitada, motivo, ctx.idEmpleado],
    );
    diferencias.push({ ...guardada.rows[0], id_medicamento: idMedicamento, nombre_comercial: fila.nombre_comercial, motivo });
  };
  for (const [idMedicamento] of sobrantes) await constancia(idMedicamento, "SOBRANTE");
  if (cerrar) for (const [idMedicamento] of faltantes) await constancia(idMedicamento, "FALTANTE");

  const completo = faltantes.length === 0;
  const nuevoEstado = completo || cerrar ? "RECIBIDO_TOTAL" : "RECIBIDO_PARCIAL";
  await client.query(
    "update pedido set estado = $2, fecha_recepcion = now(), con_diferencia = (con_diferencia or $3::boolean) where id_pedido = $1",
    [idPedido, nuevoEstado, diferencias.length > 0],
  );
  await encolarStockSnapshot(client, { idTienda: ctx.idTienda, idsMedicamento: validadas.map((datos) => datos.idMedicamento) });
  await auditar(
    client,
    ctx.idEmpleado,
    "PEDIDO_RECIBIR",
    "pedido",
    idPedido,
    `recepción ${idRecepcion}; ${validadas.length} línea(s); estado ${nuevoEstado}${documento ? `; documento ${documento}` : ""}`,
  );
  if (diferencias.length > 0) {
    const resumen = diferencias.map((d) => `${d.nombre_comercial} ${d.diferencia > 0 ? "+" : ""}${d.diferencia}`).join(", ");
    await auditar(client, ctx.idEmpleado, "RECEPCION_DIFERENCIA", "pedido", idPedido, `recepción ${idRecepcion}: ${resumen}. Motivo: ${motivo}`);
  }
  return {
    id_pedido: idPedido,
    id_recepcion: idRecepcion,
    estado: nuevoEstado,
    fecha_hora: recepcion.rows[0].fecha_hora,
    lotes,
    con_diferencia: diferencias.length > 0,
    diferencias,
  };
}

// HU-14, criterio 4: el proveedor avisa que no entregará el resto. Se da por terminado un pedido recibido en parte,
// sin unidades nuevas, dejando constancia del faltante con su motivo. Pendiente -> recibida con diferencia.
export async function cerrarPedidoConDiferencia(client, idPedido, body, ctx) {
  const motivo = motivoDe(body?.motivo_diferencia);
  exigirMotivo(motivo, "Indique el motivo de la diferencia (mínimo 5 caracteres)");
  const pedido = await client.query("select estado from pedido where id_pedido = $1 for update", [idPedido]);
  if (pedido.rowCount === 0) throw noEncontrado(`El pedido ${idPedido} no existe`);
  if (pedido.rows[0].estado !== "RECIBIDO_PARCIAL") {
    throw conflicto("TRANSICION_INVALIDA", "Solo se cierra con diferencia un pedido recibido en parte; uno sin recibir se cancela", { estado: pedido.rows[0].estado });
  }
  const faltantes = await client.query(
    `select d.id_medicamento, m.nombre_comercial, d.cantidad_solicitada, d.cantidad_recibida
     from detalle_pedido d join medicamento_ref m on m.id_medicamento = d.id_medicamento
     where d.id_pedido = $1 and d.cantidad_recibida < d.cantidad_solicitada order by m.nombre_comercial`,
    [idPedido],
  );
  if (faltantes.rowCount === 0) throw conflicto("SIN_DIFERENCIA", "No hay unidades pendientes: el pedido no tiene diferencia que registrar");
  const diferencias = [];
  for (const f of faltantes.rows) {
    const guardada = await client.query(
      `insert into diferencia_recepcion (id_pedido, id_recepcion, id_medicamento, tipo, cantidad_solicitada, cantidad_recibida, diferencia, motivo, id_empleado)
       values ($1, null, $2, 'FALTANTE', $3, $4, $5, $6, $7)
       returning id_diferencia, tipo, cantidad_solicitada, cantidad_recibida, diferencia`,
      [idPedido, f.id_medicamento, f.cantidad_solicitada, f.cantidad_recibida, f.cantidad_recibida - f.cantidad_solicitada, motivo, ctx.idEmpleado],
    );
    diferencias.push({ ...guardada.rows[0], id_medicamento: f.id_medicamento, nombre_comercial: f.nombre_comercial, motivo });
  }
  await client.query("update pedido set estado = 'RECIBIDO_TOTAL', con_diferencia = true where id_pedido = $1", [idPedido]);
  const resumen = diferencias.map((d) => `${d.nombre_comercial} ${d.diferencia}`).join(", ");
  await auditar(client, ctx.idEmpleado, "PEDIDO_CERRAR_DIFERENCIA", "pedido", idPedido, `faltante: ${resumen}. Motivo: ${motivo}`);
  return { id_pedido: idPedido, estado: "RECIBIDO_TOTAL", con_diferencia: true, diferencias };
}

// HU-14, criterio 3: las recepciones de una solicitud con sus lotes y proveedor, quién las hizo y cuándo, y las
// diferencias de las que quedó constancia. db: la base local.
export async function listarRecepciones(db, idPedido) {
  const pedido = await db.query(
    `select p.id_pedido, p.estado, p.con_diferencia, p.id_proveedor, pr.nombre_empresa as proveedor
     from pedido p join proveedor_ref pr on pr.id_proveedor = p.id_proveedor where p.id_pedido = $1`,
    [idPedido],
  );
  if (pedido.rowCount === 0) throw noEncontrado(`El pedido ${idPedido} no existe`);
  const recepciones = await db.query(
    `select r.id_recepcion, r.fecha_hora, r.documento_proveedor, r.observaciones, e.nombre_completo as responsable, e.usuario,
            coalesce(json_agg(json_build_object(
              'id_medicamento', d.id_medicamento, 'nombre_comercial', m.nombre_comercial, 'id_lote', d.id_lote,
              'numero_lote', l.numero_lote, 'fecha_caducidad', l.fecha_caducidad, 'cantidad', d.cantidad,
              'id_proveedor', d.id_proveedor
            ) order by m.nombre_comercial, d.id_detalle) filter (where d.id_detalle is not null), '[]') as lineas
     from recepcion r
     join empleado_ref e on e.id_empleado = r.id_empleado
     left join detalle_recepcion d on d.id_recepcion = r.id_recepcion
     left join medicamento_ref m on m.id_medicamento = d.id_medicamento
     left join lote l on l.id_lote = d.id_lote
     where r.id_pedido = $1
     group by r.id_recepcion, e.nombre_completo, e.usuario
     order by r.fecha_hora, r.id_recepcion`,
    [idPedido],
  );
  const diferencias = await db.query(
    `select f.id_diferencia, f.id_recepcion, f.id_medicamento, m.nombre_comercial, f.tipo, f.cantidad_solicitada,
            f.cantidad_recibida, f.diferencia, f.motivo, f.fecha_hora, e.nombre_completo as responsable
     from diferencia_recepcion f
     join medicamento_ref m on m.id_medicamento = f.id_medicamento
     join empleado_ref e on e.id_empleado = f.id_empleado
     where f.id_pedido = $1
     order by f.fecha_hora, f.id_diferencia`,
    [idPedido],
  );
  return { ...pedido.rows[0], recepciones: recepciones.rows, diferencias: diferencias.rows };
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
            mi.referencia_documento, mi.observaciones, mi.id_empleado,
            -- HU-17: el paso de un traslado lo hace el sistema (sin responsable en esta tienda).
            coalesce(e.nombre_completo, 'Sistema (traslado)') as empleado, e.usuario
     from movimiento_inventario mi
     left join empleado_ref e on e.id_empleado = mi.id_empleado
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
    `select p.id_pedido, p.estado, p.fecha_solicitud, p.origen_solicitud, p.id_proveedor, p.con_diferencia, pr.nombre_empresa as proveedor,
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
     where p.estado in ('SOLICITADO', 'ENVIADO', 'RECIBIDO_PARCIAL')
     group by p.id_pedido, pr.nombre_empresa
     order by p.fecha_solicitud`,
  );
  return result.rows;
}
