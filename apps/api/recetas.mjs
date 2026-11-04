import { local } from "./db.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { ErrorNegocio, conflicto, invalido, noEncontrado } from "./errores.mjs";
import { auditar } from "./inventario/lotes.mjs";

// HU-12: receta médica antes de vender un medicamento que la requiere (RF-08, regla de negocio 6, RNF-02, RNF-10).
// Todo ocurre en el nodo local: registrar y validar recetas funciona sin conexión con el central y no se
// encola nada. La receta y los datos del paciente no salen de la tienda; al central solo sube la auditoría
// (médico, fecha y medicamentos, sin documento ni contacto del paciente).
// La garantía de "sin receta válida no hay venta" vive en la base (trigger detalle_factura_receta,
// db/local/05_hu12_recetas.sql); evaluarReceta la anticipa para que el POS avise antes de intentar la venta.

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOCUMENTO_RE = /^[A-Za-z0-9.\-]{4,40}$/;
const MAX_LINEAS = 20;
const MAX_CANTIDAD = 1000;
const MAX_RESULTADOS = 50;

const texto = (valor) => String(valor ?? "").trim();

function obligatorio(campo, mensaje) {
  return new ErrorNegocio(400, "CAMPO_OBLIGATORIO", mensaje, { campo });
}

function entero(valor, campo, maximo = 2_000_000_000) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > maximo) throw invalido(`${campo} no válido`, { campo });
  return n;
}

// Documento visible solo en parte para quien no está autorizado a ver datos personales (regla 15).
const enmascarar = (documento) => (documento ? `****${String(documento).slice(-4)}` : null);

// Solo quien puede consultar la auditoría (administradores) ve el documento y el contacto completos.
export const veDatosPersonales = (sesion) => sesion.permisos.includes("AUDITORIA_CONSULTAR");

// Convierte el rechazo de la base (trigger de detalle_factura, SQLSTATE 23514 con prefijo RECETA_*) en
// un error de negocio. Lo usa la venta (HU-08) al insertar las líneas de la factura.
export function traducirErrorReceta(error) {
  const coincide = error?.code === "23514" && /^(RECETA_[A-Z]+): (.*)$/.exec(error.message || "");
  return coincide ? conflicto(coincide[1], coincide[2]) : error;
}

function validarFormato(body) {
  const medico = texto(body.medico_prescriptor);
  if (!medico) throw obligatorio("medico_prescriptor", "El médico prescriptor es obligatorio");
  if (medico.length > 150) throw invalido("El médico admite máximo 150 caracteres", { campo: "medico_prescriptor" });

  const fecha = texto(body.fecha_emision);
  if (!fecha) throw obligatorio("fecha_emision", "La fecha de la receta es obligatoria");
  const calendario = new Date(`${fecha}T00:00:00Z`);
  if (!FECHA_RE.test(fecha) || Number.isNaN(calendario.getTime()) || calendario.toISOString().slice(0, 10) !== fecha || calendario.getUTCFullYear() < 2000) {
    throw invalido("La fecha de la receta debe ser una fecha válida AAAA-MM-DD", { campo: "fecha_emision" });
  }

  const cliente = body.cliente ?? {};
  const nombre = texto(cliente.nombre);
  if (!nombre) throw obligatorio("cliente.nombre", "El nombre del paciente es obligatorio");
  if (nombre.length > 150) throw invalido("El nombre admite máximo 150 caracteres", { campo: "cliente.nombre" });
  const documento = texto(cliente.documento_identidad);
  if (!documento) throw obligatorio("cliente.documento_identidad", "El documento del paciente es obligatorio");
  if (!DOCUMENTO_RE.test(documento)) throw invalido("Documento no válido (4 a 40 letras, números, punto o guion)", { campo: "cliente.documento_identidad" });
  const telefono = texto(cliente.telefono) || null;
  if (telefono && telefono.length > 30) throw invalido("El teléfono admite máximo 30 caracteres", { campo: "cliente.telefono" });
  const correo = texto(cliente.correo) || null;
  if (correo && (correo.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo))) throw invalido("Correo no válido", { campo: "cliente.correo" });

  if (!Array.isArray(body.medicamentos) || body.medicamentos.length === 0) {
    throw obligatorio("medicamentos", "La receta debe indicar al menos un medicamento");
  }
  if (body.medicamentos.length > MAX_LINEAS) throw invalido(`La receta admite máximo ${MAX_LINEAS} medicamentos`, { campo: "medicamentos" });
  const vistos = new Set();
  const medicamentos = body.medicamentos.map((linea, i) => {
    const id = entero(linea?.id_medicamento, `medicamentos[${i}].id_medicamento`);
    if (vistos.has(id)) throw invalido("Un medicamento aparece dos veces en la receta", { campo: `medicamentos[${i}].id_medicamento` });
    vistos.add(id);
    return { id_medicamento: id, cantidad: entero(linea?.cantidad, `medicamentos[${i}].cantidad`, MAX_CANTIDAD) };
  });
  return { medico, fecha, cliente: { nombre, documento, telefono, correo }, medicamentos };
}

