import crypto from "crypto";
import { central, local, runtime, withTx } from "./db.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { ErrorNegocio, conflicto, invalido } from "./errores.mjs";
import { enCentral } from "./empleados.mjs";
import { auditar } from "./inventario/lotes.mjs";
import { recetaDe } from "./recetas.mjs";
import { abrirDocumento, sellarDocumento } from "./datos-personales.mjs";

// HU-12, validación contra el sistema de salud (simulada). El nodo central hace de EPS: guarda las recetas emitidas
// con su código, confirma que son auténticas y vigentes, las reserva para UNA tienda y las da de baja cuando
// se dispensan, así no se pueden usar otra vez en otra sucursal.
//
//   emitir (central, simulación)  →  validar por código (tienda → central: reserva)  →  venta  →  baja (outbox)
//
// Sin conexión con el central no se valida un controlado nuevo (503 SIN_CONEXION): una receta no se puede
// reclamar dos veces si nadie puede verificar que no fue reclamada. Lo que ya está reservado sigue valiendo hasta
// que termina su reserva (plazo en politica_receta del central), porque la reserva ya garantiza que ninguna otra
// tienda la use. La baja viaja por el outbox y es idempotente; si llega una baja de una receta que otra tienda ya
// reclamó, no se descarta: queda en receta_conflicto.

const CODIGO_RE = /^[A-Za-z0-9._-]{4,40}$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOCUMENTO_RE = /^[A-Za-z0-9.\-]{4,40}$/;
const MAX_LINEAS = 20;
const MAX_CANTIDAD = 1000;
const MAX_RESULTADOS = 50;

const texto = (valor) => String(valor ?? "").trim();
const enmascarar = (documento) => (documento ? `****${String(documento).slice(-4)}` : null);
const reclamada = (r) =>
  conflicto("RECETA_RECLAMADA", `La receta ${r.codigo} ya fue reclamada${r.tienda_reclamo ? ` en ${r.tienda_reclamo}` : ""}`, {
    tienda: r.tienda_reclamo ?? null,
    reclamada_en: r.reclamada_en ?? null,
  });

function codigoDe(valor) {
  const codigo = texto(valor);
  if (!CODIGO_RE.test(codigo)) throw invalido("Código de receta no válido (4 a 40 letras, números, punto o guion)", { campo: "codigo" });
  return codigo.toUpperCase();
}

function entero(valor, campo, maximo = 2_000_000_000) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > maximo) throw invalido(`${campo} no válido`, { campo });
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Central: emisión simulada y consulta
// ---------------------------------------------------------------------------------------------------------------

// Recetas emitidas con sus medicamentos, en el orden de ids y con dos consultas en total.
async function recetasEmitidasDe(db, ids) {
  if (ids.length === 0) return [];
  const cabecera = await db.query(
    `select r.id_receta_emitida, r.codigo, r.paciente_nombre, r.paciente_documento, r.medico_prescriptor, r.fecha_emision,
            r.estado, r.reservada_hasta, tr.nombre as tienda_reserva, tc.nombre as tienda_reclamo, r.reclamada_en,
            receta_vigente(r.fecha_emision) as vigente
     from receta_emitida r
     left join tienda tr on tr.id_tienda = r.id_tienda_reserva
     left join tienda tc on tc.id_tienda = r.id_tienda_reclamo
     where r.id_receta_emitida = any($1::int[])`,
    [ids],
  );
  const lineas = await db.query(
    `select rm.id_receta_emitida, rm.id_medicamento, m.nombre_comercial, rm.cantidad_autorizada
     from receta_emitida_medicamento rm join medicamento m on m.id_medicamento = rm.id_medicamento
     where rm.id_receta_emitida = any($1::int[]) order by m.nombre_comercial`,
    [ids],
  );
  const porId = new Map(cabecera.rows.map((fila) => [fila.id_receta_emitida, fila]));
  return ids.filter((id) => porId.has(id)).map((id) => {
    const { paciente_documento: documento, ...resto } = porId.get(id);
    const medicamentos = lineas.rows.filter((l) => l.id_receta_emitida === id).map(({ id_receta_emitida: _id, ...l }) => l);
    return { ...resto, paciente_documento: enmascarar(documento), medicamentos };
  });
}

