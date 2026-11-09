import crypto from "crypto";
import { local, runtime } from "./db.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { ErrorNegocio, conflicto, invalido, noEncontrado } from "./errores.mjs";
import { registrarMovimiento } from "./inventario/movimientos.mjs";
import { encolarStockSnapshot } from "./inventario/stock.mjs";
import { aCentavos, aDecimal, porCategoria } from "./ventas.mjs";

// HU-10: anular una factura (total) o devolver parte de ella. Todo corre en la base de la tienda y funciona sin
// conexión con el central: la nota, el reingreso al lote de origen, la auditoría y el evento para el central salen en UNA
// transacción. Las reglas (motivo, una sola anulación, no devolver más de lo vendido, nota completa) las refuerza además
// la base en db/local/10_hu10_devoluciones.sql, así que ni dos cajeros simultáneos ni un reintento las rompen.
//
// Distinción: ANULACION_TOTAL cubre toda la factura y exige que no tenga devoluciones previas; DEVOLUCION_PARCIAL
// devuelve algunas líneas/unidades y nunca puede cubrir de una vez toda la factura (para eso es la anulación).
// Importes en centavos enteros: el impuesto de una devolución se reparte por unidades con redondeo acumulado, de modo que
// devolver todo en varias veces suma exactamente el impuesto original. El reintegro se reparte entre los métodos de pago
// de la factura de forma proporcional a lo que cada uno aún puede devolver (nunca más de lo pagado con ese método).

const MOTIVO_MIN = 5;
const MOTIVO_MAX = 300;
const MAX_LINEAS = 50;

const texto = (v) => String(v ?? "").trim();

function motivoDe(body) {
  const motivo = texto(body?.motivo).replace(/\s+/g, " ");
  if (motivo.length < MOTIVO_MIN) {
    throw new ErrorNegocio(400, "MOTIVO_OBLIGATORIO", `Indique el motivo (mínimo ${MOTIVO_MIN} caracteres)`, { campo: "motivo" });
  }
  if (motivo.length > MOTIVO_MAX) throw invalido(`El motivo admite máximo ${MOTIVO_MAX} caracteres`, { campo: "motivo" });
  return motivo;
}

function entero(valor, campo, maximo = 2_000_000_000) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > maximo) throw invalido(`${campo} no válido`, { campo });
  return n;
}

function validarLineas(lineas) {
  if (!Array.isArray(lineas) || lineas.length === 0) throw invalido("Indique al menos una línea a devolver", { campo: "lineas" });
  if (lineas.length > MAX_LINEAS) throw invalido(`Máximo ${MAX_LINEAS} líneas por devolución`, { campo: "lineas" });
  const vistos = new Set();
  return lineas.map((l, i) => {
    const idLote = entero(l?.id_lote, `lineas[${i}].id_lote`);
    if (vistos.has(idLote)) throw invalido("Una línea aparece dos veces: sume sus cantidades", { campo: `lineas[${i}].id_lote` });
    vistos.add(idLote);
    return { id_lote: idLote, cantidad: entero(l?.cantidad, `lineas[${i}].cantidad`, 100000) };
  });
}

