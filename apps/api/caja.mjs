import crypto from "crypto";
import { local } from "./db.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { ErrorNegocio, conflicto, invalido, noEncontrado } from "./errores.mjs";
import { aCentavos, etiquetaMetodo } from "./ventas.mjs";
import { auditar } from "./inventario/lotes.mjs";

// HU-11: cierre de caja (RF-07, regla de negocio 8, RNF-04, RNF-06, RNF-10, RNF-12). Todo es local: la tienda cierra y abre
// su caja aunque no alcance al central. El esquema y sus garantías están en db/local/13_hu11_cierre_caja.sql.
//
// Modelo: la tienda tiene un PERIODO de caja abierto. Cada factura queda en el periodo en que se emitió y cada nota de
// devolución en el periodo abierto cuando se emitió (o en el siguiente si la caja ya estaba cerrada). Cerrar totaliza el
// periodo por método de pago y por empleado, lo compara con lo contado, exige justificación si algo no cuadra, deja el cierre
// inmutable y la caja CERRADA: no se registran ventas hasta que un administrador abre un nuevo periodo.
// Importes en centavos enteros (nunca flotantes); lo calculado de un método es lo vendido menos lo devuelto por él.

const JUSTIFICACION_MIN = 10;
const JUSTIFICACION_MAX = 300;
const MAX_CIERRES = 50;