async function recetaEmitidaDe(db, idRecetaEmitida) {
  return (await recetasEmitidasDe(db, [idRecetaEmitida]))[0];
}

// Simulación del médico/EPS: crea una receta con su código. Solo el administrador general (RED_CONTROL).
export async function emitirReceta(sesion, key, body) {
  const datos = body ?? {};
  const medico = texto(datos.medico_prescriptor);
  if (!medico || medico.length > 150) throw invalido("El médico prescriptor es obligatorio (máximo 150 caracteres)", { campo: "medico_prescriptor" });
  const nombre = texto(datos.paciente_nombre);
  if (!nombre || nombre.length > 150) throw invalido("El nombre del paciente es obligatorio (máximo 150 caracteres)", { campo: "paciente_nombre" });
  const documento = texto(datos.paciente_documento);
  if (!DOCUMENTO_RE.test(documento)) throw invalido("Documento no válido (4 a 40 letras, números, punto o guion)", { campo: "paciente_documento" });
  const fecha = texto(datos.fecha_emision);
  const calendario = new Date(`${fecha}T00:00:00Z`);
  if (!FECHA_RE.test(fecha) || Number.isNaN(calendario.getTime()) || calendario.toISOString().slice(0, 10) !== fecha || calendario.getUTCFullYear() < 2000) {
    throw invalido("La fecha debe ser una fecha válida AAAA-MM-DD", { campo: "fecha_emision" });
  }
  const codigo = texto(datos.codigo) ? codigoDe(datos.codigo) : null;
  if (!Array.isArray(datos.medicamentos) || datos.medicamentos.length === 0 || datos.medicamentos.length > MAX_LINEAS) {
    throw invalido(`Indique de 1 a ${MAX_LINEAS} medicamentos`, { campo: "medicamentos" });
  }
  const vistos = new Set();
  const medicamentos = datos.medicamentos.map((l, i) => {
    const id = entero(l?.id_medicamento, `medicamentos[${i}].id_medicamento`);
    if (vistos.has(id)) throw invalido("Un medicamento aparece dos veces", { campo: `medicamentos[${i}].id_medicamento` });
    vistos.add(id);
    return { id, cantidad: entero(l?.cantidad, `medicamentos[${i}].cantidad`, MAX_CANTIDAD) };
  });

  return conIdempotencia(central, { key, operacion: "RECETA_EMITIR", idEmpleado: sesion.id_empleado, body: datos }, async (client) => {
    const meds = await client.query(
      "select id_medicamento, nombre_comercial, requiere_receta, activo from medicamento where id_medicamento = any($1::int[])",
      [medicamentos.map((m) => m.id)],
    );
    const porId = new Map(meds.rows.map((m) => [m.id_medicamento, m]));
    medicamentos.forEach((m, i) => {
      const med = porId.get(m.id);
      if (!med || !med.activo) throw invalido("Medicamento no válido", { campo: `medicamentos[${i}].id_medicamento` });
      if (!med.requiere_receta) {
        throw new ErrorNegocio(400, "NO_REQUIERE_RECETA", `${med.nombre_comercial} no requiere receta médica`, { campo: `medicamentos[${i}].id_medicamento` });
      }
    });
    if ((await client.query("select $1::date > current_date as futura", [fecha])).rows[0].futura) {
      throw invalido("La fecha de la receta no puede ser futura", { campo: "fecha_emision" });
    }

    const codigoFinal = codigo ?? `RX-${crypto.randomInt(1_000_000_000, 9_999_999_999)}`;
    let creada;
    try {
      // El documento se guarda cifrado (docs/seguridad/datos-personales.md): en la fila solo queda enmascarado.
      const sellado = sellarDocumento(documento);
      creada = await client.query(
        `insert into receta_emitida (codigo, paciente_nombre, paciente_documento, medico_prescriptor, fecha_emision, id_empleado_emisor,
                                      documento_hmac, documento_cifrado)
         values ($1, $2, $3, $4, $5::date, $6, $7, $8) returning id_receta_emitida`,
        [codigoFinal, nombre, sellado.paciente_documento, medico, fecha, sesion.id_empleado, sellado.documento_hmac, sellado.documento_cifrado],
      );
    } catch (error) {
      if (error.code === "23505") throw conflicto("CODIGO_DUPLICADO", `Ya existe una receta con el código ${codigoFinal}`, { campo: "codigo" });
      throw error;
    }
    const id = creada.rows[0].id_receta_emitida;
    await client.query(
      `insert into receta_emitida_medicamento (id_receta_emitida, id_medicamento, cantidad_autorizada)
       select $1, l.id_medicamento, l.cantidad from unnest($2::int[], $3::int[]) as l(id_medicamento, cantidad)`,
      [id, medicamentos.map((m) => m.id), medicamentos.map((m) => m.cantidad)],
    );
    await client.query(
      `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
       values ($1, 'RECETA_EMITIR', 'receta_emitida', $2, $3)`,
      [sesion.id_empleado, id, `Código ${codigoFinal}; médico ${medico}; emitida ${fecha}`.slice(0, 400)],
    );
    return { status: 201, body: await recetaEmitidaDe(client, id) };
  });
}