// Estado de devolución de una factura: cada línea con lo vendido, lo devuelto y lo que aún se puede devolver, y las notas
// emitidas. Lo usa la pantalla y el propio cálculo de la operación (con db = client y bloqueo = true).
export async function devolucionesDe(db, idFactura, { bloquear = false } = {}) {
  const f = await db.query(
    `select id_factura, numero_factura, fecha_hora, total::text, estado from factura where id_factura = $1 ${bloquear ? "for update" : ""}`,
    [idFactura],
  );
  if (f.rowCount === 0) throw noEncontrado("La factura no existe");
  const lineas = await db.query(
      `select d.id_lote, l.numero_lote, m.nombre_comercial as medicamento, l.id_medicamento, m.id_categoria, d.cantidad,
              d.precio_unitario_aplicado::text as precio_unitario, d.tasa_impuesto::text as tasa_impuesto,
              d.subtotal_linea::text as subtotal, d.impuesto_linea::text as impuesto,
              coalesce((select sum(dd.cantidad_devuelta) from detalle_devolucion dd
                          join anulacion_devolucion a on a.id_anulacion = dd.id_anulacion
                         where a.id_factura = d.id_factura and dd.id_lote = d.id_lote), 0)::int as devuelta
       from detalle_factura d
       join lote l on l.id_lote = d.id_lote
       join medicamento_ref m on m.id_medicamento = l.id_medicamento
       where d.id_factura = $1 order by d.id_lote`,
      [idFactura],
  );
  const notas = await db.query(
      `select a.id_anulacion, a.numero_nota, a.tipo, a.motivo, a.fecha_hora, a.total_devuelto::text as total_devuelto,
              e.nombre_completo as empleado
       from anulacion_devolucion a left join empleado_ref e on e.id_empleado = a.id_empleado
       where a.id_factura = $1 order by a.id_anulacion`,
      [idFactura],
  );
  const pagos = await db.query(
      `select p.id_metodo_pago, p.monto::text as monto,
              coalesce((select sum(r.monto) from devolucion_pago r join anulacion_devolucion a on a.id_anulacion = r.id_anulacion
                         where a.id_factura = p.id_factura and r.id_metodo_pago = p.id_metodo_pago), 0)::text as reintegrado
       from factura_metodo_pago p where p.id_factura = $1 order by p.id_metodo_pago`,
      [idFactura],
  );
  const factura = f.rows[0];
  return {
    factura,
    lineas: lineas.rows.map((l) => ({ ...l, disponible: l.cantidad - l.devuelta })),
    notas: notas.rows,
    pagos: pagos.rows,
    anulable: factura.estado === "EMITIDA" && notas.rowCount === 0,
    devolvible: factura.estado !== "ANULADA" && lineas.rows.some((l) => l.cantidad > l.devuelta),
  };
}

export const consultarDevoluciones = (idFactura) => devolucionesDe(local, idFactura);

// Reparte `centavos` entre los métodos según lo que a cada uno le queda por devolver (resto por mayor fracción).
function repartirReintegro(pagos, centavos) {
  const quedan = pagos.map((p) => ({ id: p.id_metodo_pago, queda: aCentavos(p.monto) - aCentavos(p.reintegrado) }));
  const total = quedan.reduce((s, p) => s + p.queda, 0);
  if (centavos > total) throw conflicto("REINTEGRO_EXCEDE", "El valor a reintegrar excede lo pagado con los métodos de pago de la factura");
  const partes = quedan.map((p) => {
    const exacto = (centavos * p.queda) / total;
    const base = Math.floor(exacto);
    return { id: p.id, monto: base, fraccion: exacto - base };
  });
  let faltan = centavos - partes.reduce((s, p) => s + p.monto, 0);
  for (const p of [...partes].sort((a, b) => b.fraccion - a.fraccion || a.id - b.id)) {
    if (faltan === 0) break;
    p.monto += 1;
    faltan -= 1;
  }
  return partes.filter((p) => p.monto > 0).map((p) => ({ id_metodo_pago: p.id, centavos: p.monto }));
}

// Impuesto de q unidades de una línea de n unidades de las que ya se devolvieron r: redondeo acumulado.
const impuestoDe = (impuesto, n, r, q) => Math.round((impuesto * (r + q)) / n) - Math.round((impuesto * r) / n);

