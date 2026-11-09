import crypto from "crypto";
import { local, runtime } from "./db.mjs";
import { conIdempotencia } from "./idempotencia.mjs";
import { ErrorNegocio, conflicto, invalido, noEncontrado } from "./errores.mjs";
import { registrarMovimiento } from "./inventario/movimientos.mjs";
import { encolarStockSnapshot } from "./inventario/stock.mjs";
import { traducirErrorReceta } from "./recetas.mjs";

// HU-08: registrar una venta y emitir la factura (RF-06, RNF-04, RNF-05, RNF-06, RNF-12, regla de negocio 1 y 2).
// Todo corre en la base de la tienda y funciona sin conexión con el central. La venta es UNA transacción:
// factura numerada + líneas + pagos + descuento de cada lote + movimiento de inventario + auditoría + eventos para el
// central. Si algo falla se revierte todo, incluido el número de factura. La base lo refuerza al hacer commit
// (trigger factura_completa en db/local/07_hu08_ventas.sql): no puede quedar una factura sin sus movimientos o sin
// pagos que sumen su total.
//
// Dinero: todo el cálculo es en centavos enteros (nunca flotantes), así el total es exactamente la suma de las líneas.
// Lotes: se asignan solos por FEFO (primero el que vence antes). Se bloquean en un orden fijo (id_lote), el mismo
// para todas las ventas, así dos ventas simultáneas no se bloquean entre sí y no pierden actualizaciones.

const MAX_LINEAS = 50;
const MAX_CANTIDAD = 1000;
const MAX_PAGOS = 4;
const MONTO_RE = /^\d{1,10}(\.\d{1,2})?$/;

const texto = (valor) => String(valor ?? "").trim();

// Los métodos de pago se guardan con un código ("tarjeta_debito"); aquí se muestran con su etiqueta.
const ETIQUETAS = { efectivo: "Efectivo", tarjeta_debito: "Tarjeta débito", tarjeta_credito: "Tarjeta crédito", transferencia: "Transferencia" };
export const etiquetaMetodo = (codigo) => ETIQUETAS[codigo] ?? String(codigo).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

// "1234.5" -> 123450 centavos. Rechaza más de dos decimales.
export function aCentavos(valor, campo) {
  const t = texto(valor).replace(",", ".");
  if (!MONTO_RE.test(t)) throw invalido("Importe no válido: máximo dos decimales", { campo });
  const [enteros, decimales = ""] = t.split(".");
  return Number(enteros) * 100 + Number(decimales.padEnd(2, "0"));
}

// HU-16: resumen por categoría para el central (vista de red filtrada por categoría). items: { id_categoria, cantidad,
// centavos }; un medicamento sin categoría va a la 0.
export function porCategoria(items) {
  const grupos = new Map();
  for (const i of items) {
    const id = i.id_categoria ?? 0;
    const g = grupos.get(id) ?? { id_categoria: id, unidades: 0, centavos: 0 };
    g.unidades += i.cantidad;
    g.centavos += i.centavos;
    grupos.set(id, g);
  }
  return [...grupos.values()].map((g) => ({ id_categoria: g.id_categoria, unidades: g.unidades, ingresos: aDecimal(g.centavos) }));
}

export const aDecimal = (centavos) => `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, "0")}`;

function entero(valor, campo, maximo = 2_000_000_000) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > maximo) throw invalido(`${campo} no válido`, { campo });
  return n;
}

function validarLineas(lineas) {
  if (!Array.isArray(lineas) || lineas.length === 0) throw invalido("La venta debe tener al menos un medicamento", { campo: "lineas" });
  if (lineas.length > MAX_LINEAS) throw invalido(`La venta admite máximo ${MAX_LINEAS} medicamentos`, { campo: "lineas" });
  const vistos = new Set();
  return lineas.map((l, i) => {
    const id = entero(l?.id_medicamento, `lineas[${i}].id_medicamento`);
    if (vistos.has(id)) throw invalido("Un medicamento aparece dos veces: sume sus cantidades", { campo: `lineas[${i}].id_medicamento` });
    vistos.add(id);
    const idReceta = l?.id_receta == null || l.id_receta === "" ? null : entero(l.id_receta, `lineas[${i}].id_receta`);
    return { id_medicamento: id, cantidad: entero(l?.cantidad, `lineas[${i}].cantidad`, MAX_CANTIDAD), id_receta: idReceta };
  });
}