// Recetas con su paciente y sus medicamentos, en el orden de ids, con dos consultas en total (no dos por receta:
// con la base remota cada ida y vuelta cuesta ~130 ms). completo = true incluye documento y contacto sin enmascarar.
async function recetasDe(db, ids, completo) {
  if (ids.length === 0) return [];
  const cabecera = await db.query(
    `select r.id_receta, r.medico_prescriptor, r.fecha_emision, r.fecha_registro,
            c.nombre as paciente, c.documento_identidad, c.telefono, c.correo,
            e.nombre_completo as registrada_por,
            receta_vigente(r.fecha_emision) as vigente,
            (r.fecha_emision + (select dias_vigencia from politica_receta where id = 1))::text as vence,
            r.codigo_receta, r.origen, r.reservada_hasta,
            coalesce(r.reservada_hasta > now()::timestamp, false) as reserva_vigente,
            exists (select 1 from detalle_factura d where d.id_receta = r.id_receta) as dispensada,
            (select permitir_registro_manual from politica_receta where id = 1) as manual_permitido
     from receta r
     left join cliente c on c.id_cliente = r.id_cliente
     left join empleado_ref e on e.id_empleado = r.id_empleado_registro
     where r.id_receta = any($1::int[])`,
    [ids],
  );
  const lineas = await db.query(
    `select rm.id_receta, rm.id_medicamento, m.nombre_comercial, m.principio_activo, rm.cantidad_autorizada, rm.cantidad_dispensada
     from receta_medicamento rm
     join medicamento_ref m on m.id_medicamento = rm.id_medicamento
     where rm.id_receta = any($1::int[])
     order by m.nombre_comercial`,
    [ids],
  );
  const cabeceras = new Map(cabecera.rows.map((fila) => [fila.id_receta, fila]));
  return ids.filter((id) => cabeceras.has(id)).map((id) => {
    const { documento_identidad: documento, telefono, correo, ...resto } = cabeceras.get(id);
    const medicamentos = lineas.rows
      .filter((l) => l.id_receta === id)
      .map(({ id_receta: _id, ...l }) => ({ ...l, saldo: l.cantidad_autorizada - l.cantidad_dispensada }));
    return {
      ...resto,
      paciente_documento: completo ? documento : enmascarar(documento),
      ...(completo ? { paciente_telefono: telefono, paciente_correo: correo } : {}),
      datos_completos: completo,
      // Receta del central: sirve mientras la reserva esté vigente y no se haya dispensado (la baja la quema). Manual: su vigencia.
      utilizable:
        medicamentos.some((l) => l.saldo > 0) &&
        (resto.origen === "CENTRAL" ? resto.reserva_vigente && !resto.dispensada : resto.vigente && resto.manual_permitido),
      medicamentos,
    };
  });
}

export async function recetaDe(db, idReceta, completo) {
  const [receta] = await recetasDe(db, [idReceta], completo);
  if (!receta) throw noEncontrado("La receta no existe");
  return receta;
}