async function procesar(sesion, idFactura, tipo, motivo, solicitadas, key, body) {
  const operacion = tipo === "ANULACION_TOTAL" ? "FACTURA_ANULAR" : "FACTURA_DEVOLVER";
  return conIdempotencia(local, { key, operacion, idEmpleado: sesion.id_empleado, body: { idFactura, ...body } }, async (client) => {
    // 1. La factura queda bloqueada hasta el commit: dos operaciones simultáneas sobre ella se hacen en fila.
    const estado = await devolucionesDe(client, idFactura, { bloquear: true });
    const factura = estado.factura;
    if (factura.estado === "ANULADA") throw conflicto("FACTURA_ANULADA", `La factura ${factura.numero_factura} ya fue anulada`);

    // 2. Qué se devuelve.
    let items;
    if (tipo === "ANULACION_TOTAL") {
      if (estado.notas.length > 0) {
        throw conflicto("FACTURA_CON_DEVOLUCIONES", `La factura ${factura.numero_factura} ya tiene devoluciones: no se puede anular completa`);
      }
      items = estado.lineas.map((l) => ({ ...l, q: l.cantidad }));
    } else {
      const porLote = new Map(estado.lineas.map((l) => [l.id_lote, l]));
      items = solicitadas.map((s) => {
        const linea = porLote.get(s.id_lote);
        if (!linea) throw invalido("La línea no pertenece a la factura", { campo: "lineas", id_lote: s.id_lote });
        if (s.cantidad > linea.disponible) {
          throw conflicto("DEVOLUCION_EXCEDE", `${linea.medicamento}: se vendieron ${linea.cantidad} y ya se devolvieron ${linea.devuelta}`, {
            id_lote: s.id_lote,
            vendida: linea.cantidad,
            devuelta: linea.devuelta,
            disponible: linea.disponible,
          });
        }
        return { ...linea, q: s.cantidad };
      });
      if (estado.notas.length === 0 && items.length === estado.lineas.length && items.every((i) => i.q === i.cantidad)) {
        throw conflicto("DEVOLUCION_TOTAL", "Esa devolución cubre toda la factura: use la anulación total");
      }
    }
    items.sort((a, b) => a.id_lote - b.id_lote); // orden fijo de bloqueo de lotes

    // 3. Importes en centavos.
    for (const i of items) {
      i.subtotalC = aCentavos(i.precio_unitario) * i.q;
      i.impuestoC = impuestoDe(aCentavos(i.impuesto), i.cantidad, i.devuelta, i.q);
    }
    const subtotal = items.reduce((s, i) => s + i.subtotalC, 0);
    const impuestos = items.reduce((s, i) => s + i.impuestoC, 0);
    const total = subtotal + impuestos;
    const reintegro = repartirReintegro(estado.pagos, total);

    // 4. Nota, líneas, reintegro, estado de la factura, auditoría y evento para el central, en una sentencia.
    const accion = tipo === "ANULACION_TOTAL" ? "FACTURA_ANULAR" : "FACTURA_DEVOLVER";
    const nota = await client.query(
      `insert into anulacion_devolucion (id_factura, tipo, motivo, id_empleado, numero_nota, subtotal_devuelto, impuestos_devueltos, total_devuelto)
       values ($1, $2, $3, $4, siguiente_numero_nota($5), $6::numeric, $7::numeric, $8::numeric)
       returning id_anulacion, numero_nota, fecha_hora`,
      [idFactura, tipo, motivo, sesion.id_empleado, runtime.tiendaId, aDecimal(subtotal), aDecimal(impuestos), aDecimal(total)],
    );
    const { id_anulacion: idAnulacion, numero_nota: numeroNota, fecha_hora: fechaNota } = nota.rows[0];
    const nuevoEstado = tipo === "ANULACION_TOTAL" ? "ANULADA" : "DEVOLUCION_PARCIAL";
    const evento = {
      id_anulacion: idAnulacion,
      numero_nota: numeroNota,
      numero_factura: factura.numero_factura,
      tipo,
      fecha: fechaNota.toISOString().slice(0, 10),
      total: aDecimal(total),
      pagos: reintegro.map((p) => ({ id_metodo_pago: p.id_metodo_pago, monto: aDecimal(p.centavos) })),
      categorias: porCategoria(items.map((i) => ({ id_categoria: i.id_categoria, cantidad: i.q, centavos: i.subtotalC + i.impuestoC }))),
    };
    const detalleAuditoria = `${numeroNota} sobre ${factura.numero_factura}; ${tipo === "ANULACION_TOTAL" ? "anulación total" : "devolución parcial"}; total ${aDecimal(total)}; motivo: ${motivo}`;
    await client.query(
      `with d as (
         insert into detalle_devolucion (id_anulacion, id_lote, cantidad_devuelta, subtotal_devuelto, impuesto_devuelto)
         select $1, x.id_lote, x.cantidad, x.subtotal, x.impuesto
         from unnest($2::int[], $3::int[], $4::numeric[], $5::numeric[]) as x(id_lote, cantidad, subtotal, impuesto)
         returning 1
       ), p as (
         insert into devolucion_pago (id_anulacion, id_metodo_pago, monto)
         select $1, y.id_metodo_pago, y.monto from unnest($6::int[], $7::numeric[]) as y(id_metodo_pago, monto)
         returning 1
       ), f as (
         update factura set estado = $8 where id_factura = $9 returning 1
       ), a as (
         insert into registro_actividad (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
         values ($10, $11, 'factura', $9, $12) returning 1
       ), o as (
         insert into outbox_sync (id_empleado, idempotency_key, tipo_evento, payload)
         values (null, $13, 'DEVOLUCION_REGISTRADA', $14::jsonb) returning 1
       )
       select (select count(*) from d) as lineas`,
      [
        idAnulacion,
        items.map((i) => i.id_lote),
        items.map((i) => i.q),
        items.map((i) => aDecimal(i.subtotalC)),
        items.map((i) => aDecimal(i.impuestoC)),
        reintegro.map((p) => p.id_metodo_pago),
        reintegro.map((p) => aDecimal(p.centavos)),
        nuevoEstado,
        idFactura,
        sesion.id_empleado,
        accion,
        detalleAuditoria.slice(0, 400),
        crypto.randomUUID(),
        JSON.stringify(evento),
      ],
    );

    // 5. Reingreso de cada cantidad a su lote de origen por el único camino de inventario (RF-04).
    for (const i of items) {
      await registrarMovimiento(client, {
        idLote: i.id_lote,
        tipo: "DEVOLUCION",
        cantidad: i.q,
        idEmpleado: sesion.id_empleado,
        idTienda: runtime.tiendaId,
        referencia: numeroNota,
        observaciones: motivo,
        publicarStock: false,
      });
    }
    await encolarStockSnapshot(client, { idTienda: runtime.tiendaId, idsMedicamento: [...new Set(items.map((i) => i.id_medicamento))] });

    const despues = await devolucionesDe(client, idFactura);
    return {
      status: 201,
      body: {
        nota: { id_anulacion: idAnulacion, numero_nota: numeroNota, tipo, motivo, fecha_hora: fechaNota, total_devuelto: aDecimal(total), subtotal_devuelto: aDecimal(subtotal), impuestos_devueltos: aDecimal(impuestos), pagos: evento.pagos },
        ...despues,
      },
    };
  });
}