// Listado para la consola. El documento va siempre enmascarado.
export async function listarRecetasEmitidas(query) {
  const q = texto(query.q);
  if (q.length > 100) throw invalido("La búsqueda admite máximo 100 caracteres", { campo: "q" });
  const estado = texto(query.estado).toUpperCase() || null;
  if (estado && !["EMITIDA", "RESERVADA", "RECLAMADA", "ANULADA"].includes(estado)) throw invalido("Estado no válido", { campo: "estado" });
  const patron = q ? `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null;
  const filas = await central.query(
    `select id_receta_emitida from receta_emitida
     where ($1::text is null or lower(codigo) like $1 escape '\\' or lower(paciente_nombre) like $1 escape '\\' or lower(medico_prescriptor) like $1 escape '\\')
       and ($2::text is null or estado = $2)
     order by id_receta_emitida desc limit ${MAX_RESULTADOS}`,
    [patron, estado],
  );
  return { recetas: await recetasEmitidasDe(central, filas.rows.map((f) => f.id_receta_emitida)) };
}

// Medicamentos que exigen receta, para armar la emisión simulada.
export async function medicamentosControlados() {
  const filas = await central.query(
    `select id_medicamento, codigo_interno, nombre_comercial, principio_activo
     from medicamento where requiere_receta and activo order by nombre_comercial`,
  );
  return { medicamentos: filas.rows };
}

// ---------------------------------------------------------------------------------------------------------------
// Central: reserva, liberación y baja (transacciones del central)
// ---------------------------------------------------------------------------------------------------------------

async function bloquear(client, codigo) {
  const r = await client.query(
    `select r.*, receta_vigente(r.fecha_emision) as vigente, (r.reservada_hasta > now()::timestamp) as reserva_activa,
            tc.nombre as tienda_reclamo
     from receta_emitida r left join tienda tc on tc.id_tienda = r.id_tienda_reclamo
     where r.codigo = $1 for update of r`,
    [codigo],
  );
  return r.rows[0] ?? null;
}

const noEncontrada = (codigo) => new ErrorNegocio(404, "RECETA_NO_ENCONTRADA", `No existe una receta con el código ${codigo}`);

async function auditarCentral(client, idEmpleado, accion, idReceta, detalle) {
  await client.query(
    `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
     values ($1, $2, 'receta_emitida', $3, $4)`,
    [idEmpleado, accion, idReceta, String(detalle).slice(0, 400)],
  );
}

// Valida y reserva. El bloqueo de la fila serializa a dos tiendas que piden la misma receta a la vez:
// la segunda ve la reserva de la primera. Pedirla de nuevo la misma tienda renueva el plazo.
export async function reservarEnCentral(client, { idTienda, idEmpleado, codigo }) {
  const r = await bloquear(client, codigo);
  if (!r) throw noEncontrada(codigo);
  if (r.estado === "ANULADA") throw conflicto("RECETA_ANULADA", `La receta ${codigo} fue anulada`);
  if (r.estado === "RECLAMADA") throw reclamada(r);
  if (!r.vigente) {
    const dias = (await client.query("select dias_vigencia from politica_receta where id = 1")).rows[0].dias_vigencia;
    throw conflicto("RECETA_VENCIDA", `La receta ${codigo} está vencida: solo vale ${dias} días desde su emisión`);
  }
  if (r.estado === "RESERVADA" && r.reserva_activa && Number(r.id_tienda_reserva) !== Number(idTienda)) {
    throw conflicto("RECETA_RESERVADA_OTRA_TIENDA", `La receta ${codigo} está siendo atendida en otra tienda`);
  }
  const reserva = await client.query(
    `update receta_emitida
     set estado = 'RESERVADA', id_tienda_reserva = $2, id_empleado_reserva = $3,
         reservada_hasta = now()::timestamp + make_interval(mins => (select minutos_reserva from politica_receta where id = 1))
     where id_receta_emitida = $1 returning reservada_hasta`,
    [r.id_receta_emitida, idTienda, idEmpleado],
  );
  await auditarCentral(client, idEmpleado, "RECETA_RESERVAR", r.id_receta_emitida, `Código ${codigo}; tienda ${idTienda}`);
  const lineas = await client.query(
    `select rm.id_medicamento, rm.cantidad_autorizada from receta_emitida_medicamento rm where rm.id_receta_emitida = $1`,
    [r.id_receta_emitida],
  );
  return {
    codigo,
    medico_prescriptor: r.medico_prescriptor,
    fecha_emision: r.fecha_emision,
    paciente_nombre: r.paciente_nombre,
    // La copia de la tienda que dispensa necesita el documento real para su registro del paciente. Solo sale por este camino
    // (reserva con código válido); el resto de respuestas lo muestran enmascarado.
    paciente_documento: abrirDocumento(r.documento_cifrado),
    reservada_hasta: reserva.rows[0].reservada_hasta,
    medicamentos: lineas.rows,
  };
}

// Cancela la reserva de la tienda (el cliente se fue sin comprar). Idempotente.
export async function liberarEnCentral(client, { idTienda, idEmpleado, codigo }) {
  const r = await bloquear(client, codigo);
  if (!r) throw noEncontrada(codigo);
  if (r.estado === "RECLAMADA") throw reclamada(r);
  if (r.estado === "RESERVADA" && Number(r.id_tienda_reserva) !== Number(idTienda) && r.reserva_activa) {
    throw conflicto("RECETA_RESERVADA_OTRA_TIENDA", `La receta ${codigo} está reservada por otra tienda`);
  }
  if (r.estado !== "RESERVADA" || Number(r.id_tienda_reserva) !== Number(idTienda)) return { liberada: false };
  await client.query(
    `update receta_emitida set estado = 'EMITIDA', id_tienda_reserva = null, id_empleado_reserva = null, reservada_hasta = null
     where id_receta_emitida = $1`,
    [r.id_receta_emitida],
  );
  await auditarCentral(client, idEmpleado, "RECETA_LIBERAR", r.id_receta_emitida, `Código ${codigo}; tienda ${idTienda}`);
  return { liberada: true };
}

async function dejarConflictoReceta(client, r, idTienda, event, motivo) {
  await client.query(
    `insert into receta_conflicto (id_receta_emitida, codigo, id_tienda_origen, motivo, payload) values ($1, $2, $3, $4, $5::jsonb)`,
    [r?.id_receta_emitida ?? null, String(event.payload.codigo ?? ""), idTienda, motivo, JSON.stringify(event.payload)],
  );
}

// Aplica en el central la baja RECETA_DISPENSADA que envía el outbox de una tienda. Idempotente por inbox_sync.
// La primera baja en llegar gana y "quema" la receta; una baja de otra tienda queda en receta_conflicto.
export async function aplicarBajaReceta(client, idTienda, event) {
  const inbox = await client.query(
    `insert into inbox_sync (id_tienda_origen, idempotency_key, tipo_evento, payload)
     values ($1, $2, $3, $4::jsonb) on conflict (id_tienda_origen, idempotency_key) do nothing`,
    [idTienda, event.idempotency_key, event.tipo_evento, JSON.stringify(event.payload)],
  );
  if (inbox.rowCount === 0) return; // duplicado

  const codigo = String(event.payload.codigo ?? "").toUpperCase();
  const r = await bloquear(client, codigo);
  if (!r) return dejarConflictoReceta(client, null, idTienda, event, "CODIGO_DESCONOCIDO");
  if (r.estado === "ANULADA") return dejarConflictoReceta(client, r, idTienda, event, "RECETA_ANULADA");
  if (r.estado === "RECLAMADA") {
    // Otra línea de la misma dispensación: nada que hacer. De otra tienda: conflicto.
    if (Number(r.id_tienda_reclamo) === Number(idTienda)) return;
    return dejarConflictoReceta(client, r, idTienda, event, `YA_RECLAMADA_EN_TIENDA_${r.id_tienda_reclamo}`);
  }
  // Una reserva ajena todavía activa no se ignora en silencio: la dispensación ya ocurrió, así que la baja gana
  // y el aviso queda registrado para que la red lo revise.
  if (r.estado === "RESERVADA" && Number(r.id_tienda_reserva) !== Number(idTienda) && r.reserva_activa) {
    await dejarConflictoReceta(client, r, idTienda, event, `RESERVA_ACTIVA_DE_TIENDA_${r.id_tienda_reserva}`);
  }
  await client.query(
    `update receta_emitida
     set estado = 'RECLAMADA', id_tienda_reclamo = $2, reclamada_en = $3::timestamptz at time zone 'UTC',
         id_tienda_reserva = null, id_empleado_reserva = null, reservada_hasta = null
     where id_receta_emitida = $1`,
    [r.id_receta_emitida, idTienda, event.payload.dispensado_en ?? new Date().toISOString()],
  );
  await auditarCentral(client, null, "RECETA_RECLAMAR", r.id_receta_emitida, `Código ${codigo}; dispensada en la tienda ${idTienda}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Tienda: validar por código, liberar y política
// ---------------------------------------------------------------------------------------------------------------

export async function politicaReceta() {
  const r = await local.query("select dias_vigencia, permitir_registro_manual from politica_receta where id = 1");
  return { dias_vigencia: r.rows[0].dias_vigencia, registro_manual: r.rows[0].permitir_registro_manual };
}

// Copia la receta validada a la base de la tienda (idempotente por código) y la audita.
async function copiarALocal(client, sesion, reserva) {
  const ids = reserva.medicamentos.map((m) => m.id_medicamento);
  const presentes = await client.query("select id_medicamento from medicamento_ref where id_medicamento = any($1::int[])", [ids]);
  if (presentes.rowCount !== ids.length) {
    throw conflicto("MEDICAMENTO_NO_SINCRONIZADO", "Algún medicamento de la receta aún no llega a esta tienda; intente de nuevo tras la sincronización");
  }
  const sellado = sellarDocumento(reserva.paciente_documento);
  let cliente = await client.query(
    `insert into cliente (nombre, documento_identidad, documento_hmac, documento_cifrado) values ($1, $2, $3, $4)
     on conflict (documento_hmac) where documento_hmac is not null do nothing returning id_cliente`,
    [reserva.paciente_nombre, sellado.paciente_documento, sellado.documento_hmac, sellado.documento_cifrado],
  );
  if (cliente.rowCount === 0) cliente = await client.query("select id_cliente from cliente where documento_hmac = $1", [sellado.documento_hmac]);
  const receta = await client.query(
    `insert into receta (medico_prescriptor, fecha_emision, id_cliente, id_empleado_registro, codigo_receta, origen, reservada_hasta)
     values ($1, $2::date, $3, $4, $5, 'CENTRAL', $6)
     on conflict (codigo_receta) where codigo_receta is not null do update set reservada_hasta = excluded.reservada_hasta
     returning id_receta, (xmax = 0) as nueva`,
    [reserva.medico_prescriptor, reserva.fecha_emision, cliente.rows[0].id_cliente, sesion.id_empleado, reserva.codigo, reserva.reservada_hasta],
  );
  const { id_receta: idReceta, nueva } = receta.rows[0];
  await client.query(
    `insert into receta_medicamento (id_receta, id_medicamento, cantidad_autorizada)
     select $1, l.id_medicamento, l.cantidad from unnest($2::int[], $3::int[]) as l(id_medicamento, cantidad)
     on conflict (id_receta, id_medicamento) do nothing`,
    [idReceta, ids, reserva.medicamentos.map((m) => m.cantidad_autorizada)],
  );
  const nombres = await client.query("select nombre_comercial from medicamento_ref where id_medicamento = any($1::int[]) order by nombre_comercial", [ids]);
  await auditar(
    client,
    sesion.id_empleado,
    "RECETA_VALIDAR_CENTRAL",
    "receta",
    idReceta,
    `Código ${reserva.codigo}${nueva ? "" : " (renovada)"}; médico ${reserva.medico_prescriptor}; emitida ${reserva.fecha_emision}; ${nombres.rows.map((n) => n.nombre_comercial).join(", ")}`,
  );
  return idReceta;
}

// El cajero escribe o escanea el código. Sin conexión con el central: 503 (no se valida un controlado).
export async function validarCodigo(sesion, codigoCrudo) {
  const codigo = codigoDe(codigoCrudo);
  const datos = { idTienda: runtime.tiendaId, idEmpleado: sesion.id_empleado, codigo };
  const reserva = await enCentral(() => withTx(central, (client) => reservarEnCentral(client, datos)));
  let idReceta;
  try {
    idReceta = await withTx(local, (client) => copiarALocal(client, sesion, reserva));
  } catch (error) {
    // Si la tienda no pudo guardar su copia, la reserva no debe quedar bloqueando la receta.
    await enCentral(() => withTx(central, (client) => liberarEnCentral(client, datos))).catch(() => {});
    throw error;
  }
  return { status: 200, body: await recetaDe(local, idReceta, false) };
}

// El cliente se fue sin comprar: libera la reserva en el central y deja la copia sin plazo.
export async function liberarReceta(sesion, idReceta) {
  const receta = await local.query("select codigo_receta, origen from receta where id_receta = $1", [idReceta]);
  if (receta.rowCount === 0) throw new ErrorNegocio(404, "NO_ENCONTRADO", "La receta no existe");
  if (receta.rows[0].origen !== "CENTRAL") throw conflicto("RECETA_SIN_RESERVA", "La receta se registró a mano: no tiene reserva en el central");
  const usada = await local.query("select 1 from detalle_factura where id_receta = $1 limit 1", [idReceta]);
  if (usada.rowCount > 0) throw conflicto("RECETA_RECLAMADA", "La receta ya se dispensó en una factura");
  const codigo = receta.rows[0].codigo_receta;
  const datos = { idTienda: runtime.tiendaId, idEmpleado: sesion.id_empleado, codigo };
  await enCentral(() => withTx(central, (client) => liberarEnCentral(client, datos)));
  await withTx(local, async (client) => {
    await client.query("update receta set reservada_hasta = now()::timestamp - interval '1 second' where id_receta = $1", [idReceta]);
    await auditar(client, sesion.id_empleado, "RECETA_LIBERAR", "receta", idReceta, `Código ${codigo}; reserva liberada`);
  });
  return { status: 200, body: await recetaDe(local, idReceta, false) };
}