// Criterios 1 y 4: registra la receta (con su paciente) y la audita en la misma transacción.
// Idempotente por Idempotency-Key: un reintento devuelve la misma receta. La respuesta lleva el documento
// enmascarado porque la idempotencia la conserva.
export async function registrarReceta(sesion, key, body) {
  const datos = validarFormato(body ?? {});
  // Con la validación contra el central activa, el registro a mano queda apagado (solo para recetas que no estén en el sistema).
  const politica = await local.query("select permitir_registro_manual from politica_receta where id = 1");
  if (!politica.rows[0]?.permitir_registro_manual) {
    throw conflicto("REGISTRO_MANUAL_DESACTIVADO", "Los medicamentos controlados se validan con el código de la receta contra el nodo central");
  }
  return conIdempotencia(local, { key, operacion: "RECETA_REGISTRAR", idEmpleado: sesion.id_empleado, body }, async (client) => {
    const ids = datos.medicamentos.map((m) => m.id_medicamento);
    const meds = await client.query(
      `select id_medicamento, nombre_comercial, requiere_receta, activo from medicamento_ref where id_medicamento = any($1::int[])`,
      [ids],
    );
    const porId = new Map(meds.rows.map((m) => [m.id_medicamento, m]));
    datos.medicamentos.forEach((linea, i) => {
      const med = porId.get(linea.id_medicamento);
      if (!med || !med.activo) throw invalido("Medicamento no válido", { campo: `medicamentos[${i}].id_medicamento` });
      if (!med.requiere_receta) {
        throw new ErrorNegocio(400, "NO_REQUIERE_RECETA", `${med.nombre_comercial} no requiere receta médica`, { campo: `medicamentos[${i}].id_medicamento` });
      }
    });

    // La fecha se compara contra la base: ni futura ni vencida (la vigencia es un dato de politica_receta).
    const fecha = await client.query("select receta_vigente($1::date) as vigente, $1::date > current_date as futura", [datos.fecha]);
    if (fecha.rows[0].futura) throw invalido("La fecha de la receta no puede ser futura", { campo: "fecha_emision" });
    if (!fecha.rows[0].vigente) {
      const dias = (await client.query("select dias_vigencia from politica_receta where id = 1")).rows[0].dias_vigencia;
      throw new ErrorNegocio(400, "RECETA_VENCIDA", `La receta está vencida: solo vale ${dias} días desde su emisión`, { campo: "fecha_emision" });
    }

    // Un paciente por documento: dos recetas (o un reintento) reutilizan su fila.
    const { nombre, documento, telefono, correo } = datos.cliente;
    let cliente = await client.query(
      `insert into cliente (nombre, documento_identidad, telefono, correo) values ($1, $2, $3, $4)
       on conflict (documento_identidad) where documento_identidad is not null do nothing
       returning id_cliente`,
      [nombre, documento, telefono, correo],
    );
    if (cliente.rowCount === 0) {
      cliente = await client.query("select id_cliente from cliente where documento_identidad = $1", [documento]);
    }
    const receta = await client.query(
      `insert into receta (medico_prescriptor, fecha_emision, id_cliente, id_empleado_registro)
       values ($1, $2::date, $3, $4) returning id_receta`,
      [datos.medico, datos.fecha, cliente.rows[0].id_cliente, sesion.id_empleado],
    );
    const idReceta = receta.rows[0].id_receta;
    await client.query(
      `insert into receta_medicamento (id_receta, id_medicamento, cantidad_autorizada)
       select $1, l.id_medicamento, l.cantidad from unnest($2::int[], $3::int[]) as l(id_medicamento, cantidad)`,
      [idReceta, ids, datos.medicamentos.map((m) => m.cantidad)],
    );

    // Criterio 4: médico, fecha y medicamentos quedan en la bitácora no editable. El paciente no.
    const resumen = datos.medicamentos.map((m) => `${porId.get(m.id_medicamento).nombre_comercial} x${m.cantidad}`).join(", ");
    await auditar(client, sesion.id_empleado, "RECETA_REGISTRAR", "receta", idReceta, `Médico: ${datos.medico}; emitida ${datos.fecha}; ${resumen}`);
    return { status: 201, body: await recetaDe(client, idReceta, false) };
  });
}