// Calcula la venta: precio vigente en este instante, lotes por FEFO, impuesto por línea de lote y totales.
// bloquear = true (la venta) toma FOR UPDATE de los lotes candidatos; false (la vista previa) solo lee.
// Los problemas no lanzan: la vista previa los informa y la venta lanza el primero.
async function planear(db, lineas, { bloquear }) {
  const ids = lineas.map((l) => l.id_medicamento);
  const info = await db.query(
    `select m.id_medicamento, m.nombre_comercial, m.requiere_receta, m.activo, m.tasa_impuesto::text as tasa, m.id_categoria,
            precio_vigente(m.id_medicamento, now()::timestamp)::text as precio
     from medicamento_ref m where m.id_medicamento = any($1::int[])`,
    [ids],
  );
  const lotes = await db.query(
    `select id_lote, id_medicamento, numero_lote, cantidad_disponible, fecha_caducidad
     from lote
     where id_medicamento = any($1::int[]) and estado = 'DISPONIBLE' and fecha_caducidad >= current_date and cantidad_disponible > 0
     order by id_lote ${bloquear ? "for update" : ""}`,
    [ids],
  );
  const porMedicamento = new Map(info.rows.map((m) => [m.id_medicamento, m]));
  const lotesDe = new Map();
  for (const lote of lotes.rows) lotesDe.set(lote.id_medicamento, [...(lotesDe.get(lote.id_medicamento) ?? []), lote]);

  const problemas = [];
  const filas = [];
  const resumen = [];
  for (const linea of lineas) {
    const med = porMedicamento.get(linea.id_medicamento);
    if (!med || !med.activo) {
      problemas.push({ id_medicamento: linea.id_medicamento, codigo: "MEDICAMENTO_NO_VALIDO", mensaje: "El medicamento no existe o está inactivo" });
      continue;
    }
    if (med.precio == null) {
      problemas.push({ id_medicamento: med.id_medicamento, codigo: "SIN_PRECIO", mensaje: `${med.nombre_comercial} no tiene precio vigente` });
      continue;
    }
    // FEFO: primero el lote que caduca antes; a igual fecha, el más antiguo.
    const candidatos = [...(lotesDe.get(med.id_medicamento) ?? [])].sort(
      (a, b) => String(a.fecha_caducidad).localeCompare(String(b.fecha_caducidad)) || a.id_lote - b.id_lote,
    );
    const disponible = candidatos.reduce((suma, l) => suma + Number(l.cantidad_disponible), 0);
    if (disponible < linea.cantidad) {
      problemas.push({
        id_medicamento: med.id_medicamento,
        codigo: "STOCK_INSUFICIENTE",
        mensaje: `${med.nombre_comercial}: solo hay ${disponible} unidades vendibles`,
        disponible,
      });
    }
    const precio = aCentavos(med.precio, "precio");
    const tasa = Math.round(Number(med.tasa) * 100); // centésimas de punto porcentual
    let faltante = linea.cantidad;
    let subtotalLinea = 0;
    let impuestoLinea = 0;
    for (const lote of candidatos) {
      if (faltante === 0) break;
      const cantidad = Math.min(faltante, Number(lote.cantidad_disponible));
      faltante -= cantidad;
      const subtotal = precio * cantidad;
      const impuesto = Math.round((subtotal * tasa) / 10000);
      subtotalLinea += subtotal;
      impuestoLinea += impuesto;
      filas.push({
        id_lote: lote.id_lote,
        numero_lote: lote.numero_lote,
        id_medicamento: med.id_medicamento,
        id_categoria: med.id_categoria,
        cantidad,
        precio,
        tasa,
        subtotal,
        impuesto,
        id_receta: med.requiere_receta ? linea.id_receta : null,
      });
    }
    resumen.push({
      id_medicamento: med.id_medicamento,
      medicamento: med.nombre_comercial,
      cantidad: linea.cantidad,
      requiere_receta: med.requiere_receta,
      id_receta: med.requiere_receta ? linea.id_receta : null,
      precio_unitario: aDecimal(precio),
      tasa_impuesto: Number(med.tasa),
      subtotal: aDecimal(subtotalLinea),
      impuesto: aDecimal(impuestoLinea),
      stock_suficiente: disponible >= linea.cantidad,
    });
  }
  const subtotal = filas.reduce((s, f) => s + f.subtotal, 0);
  const impuestos = filas.reduce((s, f) => s + f.impuesto, 0);
  return { filas, resumen, problemas, subtotal, impuestos, total: subtotal + impuestos };
}