// Con signo: lo calculado puede ser negativo si se devolvió más (de ventas de otro periodo) de lo que se vendió.
export function dec(centavos) {
  const c = Number(centavos);
  return `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;
}

const esEfectivo = (nombre) => nombre === "efectivo";
// "Vouchers de tarjeta": lo que el datáfono imprime. La transferencia se cuenta contra su comprobante.
const esTarjeta = (nombre) => String(nombre).startsWith("tarjeta");

const textoOpcional = (valor, max, campo, etiqueta) => {
  const limpio = String(valor ?? "").trim().replace(/\s+/g, " ");
  if (limpio.length > max) throw invalido(`${etiqueta} admite máximo ${max} caracteres`, { campo });
  return limpio || null;
};

// ---- Estado y totales ----

// Si la caja está abierta, qué periodo corre y desde cuándo; y el último cierre. Lo lee el POS (también el cajero, para avisar).
export async function estadoCaja(db = local) {
  const r = await db.query(
    `select c.periodo, c.abierta, c.abierta_en, k.id_cierre, k.fecha_hora_cierre, k.estado as estado_cierre, e.nombre_completo as cerro
     from caja_control c
     left join lateral (select * from cierre_caja order by id_cierre desc limit 1) k on true
     left join empleado_ref e on e.id_empleado = k.id_empleado
     where c.id = 1`,
  );
  const f = r.rows[0];
  return {
    abierta: f.abierta,
    periodo: f.periodo,
    abierta_en: f.abierta_en,
    ultimo_cierre: f.id_cierre
      ? { id_cierre: f.id_cierre, fecha_hora_cierre: f.fecha_hora_cierre, estado: f.estado_cierre, cerro: f.cerro }
      : null,
  };
}

// Criterio 1: lo vendido y lo devuelto del periodo por método de pago y por empleado que operó la caja. db: el pool o el client
// de una transacción (el cierre lo llama con la caja bloqueada).
async function calcularPeriodo(db, periodo) {
  const [ventas, devoluciones, conteos, metodos] = await Promise.all([
    db.query(
      `select f.id_empleado, p.id_metodo_pago, (sum(p.monto) * 100)::bigint as c
       from factura f join factura_metodo_pago p on p.id_factura = f.id_factura
       where f.periodo_caja = $1 group by 1, 2 order by 1, 2`,
      [periodo],
    ),
    db.query(
      `select a.id_empleado, r.id_metodo_pago, (sum(r.monto) * 100)::bigint as c
       from anulacion_devolucion a join devolucion_pago r on r.id_anulacion = a.id_anulacion
       where a.periodo_caja = $1 group by 1, 2 order by 1, 2`,
      [periodo],
    ),
    db.query(
      `select (select count(*) from factura where periodo_caja = $1)::int as facturas,
              (select count(*) from anulacion_devolucion where periodo_caja = $1)::int as notas`,
      [periodo],
    ),
    db.query("select id_metodo_pago, nombre, activo from metodo_pago_ref order by id_metodo_pago"),
  ]);
  const idsEmpleado = [...new Set([...ventas.rows, ...devoluciones.rows].map((r) => r.id_empleado))];
  const nombres = idsEmpleado.length
    ? await db.query("select id_empleado, nombre_completo from empleado_ref where id_empleado = any($1::int[])", [idsEmpleado])
    : { rows: [] };
  const nombreDe = new Map(nombres.rows.map((r) => [r.id_empleado, r.nombre_completo]));

  const porMetodo = new Map(metodos.rows.map((m) => [m.id_metodo_pago, { ...m, vendido: 0, devuelto: 0 }]));
  const porEmpleado = new Map();
  const empleado = (id) => {
    if (!porEmpleado.has(id)) porEmpleado.set(id, { id_empleado: id, nombre: nombreDe.get(id) ?? `Empleado ${id}`, vendido: 0, devuelto: 0, metodos: new Map() });
    return porEmpleado.get(id);
  };
  const sumar = (filas, campo) => {
    for (const fila of filas) {
      const c = Number(fila.c);
      porMetodo.get(fila.id_metodo_pago)[campo] += c;
      const e = empleado(fila.id_empleado);
      e[campo] += c;
      const m = e.metodos.get(fila.id_metodo_pago) ?? { id_metodo_pago: fila.id_metodo_pago, vendido: 0, devuelto: 0 };
      m[campo] += c;
      e.metodos.set(fila.id_metodo_pago, m);
    }
  };
  sumar(ventas.rows, "vendido");
  sumar(devoluciones.rows, "devuelto");

  // Los métodos activos siempre se muestran (para contarlos); uno inactivo solo si tuvo movimiento.
  const lista = [...porMetodo.values()].filter((m) => m.activo || m.vendido !== 0 || m.devuelto !== 0);
  const firma = crypto.createHash("sha1").update(JSON.stringify([periodo, ventas.rows, devoluciones.rows])).digest("hex").slice(0, 16);
  return {
    periodo,
    facturas: conteos.rows[0].facturas,
    notas: conteos.rows[0].notas,
    metodos: lista,
    empleados: [...porEmpleado.values()].sort((a, b) => a.nombre.localeCompare(b.nombre)),
    firma,
  };
}

function vistaCalculo(calculo, abiertaEn) {
  const total = calculo.metodos.reduce((s, m) => s + m.vendido - m.devuelto, 0);
  return {
    periodo: calculo.periodo,
    abierta_en: abiertaEn,
    facturas: calculo.facturas,
    notas: calculo.notas,
    total_sistema: dec(total),
    por_metodo: calculo.metodos.map((m) => ({
      id_metodo_pago: m.id_metodo_pago,
      metodo: m.nombre,
      etiqueta: etiquetaMetodo(m.nombre),
      tipo_conteo: esEfectivo(m.nombre) ? "EFECTIVO" : esTarjeta(m.nombre) ? "VOUCHERS" : "COMPROBANTES",
      vendido: dec(m.vendido),
      devuelto: dec(m.devuelto),
      calculado: dec(m.vendido - m.devuelto),
    })),
    por_empleado: calculo.empleados.map((e) => ({
      id_empleado: e.id_empleado,
      nombre: e.nombre,
      vendido: dec(e.vendido),
      devuelto: dec(e.devuelto),
      neto: dec(e.vendido - e.devuelto),
      metodos: [...e.metodos.values()].map((m) => ({ id_metodo_pago: m.id_metodo_pago, vendido: dec(m.vendido), devuelto: dec(m.devuelto) })),
    })),
    firma: calculo.firma,
  };
}

// El resumen que el administrador ve antes de contar. Con la caja cerrada no hay periodo abierto que totalizar.
export async function resumenCaja() {
  const estado = await estadoCaja();
  if (!estado.abierta) return { ...estado, resumen: null };
  return { ...estado, resumen: vistaCalculo(await calcularPeriodo(local, estado.periodo), estado.abierta_en) };
}

// ---- Cierre ----

// Criterio 2: lo contado por método. Efectivo: el efectivo contado; tarjetas: el total de los vouchers; transferencia: sus
// comprobantes. Cada monto es no negativo con máximo dos decimales; un método no se repite.
function conteoDe(contado) {
  // Un periodo sin movimiento se puede cerrar sin contar nada; uno con movimiento exige contar cada método (CONTEO_INCOMPLETO).
  if (contado == null) return new Map();
  if (!Array.isArray(contado)) throw invalido("Registre lo contado: efectivo y vouchers", { campo: "contado" });
  const mapa = new Map();
  contado.forEach((fila, i) => {
    const id = Number(fila?.id_metodo_pago);
    if (!Number.isInteger(id) || id < 1) throw invalido(`contado[${i + 1}].id_metodo_pago no válido`, { campo: `contado[${i + 1}].id_metodo_pago` });
    if (mapa.has(id)) throw invalido("Un método de pago aparece dos veces: sume sus montos", { campo: `contado[${i + 1}].id_metodo_pago` });
    mapa.set(id, aCentavos(fila?.monto, `contado[${i + 1}].monto`));
  });
  return mapa;
}

// Criterios 1 a 4. Con la caja bloqueada (FOR UPDATE) el cierre espera a las ventas y devoluciones en curso y ninguna se cuela
// después; en la misma transacción se totaliza, se compara, se registra el cierre inmutable y se deja la caja cerrada.
export async function cerrarCaja(sesion, key, body) {
  const contado = conteoDe(body?.contado);
  const turno = textoOpcional(body?.turno, 20, "turno", "El turno");
  const justificacion = textoOpcional(body?.justificacion, JUSTIFICACION_MAX, "justificacion", "La justificación");
  const firma = body?.firma == null ? null : String(body.firma);

  return conIdempotencia(local, { key, operacion: "CAJA_CERRAR", idEmpleado: sesion.id_empleado, body }, async (client) => {
    const caja = await client.query("select periodo, abierta, abierta_en from caja_control where id = 1 for update");
    const { periodo, abierta, abierta_en: abiertaEn } = caja.rows[0];
    if (!abierta) throw conflicto("CAJA_YA_CERRADA", "La caja ya está cerrada: el periodo se cerró (otro administrador, o un reintento)");

    const calculo = await calcularPeriodo(client, periodo);
    // Si hubo ventas o devoluciones desde que el administrador calculó el resumen, lo que contó ya no es comparable.
    if (firma && firma !== calculo.firma) {
      throw conflicto("RESUMEN_DESACTUALIZADO", "Hubo ventas o devoluciones desde que calculó el resumen: recalcúlelo y vuelva a contar", {
        resumen: vistaCalculo(calculo, abiertaEn),
      });
    }

    const idsConocidos = new Set(calculo.metodos.map((m) => m.id_metodo_pago));
    for (const id of contado.keys()) {
      if (!idsConocidos.has(id)) throw invalido("Algún método de pago no existe", { campo: "contado" });
    }
    // Un método con movimiento no se puede dejar sin contar: sería un descuadre que nadie vio.
    const sinContar = calculo.metodos.filter((m) => (m.vendido !== 0 || m.devuelto !== 0) && !contado.has(m.id_metodo_pago));
    if (sinContar.length > 0) {
      throw new ErrorNegocio(400, "CONTEO_INCOMPLETO", `Falta registrar lo contado de: ${sinContar.map((m) => etiquetaMetodo(m.nombre)).join(", ")}`, {
        faltan: sinContar.map((m) => ({ id_metodo_pago: m.id_metodo_pago, etiqueta: etiquetaMetodo(m.nombre) })),
      });
    }

    const filas = calculo.metodos.map((m) => {
      const calculado = m.vendido - m.devuelto;
      const reportado = contado.get(m.id_metodo_pago) ?? 0;
      return { ...m, calculado, reportado, diferencia: reportado - calculado };
    });
    const conDiferencia = filas.filter((f) => f.diferencia !== 0);
    // Criterio 3: no se cierra con una diferencia sin justificar. Cada método se compara por separado: un sobrante en efectivo
    // no tapa un faltante en tarjeta.
    if (conDiferencia.length > 0 && (!justificacion || justificacion.length < JUSTIFICACION_MIN)) {
      throw new ErrorNegocio(409, "CIERRE_CON_DIFERENCIA", `El cierre tiene diferencias sin justificar: escriba la justificación (mínimo ${JUSTIFICACION_MIN} caracteres)`, {
        diferencias: conDiferencia.map((f) => ({
          id_metodo_pago: f.id_metodo_pago,
          etiqueta: etiquetaMetodo(f.nombre),
          calculado: dec(f.calculado),
          reportado: dec(f.reportado),
          diferencia: dec(f.diferencia),
        })),
      });
    }

    const totalSistema = filas.reduce((s, f) => s + f.calculado, 0);
    const totalEfectivo = filas.filter((f) => esEfectivo(f.nombre)).reduce((s, f) => s + f.reportado, 0);
    const totalVouchers = filas.filter((f) => esTarjeta(f.nombre)).reduce((s, f) => s + f.reportado, 0);
    const diferenciaTotal = filas.reduce((s, f) => s + f.diferencia, 0);
    const estado = conDiferencia.length > 0 ? "CON_DIFERENCIA" : "CONCILIADO";

    const cierre = await client.query(
      `insert into cierre_caja (id_empleado, fecha, turno, total_sistema, total_efectivo_contado, total_vouchers, diferencia, estado,
                                fecha_hora_cierre, periodo_caja, abierto_en, justificacion)
       values ($1, current_date, $2, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7, clock_timestamp()::timestamp, $8,
               coalesce($9::timestamp, (select min(fecha_hora) from factura where periodo_caja = $8), now()::timestamp), $10)
       returning id_cierre, fecha_hora_cierre`,
      [sesion.id_empleado, turno, dec(totalSistema), dec(totalEfectivo), dec(totalVouchers), dec(diferenciaTotal), estado, periodo, abiertaEn, conDiferencia.length > 0 ? justificacion : null],
    );
    const { id_cierre: idCierre, fecha_hora_cierre: fechaCierre } = cierre.rows[0];

    await client.query(
      `insert into cierre_caja_metodo_pago (id_cierre, id_metodo_pago, total_calculado_sistema, total_reportado_empleado, vendido, devuelto, diferencia)
       select $1, x.id_metodo_pago, x.calculado, x.reportado, x.vendido, x.devuelto, x.diferencia
       from unnest($2::int[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])
         as x(id_metodo_pago, calculado, reportado, vendido, devuelto, diferencia)`,
      [
        idCierre,
        filas.map((f) => f.id_metodo_pago),
        filas.map((f) => dec(f.calculado)),
        filas.map((f) => dec(f.reportado)),
        filas.map((f) => dec(f.vendido)),
        filas.map((f) => dec(f.devuelto)),
        filas.map((f) => dec(f.diferencia)),
      ],
    );
    const porEmpleado = calculo.empleados.flatMap((e) => [...e.metodos.values()].map((m) => ({ id_empleado: e.id_empleado, ...m })));
    if (porEmpleado.length > 0) {
      await client.query(
        `insert into cierre_caja_empleado (id_cierre, id_empleado, id_metodo_pago, vendido, devuelto)
         select $1, x.id_empleado, x.id_metodo_pago, x.vendido, x.devuelto
         from unnest($2::int[], $3::int[], $4::numeric[], $5::numeric[]) as x(id_empleado, id_metodo_pago, vendido, devuelto)`,
        [idCierre, porEmpleado.map((p) => p.id_empleado), porEmpleado.map((p) => p.id_metodo_pago), porEmpleado.map((p) => dec(p.vendido)), porEmpleado.map((p) => dec(p.devuelto))],
      );
    }

    // Criterio 5: la caja queda cerrada. Desde aquí cualquier factura nueva es rechazada (API y trigger de la base).
    await client.query("update caja_control set abierta = false where id = 1");

    const detalle =
      `cierre ${idCierre}; periodo ${periodo}; sistema ${dec(totalSistema)}; efectivo contado ${dec(totalEfectivo)}; vouchers ${dec(totalVouchers)}; ` +
      `${estado}${conDiferencia.length > 0 ? `; diferencia ${dec(diferenciaTotal)}; justificación: ${justificacion}` : ""}`;
    await auditar(client, sesion.id_empleado, "CAJA_CERRAR", "cierre_caja", idCierre, detalle);

    return { status: 201, body: { ...(await detalleCierre(client, idCierre)), cerrado_en: fechaCierre } };
  });
}

// Abrir un nuevo periodo (turno): desde aquí se vuelve a vender. Solo si la caja está cerrada.
export async function abrirCaja(sesion, key, body) {
  const turno = textoOpcional(body?.turno, 20, "turno", "El turno");
  return conIdempotencia(local, { key, operacion: "CAJA_ABRIR", idEmpleado: sesion.id_empleado, body }, async (client) => {
    const caja = await client.query("select periodo, abierta from caja_control where id = 1 for update");
    if (caja.rows[0].abierta) throw conflicto("CAJA_YA_ABIERTA", "La caja ya está abierta: hay un periodo en curso");
    const nuevo = caja.rows[0].periodo + 1;
    const abierta = await client.query("update caja_control set periodo = $1, abierta = true, abierta_en = clock_timestamp()::timestamp where id = 1 returning abierta_en", [nuevo]);
    await client.query("insert into apertura_caja (periodo_caja, id_empleado, fecha_hora, turno) values ($1, $2, $3, $4)", [nuevo, sesion.id_empleado, abierta.rows[0].abierta_en, turno]);
    await auditar(client, sesion.id_empleado, "CAJA_ABRIR", "caja_control", nuevo, `periodo ${nuevo}${turno ? `; turno ${turno}` : ""}`);
    return { status: 201, body: await estadoCaja(client) };
  });
}

// ---- Consulta ----

export async function listarCierres() {
  const r = await local.query(
    `select k.id_cierre, k.periodo_caja, k.turno, k.fecha_hora_cierre, k.abierto_en, k.total_sistema::text, k.total_efectivo_contado::text,
            k.total_vouchers::text, k.diferencia::text, k.estado, e.nombre_completo as cerro
     from cierre_caja k join empleado_ref e on e.id_empleado = k.id_empleado
     order by k.id_cierre desc limit ${MAX_CIERRES}`,
  );
  return { cierres: r.rows };
}

export async function detalleCierre(db, idCierre) {
  const cabecera = await db.query(
    `select k.id_cierre, k.periodo_caja, k.turno, k.fecha, k.fecha_hora_cierre, k.abierto_en, k.total_sistema::text, k.total_efectivo_contado::text,
            k.total_vouchers::text, k.diferencia::text, k.estado, k.justificacion, e.nombre_completo as cerro
     from cierre_caja k join empleado_ref e on e.id_empleado = k.id_empleado where k.id_cierre = $1`,
    [idCierre],
  );
  if (cabecera.rowCount === 0) throw noEncontrado("El cierre no existe");
  const [metodos, empleados] = await Promise.all([
    db.query(
      `select m.id_metodo_pago, p.nombre as metodo, m.vendido::text, m.devuelto::text, m.total_calculado_sistema::text as calculado,
              m.total_reportado_empleado::text as reportado, m.diferencia::text
       from cierre_caja_metodo_pago m join metodo_pago_ref p on p.id_metodo_pago = m.id_metodo_pago
       where m.id_cierre = $1 order by m.id_metodo_pago`,
      [idCierre],
    ),
    db.query(
      `select c.id_empleado, e.nombre_completo as nombre, c.id_metodo_pago, c.vendido::text, c.devuelto::text
       from cierre_caja_empleado c join empleado_ref e on e.id_empleado = c.id_empleado
       where c.id_cierre = $1 order by e.nombre_completo, c.id_metodo_pago`,
      [idCierre],
    ),
  ]);
  const porEmpleado = new Map();
  for (const f of empleados.rows) {
    const e = porEmpleado.get(f.id_empleado) ?? { id_empleado: f.id_empleado, nombre: f.nombre, metodos: [] };
    e.metodos.push({ id_metodo_pago: f.id_metodo_pago, vendido: f.vendido, devuelto: f.devuelto });
    porEmpleado.set(f.id_empleado, e);
  }
  return {
    ...cabecera.rows[0],
    por_metodo: metodos.rows.map((m) => ({ ...m, etiqueta: etiquetaMetodo(m.metodo) })),
    por_empleado: [...porEmpleado.values()],
  };
}

export const idCierreDe = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw invalido("id_cierre no válido", { campo: "id_cierre" });
  return n;
};