// Traduce lo que la base rechaza al hacer commit (carreras que el API no alcanzó a ver) a errores de negocio.
function traducir(error) {
  const m = /^(FACTURA_ANULADA|FACTURA_CON_DEVOLUCIONES|DEVOLUCION_EXCEDE|DEVOLUCION_LINEA):\s*(.*)$/.exec(error?.message ?? "");
  if (m) return conflicto(m[1], m[2]);
  if (error?.code === "23505" && /ux_anulacion_total_por_factura/.test(error.constraint ?? error.message ?? "")) {
    return conflicto("FACTURA_ANULADA", "La factura ya fue anulada");
  }
  return error;
}

export async function anularFactura(sesion, key, idFactura, body) {
  const motivo = motivoDe(body);
  try {
    return await procesar(sesion, idFactura, "ANULACION_TOTAL", motivo, null, key, { motivo });
  } catch (error) {
    throw traducir(error);
  }
}

export async function devolverParcial(sesion, key, idFactura, body) {
  const motivo = motivoDe(body);
  const lineas = validarLineas(body?.lineas);
  try {
    return await procesar(sesion, idFactura, "DEVOLUCION_PARCIAL", motivo, lineas, key, { motivo, lineas });
  } catch (error) {
    throw traducir(error);
  }
}