// Detalle de una receta. Con permiso de datos personales se devuelve completa y la consulta queda auditada.
export async function obtenerReceta(sesion, idReceta) {
  const completo = veDatosPersonales(sesion);
  const receta = await recetaDe(local, idReceta, completo);
  if (completo) await auditar(local, sesion.id_empleado, "CLIENTE_DATOS_CONSULTAR", "receta", idReceta, "Consulta de datos personales del paciente");
  return receta;
}

// Recetas recientes. Siempre con el documento enmascarado; documento exacto sirve para ubicar la del paciente
// que está en la caja. solo_utilizables deja las vigentes con saldo (opcionalmente de un medicamento).
export async function listarRecetas(query) {
  const q = texto(query.q);
  if (q.length > 100) throw invalido("La búsqueda admite máximo 100 caracteres", { campo: "q" });
  const documento = texto(query.documento) || null;
  if (documento && !DOCUMENTO_RE.test(documento)) throw invalido("Documento no válido", { campo: "documento" });
  const idMedicamento = query.id_medicamento ? entero(query.id_medicamento, "id_medicamento") : null;
  const soloUtilizables = query.solo_utilizables === "1" || query.solo_utilizables === "true";
  const patron = q ? `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null;
  const filas = await local.query(
    `select r.id_receta
     from receta r
     left join cliente c on c.id_cliente = r.id_cliente
     where ($1::text is null or lower(r.medico_prescriptor) like $1 escape '\\' or lower(c.nombre) like $1 escape '\\')
       and ($2::text is null or c.documento_identidad = $2)
       and ($3::int is null or exists (select 1 from receta_medicamento x where x.id_receta = r.id_receta and x.id_medicamento = $3))
       and (not $4::boolean or (
              case when r.origen = 'CENTRAL'
                   then coalesce(r.reservada_hasta > now()::timestamp, false)
                        and not exists (select 1 from detalle_factura d where d.id_receta = r.id_receta)
                   else receta_vigente(r.fecha_emision) and (select permitir_registro_manual from politica_receta where id = 1) end
              and exists (
              select 1 from receta_medicamento x
              where x.id_receta = r.id_receta and x.cantidad_dispensada < x.cantidad_autorizada
                and ($3::int is null or x.id_medicamento = $3))))
     order by r.id_receta desc
     limit ${MAX_RESULTADOS}`,
    [patron, documento, idMedicamento, soloUtilizables],
  );
  return { recetas: await recetasDe(local, filas.rows.map((f) => f.id_receta), false) };
}

// Medicamentos que exigen receta, para armarla (criterio 1).
export async function medicamentosConReceta(query) {
  const q = texto(query.q);
  if (q.length > 100) throw invalido("La búsqueda admite máximo 100 caracteres", { campo: "q" });
  const patron = q ? `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null;
  const filas = await local.query(
    `select id_medicamento, codigo_interno, nombre_comercial, principio_activo
     from medicamento_ref
     where requiere_receta and activo
       and ($1::text is null or lower(nombre_comercial) like $1 escape '\\' or lower(principio_activo) like $1 escape '\\' or lower(codigo_interno) like $1 escape '\\')
     order by nombre_comercial
     limit ${MAX_RESULTADOS}`,
    [patron],
  );
  return { medicamentos: filas.rows };
}

// Criterio 3: las recetas asociadas a una factura, para trazabilidad. Documento enmascarado salvo permiso.
export async function recetasDeFactura(sesion, idFactura) {
  const completo = veDatosPersonales(sesion);
  const factura = await local.query("select 1 from factura where id_factura = $1", [idFactura]);
  if (factura.rowCount === 0) throw noEncontrado("La factura no existe");
  const filas = await local.query(
    "select distinct id_receta from detalle_factura where id_factura = $1 and id_receta is not null order by id_receta",
    [idFactura],
  );
  const recetas = await recetasDe(local, filas.rows.map((f) => f.id_receta), completo);
  if (completo && recetas.length > 0) {
    await auditar(local, sesion.id_empleado, "CLIENTE_DATOS_CONSULTAR", "factura", idFactura, "Consulta de datos personales del paciente");
  }
  return { id_factura: idFactura, recetas };
}