// Vista previa: mismo cálculo que la venta (por eso coincide con la factura), sin escribir ni bloquear.
export async function calcularVenta(body) {
  const lineas = validarLineas(body?.lineas);
  const plan = await planear(local, lineas, { bloquear: false });
  return {
    status: 200,
    body: {
      lineas: plan.resumen,
      subtotal: aDecimal(plan.subtotal),
      impuestos: aDecimal(plan.impuestos),
      total: aDecimal(plan.total),
      problemas: plan.problemas,
      puede_vender: plan.problemas.length === 0,
    },
  };
}

export async function metodosDePago() {
  const filas = await local.query("select id_metodo_pago, nombre from metodo_pago_ref where activo order by id_metodo_pago");
  return { metodos: filas.rows.map((m) => ({ ...m, etiqueta: etiquetaMetodo(m.nombre) })) };
}

// Factura completa, en una sola consulta (con la base remota cada ida y vuelta cuesta ~130 ms).
export async function facturaDe(db, idFactura) {
  const r = await db.query(
    `select f.id_factura, f.numero_factura, f.fecha_hora, f.subtotal::text, f.impuestos::text, f.total::text, f.estado,
            e.nombre_completo as cajero, c.nombre as cliente,
            (select coalesce(jsonb_agg(jsonb_build_object(
                      'id_lote', l.id_lote, 'id_medicamento', m.id_medicamento, 'medicamento', m.nombre_comercial, 'lote', l.numero_lote,
                      'cantidad', d.cantidad, 'precio_unitario', d.precio_unitario_aplicado::text,
                      'tasa_impuesto', d.tasa_impuesto::text, 'subtotal', d.subtotal_linea::text,
                      'impuesto', d.impuesto_linea::text, 'id_receta', d.id_receta, 'codigo_receta', rc.codigo_receta
                    ) order by m.nombre_comercial, l.id_lote), '[]'::jsonb)
             from detalle_factura d
             join lote l on l.id_lote = d.id_lote
             join medicamento_ref m on m.id_medicamento = l.id_medicamento
             left join receta rc on rc.id_receta = d.id_receta
             where d.id_factura = f.id_factura) as lineas,
            (select coalesce(jsonb_agg(jsonb_build_object(
                      'id_metodo_pago', p.id_metodo_pago, 'metodo', mp.nombre, 'monto', p.monto::text
                    ) order by p.id_metodo_pago), '[]'::jsonb)
             from factura_metodo_pago p join metodo_pago_ref mp on mp.id_metodo_pago = p.id_metodo_pago
             where p.id_factura = f.id_factura) as pagos
     from factura f
     left join empleado_ref e on e.id_empleado = f.id_empleado
     left join cliente c on c.id_cliente = f.id_cliente
     where f.id_factura = $1`,
    [idFactura],
  );
  if (r.rowCount === 0) throw noEncontrado("La factura no existe");
  const factura = r.rows[0];
  return { ...factura, pagos: factura.pagos.map((p) => ({ ...p, metodo: etiquetaMetodo(p.metodo) })) };
}