// Anticipa lo que la base hará al insertar las líneas (criterios 1, 2 y 5): sin modificar nada, dice qué líneas
// piden receta y si la receta indicada sirve para cada una. La venta (HU-08) la llama antes de facturar.
// lineas: [{ id_medicamento, cantidad }]. idCliente es el de la factura, si ya se conoce.
export async function evaluarReceta(db, { idReceta = null, idCliente = null, lineas }) {
  if (!Array.isArray(lineas) || lineas.length === 0 || lineas.length > 200) throw invalido("Indique las líneas de la venta", { campo: "lineas" });
  const pedido = new Map();
  lineas.forEach((l, i) => {
    const id = entero(l?.id_medicamento, `lineas[${i}].id_medicamento`);
    pedido.set(id, (pedido.get(id) || 0) + entero(l?.cantidad, `lineas[${i}].cantidad`, MAX_CANTIDAD));
  });
  const id = idReceta == null || idReceta === "" ? null : entero(idReceta, "id_receta");

  const ids = [...pedido.keys()];
  const meds = await db.query(
    `select m.id_medicamento, m.nombre_comercial, m.requiere_receta,
            rm.cantidad_autorizada, rm.cantidad_dispensada, r.id_receta is not null as en_receta,
            receta_vigente(r.fecha_emision) as vigente, r.id_cliente, r.origen,
            coalesce(r.reservada_hasta > now()::timestamp, false) as reserva_vigente,
            exists (select 1 from detalle_factura d where d.id_receta = r.id_receta) as dispensada,
            (select permitir_registro_manual from politica_receta where id = 1) as manual_permitido
     from medicamento_ref m
     left join receta r on r.id_receta = $2::int
     left join receta_medicamento rm on rm.id_receta = r.id_receta and rm.id_medicamento = m.id_medicamento
     where m.id_medicamento = any($1::int[])`,
    [ids, id],
  );
  const porId = new Map(meds.rows.map((m) => [m.id_medicamento, m]));
  const resultado = ids.map((idMed) => {
    const m = porId.get(idMed);
    if (!m) return { id_medicamento: idMed, requiere_receta: false, estado: "MEDICAMENTO_DESCONOCIDO" };
    const base = { id_medicamento: idMed, nombre_comercial: m.nombre_comercial, requiere_receta: m.requiere_receta, cantidad: pedido.get(idMed) };
    if (!m.requiere_receta) return { ...base, estado: "NO_REQUIERE" };
    if (id == null) return { ...base, estado: "RECETA_REQUERIDA" };
    if (!m.en_receta || m.cantidad_autorizada == null) return { ...base, estado: "RECETA_INVALIDA" };
    if (m.origen === "CENTRAL") {
      if (!m.reserva_vigente) return { ...base, estado: "RECETA_RESERVA_VENCIDA" };
      if (m.dispensada) return { ...base, estado: "RECETA_RECLAMADA" };
    } else {
      if (!m.manual_permitido) return { ...base, estado: "RECETA_MANUAL_NO_PERMITIDA" };
      if (!m.vigente) return { ...base, estado: "RECETA_VENCIDA" };
    }
    if (idCliente != null && Number(idCliente) !== Number(m.id_cliente)) return { ...base, estado: "RECETA_CLIENTE" };
    const saldo = m.cantidad_autorizada - m.cantidad_dispensada;
    if (pedido.get(idMed) > saldo) return { ...base, estado: "RECETA_SALDO", saldo };
    return { ...base, estado: "OK", saldo };
  });
  return {
    requiere_receta: resultado.some((r) => r.requiere_receta),
    puede_continuar: resultado.every((r) => r.estado === "NO_REQUIERE" || r.estado === "OK"),
    lineas: resultado,
  };
}