function validarPagos(pagos) {
  if (!Array.isArray(pagos) || pagos.length === 0) throw invalido("Indique al menos un método de pago", { campo: "pagos" });
  if (pagos.length > MAX_PAGOS) throw invalido(`Máximo ${MAX_PAGOS} métodos de pago por factura`, { campo: "pagos" });
  const vistos = new Set();
  return pagos.map((p, i) => {
    const id = entero(p?.id_metodo_pago, `pagos[${i}].id_metodo_pago`);
    if (vistos.has(id)) throw invalido("Un método de pago aparece dos veces: sume sus montos", { campo: `pagos[${i}].id_metodo_pago` });
    vistos.add(id);
    const centavos = aCentavos(p?.monto, `pagos[${i}].monto`);
    if (centavos <= 0) throw invalido("Cada monto debe ser mayor que cero", { campo: `pagos[${i}].monto` });
    return { id_metodo_pago: id, centavos };
  });
}

export async function registrarVenta(sesion, key, body) {
  const lineas = validarLineas(body?.lineas);
  const pagos = validarPagos(body?.pagos);
  const idTienda = runtime.tiendaId;

  return conIdempotencia(local, { key, operacion: "VENTA_REGISTRAR", idEmpleado: sesion.id_empleado, body }, async (client) => {
    // 0. HU-11: con la caja cerrada no se vende. FOR SHARE: el cierre (FOR UPDATE) espera a las ventas en curso y, una vez
    //    cerrada la caja, esta consulta ya la ve cerrada. Es lo primero que hace la venta, antes de bloquear lotes. El trigger
    //    factura_periodo_caja de la base lo garantiza para cualquier otro camino.
    const caja = await client.query("select abierta from caja_control where id = 1 for share");
    if (!caja.rows[0]?.abierta) {
      throw new ErrorNegocio(409, "CAJA_CERRADA", "La caja está cerrada: un administrador debe abrir un nuevo periodo para registrar ventas");
    }

    // 1. Cálculo con los lotes bloqueados: de aquí hasta el commit nadie más puede descontarlos.
    const plan = await planear(client, lineas, { bloquear: true });
    if (plan.problemas.length > 0) {
      const p = plan.problemas[0];
      throw new ErrorNegocio(p.codigo === "STOCK_INSUFICIENTE" ? 409 : 400, p.codigo, p.mensaje, {
        id_medicamento: p.id_medicamento,
        ...(p.disponible != null ? { disponible: p.disponible } : {}),
        problemas: plan.problemas,
      });
    }

    // 2. Pagos: métodos activos y suma exacta al total.
    const metodos = await client.query("select id_metodo_pago from metodo_pago_ref where activo and id_metodo_pago = any($1::int[])", [
      pagos.map((p) => p.id_metodo_pago),
    ]);
    if (metodos.rowCount !== pagos.length) throw invalido("Algún método de pago no existe o está inactivo", { campo: "pagos" });
    const pagado = pagos.reduce((s, p) => s + p.centavos, 0);
    if (pagado !== plan.total) {
      throw new ErrorNegocio(400, "PAGO_NO_CUADRA", `Los pagos (${aDecimal(pagado)}) deben sumar exactamente el total (${aDecimal(plan.total)})`, {
        total: aDecimal(plan.total),
        pagado: aDecimal(pagado),
      });
    }

    // 3. El paciente de la factura es el de la receta (HU-12): todas las recetas deben ser del mismo.
    const idsReceta = [...new Set(plan.filas.map((f) => f.id_receta).filter((id) => id != null))];
    let idCliente = null;
    if (idsReceta.length > 0) {
      const clientes = await client.query("select distinct id_cliente from receta where id_receta = any($1::int[])", [idsReceta]);
      if (clientes.rowCount > 1) throw conflicto("RECETA_CLIENTE", "Las recetas de la venta son de pacientes distintos");
      idCliente = clientes.rows[0]?.id_cliente ?? null;
    }

    // 4. Factura numerada. Desde aquí se sostiene el bloqueo del contador hasta el commit.
    const factura = await client.query(
      `insert into factura (numero_factura, id_cliente, id_empleado, subtotal, impuestos, total)
       values (siguiente_numero_factura($1), $2, $3, $4::numeric, $5::numeric, $6::numeric)
       returning id_factura, numero_factura, fecha_hora`,
      [idTienda, idCliente, sesion.id_empleado, aDecimal(plan.subtotal), aDecimal(plan.impuestos), aDecimal(plan.total)],
    );
    const { id_factura: idFactura, numero_factura: numero, fecha_hora: fecha } = factura.rows[0];

    // 5. Líneas, pagos, auditoría y evento para el central, en una sola sentencia. Las líneas pasan por los triggers de
    //    receta de HU-12 (un controlado sin receta válida se rechaza aquí) y se traducen a un error de negocio.
    const f = plan.filas;
    const detalleAuditoria = `${numero}; total ${aDecimal(plan.total)}; ${f.length} línea(s); pagos ${pagos.length}`;
    const evento = {
      id_factura: idFactura,
      numero_factura: numero,
      fecha: fecha.toISOString().slice(0, 10),
      total: aDecimal(plan.total),
      pagos: pagos.map((p) => ({ id_metodo_pago: p.id_metodo_pago, monto: aDecimal(p.centavos) })),
      categorias: porCategoria(f.map((x) => ({ id_categoria: x.id_categoria, cantidad: x.cantidad, centavos: x.subtotal + x.impuesto }))),
    };
    try {
      await client.query(
        `with d as (
           insert into detalle_factura (id_factura, id_lote, id_receta, cantidad, precio_unitario_aplicado, subtotal_linea, tasa_impuesto, impuesto_linea)
           select $1, x.id_lote, x.id_receta, x.cantidad, x.precio, x.subtotal, x.tasa, x.impuesto
           from unnest($2::int[], $3::int[], $4::int[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[])
             as x(id_lote, id_receta, cantidad, precio, subtotal, tasa, impuesto)
           returning 1
         ), p as (
           insert into factura_metodo_pago (id_factura, id_metodo_pago, monto)
           select $1, y.id_metodo_pago, y.monto from unnest($9::int[], $10::numeric[]) as y(id_metodo_pago, monto)
           returning 1
         ), a as (
           insert into registro_actividad (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
           values ($11, 'VENTA_REGISTRAR', 'factura', $1, $12) returning 1
         ), o as (
           insert into outbox_sync (id_empleado, idempotency_key, tipo_evento, payload)
           values (null, $13, 'VENTA_REGISTRADA', $14::jsonb) returning 1
         )
         select (select count(*) from d) as lineas`,
        [
          idFactura,
          f.map((x) => x.id_lote),
          f.map((x) => x.id_receta),
          f.map((x) => x.cantidad),
          f.map((x) => aDecimal(x.precio)),
          f.map((x) => aDecimal(x.subtotal)),
          f.map((x) => (x.tasa / 100).toFixed(2)),
          f.map((x) => aDecimal(x.impuesto)),
          pagos.map((p) => p.id_metodo_pago),
          pagos.map((p) => aDecimal(p.centavos)),
          sesion.id_empleado,
          detalleAuditoria.slice(0, 400),
          crypto.randomUUID(),
          JSON.stringify(evento),
        ],
      );
    } catch (error) {
      throw traducirErrorReceta(error);
    }

    // 6. Descuento de cada lote por el único camino de inventario (RF-04): bloquea, valida y deja el movimiento.
    //    El stock se publica al central una sola vez, al final.
    for (const x of f) {
      await registrarMovimiento(client, {
        idLote: x.id_lote,
        tipo: "VENTA",
        cantidad: x.cantidad,
        idEmpleado: sesion.id_empleado,
        idTienda,
        referencia: numero,
        publicarStock: false,
      });
    }
    await encolarStockSnapshot(client, { idTienda, idsMedicamento: [...new Set(f.map((x) => x.id_medicamento))] });

    return { status: 201, body: await facturaDe(client, idFactura) };
  });
}
