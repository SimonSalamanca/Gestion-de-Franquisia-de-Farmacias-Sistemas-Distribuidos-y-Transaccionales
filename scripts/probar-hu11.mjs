// Pruebas de HU-11 por las rutas reales de app.mjs: totales del periodo por método de pago y por empleado, conteo contra lo
// calculado, cierre bloqueado con diferencia sin justificar, cierre inmutable y auditado, caja cerrada que rechaza ventas
// hasta abrir un nuevo periodo, y la carrera entre ventas en curso y el cierre. También sin conexión con el central.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido y UNA sola corrida a la vez: cierra la caja de la tienda varias veces (cada cierre es permanente)
// y al final la deja ABIERTA, con un periodo nuevo.
import crypto from "crypto";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica, flushOutbox } = await import("../apps/api/sync.mjs");
const { crearServidor } = await import("../apps/api/app.mjs");

const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}

await migrate();
link.estado = "online";
link.openedUntil = 0;
await pullReplica();

const server = crearServidor();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function pedir(ruta, { method = "GET", token, key, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers["Idempotency-Key"] = key;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(base + ruta, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { status: r.status, data };
}
const entrar = async (nodo, usuario) =>
  (await pedir(`/api/${nodo}/auth/login`, { method: "POST", key: crypto.randomUUID(), body: { usuario, password: "Farma123" } })).data.token;
const nuevaKey = () => crypto.randomUUID();
const contar = async (pool, sql, valores = []) => Number((await pool.query(sql, valores)).rows[0].n);
const S = Date.now().toString(36).toUpperCase();

const proveedor = (await local.query("select id_proveedor from proveedor_ref where activo order by id_proveedor limit 1")).rows[0]?.id_proveedor;
if (!proveedor) {
  console.error("Falta un proveedor en la tienda (SEED_DEMO=1)");
  process.exit(2);
}
// Un medicamento de la corrida: 1000 pesos sin impuesto, para que los totales sean exactos.
const creado = await central.query(
  `with m as (insert into medicamento (codigo_interno, nombre_comercial, principio_activo, requiere_receta, tasa_impuesto) values ($1, $2, 'prueba de cierre de caja', false, 0) returning id_medicamento),
        u as (insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad) select t.id_tienda, m.id_medicamento, 0, 30 from tienda t cross join m where t.activa returning 1)
   select id_medicamento from m`,
  [`HU11-${S}`, `Prueba Cierre ${S}`],
);
const idMed = creado.rows[0].id_medicamento;
await central.query("insert into precio_medicamento (id_medicamento, precio, fecha_inicio_vigencia) values ($1, 1000, now()::timestamp - interval '1 hour')", [idMed]);
await migrate();
await pullReplica();
const idLote = (await local.query(
  `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
   values ($1, $2, $3, current_date + 200, 500, 500, 'DISPONIBLE') returning id_lote`,
  [idMed, proveedor, `L11-${S}`],
)).rows[0].id_lote;

let adminId;
try {
  const cajero = await entrar("local", "cajero1");
  const admin = await entrar("local", "admin.tienda");
  check("logins demo", Boolean(cajero && admin));
  adminId = (await local.query("select id_empleado from empleado_ref where usuario = 'admin.tienda'")).rows[0].id_empleado;
  const cajeroId = (await local.query("select id_empleado from empleado_ref where usuario = 'cajero1'")).rows[0].id_empleado;
  const metodos = (await pedir("/api/local/ventas/metodos-pago", { token: cajero })).data.metodos;
  const idMetodo = (n) => metodos.find((m) => m.nombre === n).id_metodo_pago;
  const [efectivo, debito, credito] = [idMetodo("efectivo"), idMetodo("tarjeta_debito"), idMetodo("tarjeta_credito")];
  const venta = (token, cantidad, pagos, key = nuevaKey()) =>
    pedir("/api/local/ventas", { method: "POST", token, key, body: { lineas: [{ id_medicamento: idMed, cantidad }], pagos } });
  const estado = async () => (await pedir("/api/local/caja/estado", { token: admin })).data;
  const cerrar = (body, { token = admin, key = nuevaKey() } = {}) => pedir("/api/local/caja/cierre", { method: "POST", token, key, body });
  const abrir = (body = {}, { token = admin, key = nuevaKey() } = {}) => pedir("/api/local/caja/apertura", { method: "POST", token, key, body });
  const resumen = async () => (await pedir("/api/local/caja/resumen", { token: admin })).data;
  const fila = (r, id) => r.resumen.por_metodo.find((m) => m.id_metodo_pago === id);
  const contadoDe = (r, extra = {}) =>
    r.resumen.por_metodo
      .filter((m) => Number(m.vendido) !== 0 || Number(m.devuelto) !== 0 || extra[m.id_metodo_pago] != null)
      .map((m) => ({ id_metodo_pago: m.id_metodo_pago, monto: extra[m.id_metodo_pago] ?? String(Math.max(Number(m.calculado), 0).toFixed(2)) }));

  // --- Permisos
  check("sin sesión 401", (await pedir("/api/local/caja/resumen")).status === 401);
  const negadosAntes = await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and detalle = 'CAJA_CERRAR'");
  check("el cajero no ve el resumen de cierre 403", (await pedir("/api/local/caja/resumen", { token: cajero })).status === 403);
  check("el cajero no cierra la caja 403", (await cerrar({ contado: [{ id_metodo_pago: efectivo, monto: "0" }] }, { token: cajero })).status === 403);
  check("el cajero no abre la caja 403", (await abrir({}, { token: cajero })).status === 403);
  check("el cajero no ve los cierres 403", (await pedir("/api/local/caja/cierres", { token: cajero })).status === 403);
  check("403 auditado en la tienda", (await contar(local, "select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and detalle = 'CAJA_CERRAR'")) === negadosAntes + 4);
  const estadoCajero = await pedir("/api/local/caja/estado", { token: cajero });
  check("el cajero sí ve si la caja está abierta", estadoCajero.status === 200 && typeof estadoCajero.data.abierta === "boolean");
  check("el módulo está en el catálogo para el administrador", (await pedir("/api/modulos")).data.CAJA_CERRAR?.titulo === "Cierre de caja");

  // --- Línea base: se cierra el periodo en curso (con lo que dejaron otras pruebas) y se abre uno limpio para esta
  if (!(await estado()).abierta) await abrir();
  const previo = await resumen();
  const baseline = await cerrar({ contado: contadoDe(previo), justificacion: "Cierre de línea base de la prueba HU-11", turno: "Base" });
  check("línea base: el periodo en curso se cierra", baseline.status === 201, `${baseline.status} ${baseline.data.mensaje || ""}`);
  check("con la caja cerrada se ve el estado y no hay resumen", (await estado()).abierta === false && (await resumen()).resumen === null);
  const aperturaBase = await abrir({ turno: "HU-11" });
  check("abrir un nuevo periodo 201", aperturaBase.status === 201 && aperturaBase.data.abierta === true, `${aperturaBase.status}`);
  const P = aperturaBase.data.periodo;
  check("abrir con la caja abierta 409 CAJA_YA_ABIERTA", (await abrir()).data.codigo === "CAJA_YA_ABIERTA");

  // --- Ventas del periodo: V1 efectivo, V2 débito (se anulará), V3 efectivo + crédito (admin)
  const v1 = await venta(cajero, 2, [{ id_metodo_pago: efectivo, monto: "2000.00" }]);
  const v2 = await venta(cajero, 1, [{ id_metodo_pago: debito, monto: "1000.00" }]);
  const v3 = await venta(admin, 3, [{ id_metodo_pago: efectivo, monto: "1000.00" }, { id_metodo_pago: credito, monto: "2000.00" }]);
  check("tres ventas del periodo", [v1, v2, v3].every((v) => v.status === 201), [v1, v2, v3].map((v) => v.status).join(","));
  const anulada = await pedir(`/api/local/facturas/${v2.data.id_factura}/anular`, { method: "POST", token: admin, key: nuevaKey(), body: { motivo: "prueba de cierre de caja" } });
  check("una venta se anula (reintegro en débito, hecho por el administrador)", anulada.status === 201, `${anulada.status} ${anulada.data.mensaje || ""}`);
  check("las ventas quedan en el periodo abierto", (await contar(local, "select count(*) as n from factura where periodo_caja = $1 and id_factura = any($2::int[])", [P, [v1, v2, v3].map((v) => v.data.id_factura)])) === 3);

  // --- Criterio 1: totales por método de pago y por empleado
  const r1 = await resumen();
  check("el resumen es del periodo abierto y cuenta facturas y notas", r1.abierta === true && r1.periodo === P && r1.resumen.facturas === 3 && r1.resumen.notas === 1);
  check("efectivo: vendido 3000, devuelto 0, calculado 3000", fila(r1, efectivo).vendido === "3000.00" && fila(r1, efectivo).devuelto === "0.00" && fila(r1, efectivo).calculado === "3000.00");
  check("débito: vendido 1000, devuelto 1000, calculado 0 (la anulación resta)", fila(r1, debito).vendido === "1000.00" && fila(r1, debito).devuelto === "1000.00" && fila(r1, debito).calculado === "0.00");
  check("crédito: calculado 2000", fila(r1, credito).calculado === "2000.00");
  check("total del sistema 5000", r1.resumen.total_sistema === "5000.00");
  const ana = r1.resumen.por_empleado.find((e) => e.id_empleado === cajeroId);
  const luis = r1.resumen.por_empleado.find((e) => e.id_empleado === adminId);
  check("por empleado: la cajera vendió 3000 (efectivo 2000, débito 1000)", ana?.vendido === "3000.00" && ana.devuelto === "0.00" && ana.neto === "3000.00");
  check("por empleado: el administrador vendió 3000 y devolvió 1000 (neto 2000)", luis?.vendido === "3000.00" && luis.devuelto === "1000.00" && luis.neto === "2000.00");
  check("por empleado y método: el administrador cobró 2000 en crédito", luis?.metodos.find((m) => m.id_metodo_pago === credito)?.vendido === "2000.00");
  check(
    "los totales por método y por empleado coinciden entre sí",
    r1.resumen.por_empleado.reduce((s, e) => s + Math.round(Number(e.neto) * 100), 0) === Math.round(Number(r1.resumen.total_sistema) * 100),
  );
  check("el resumen trae una firma para detectar cambios", typeof r1.resumen.firma === "string" && r1.resumen.firma.length > 8);

  // --- Criterio 2: lo contado se registra para compararlo
  check("sin Idempotency-Key 400", (await pedir("/api/local/caja/cierre", { method: "POST", token: admin, body: { contado: contadoDe(r1) } })).status === 400);
  check("sin lo contado 400", (await cerrar({})).status === 400 && (await cerrar({ contado: [] })).status === 400);
  for (const malo of ["-5", "10.123", "abc", ""]) {
    check(`monto contado inválido (${JSON.stringify(malo)}) 400`, (await cerrar({ contado: [{ id_metodo_pago: efectivo, monto: malo }] })).status === 400);
  }
  check("método repetido 400", (await cerrar({ contado: [{ id_metodo_pago: efectivo, monto: "1" }, { id_metodo_pago: efectivo, monto: "2" }] })).status === 400);
  check("método inexistente 400", (await cerrar({ contado: [{ id_metodo_pago: 99999, monto: "1" }] })).status === 400);
  const incompleto = await cerrar({ contado: [{ id_metodo_pago: efectivo, monto: "3000" }, { id_metodo_pago: debito, monto: "0" }] });
  check("no se puede dejar sin contar un método con movimiento 400 CONTEO_INCOMPLETO", incompleto.status === 400 && incompleto.data.codigo === "CONTEO_INCOMPLETO" && incompleto.data.faltan?.[0]?.id_metodo_pago === credito);

  // --- Criterio 3: no se cierra con diferencia sin justificar
  const cierresAntes = await contar(local, "select count(*) as n from cierre_caja");
  const faltante = [{ id_metodo_pago: efectivo, monto: "2900" }, { id_metodo_pago: debito, monto: "0" }, { id_metodo_pago: credito, monto: "2000" }];
  const sinJustificar = await cerrar({ contado: faltante });
  check("faltante sin justificación 409 CIERRE_CON_DIFERENCIA", sinJustificar.status === 409 && sinJustificar.data.codigo === "CIERRE_CON_DIFERENCIA");
  check("la respuesta dice qué método no cuadra y por cuánto", sinJustificar.data.diferencias?.length === 1 && sinJustificar.data.diferencias[0].id_metodo_pago === efectivo && sinJustificar.data.diferencias[0].diferencia === "-100.00");
  check("justificación demasiado corta 409", (await cerrar({ contado: faltante, justificacion: "corto" })).status === 409);
  const compensado = await cerrar({ contado: [{ id_metodo_pago: efectivo, monto: "3100" }, { id_metodo_pago: debito, monto: "0" }, { id_metodo_pago: credito, monto: "1900" }] });
  check("un sobrante en efectivo no tapa un faltante en tarjeta (cada método por separado) 409", compensado.status === 409 && compensado.data.diferencias?.length === 2);
  check("nada se guardó y la caja sigue abierta", (await contar(local, "select count(*) as n from cierre_caja")) === cierresAntes && (await estado()).abierta === true);

  // --- Firma: hubo una venta después de calcular el resumen
  const firmaVieja = r1.resumen.firma;
  const v4 = await venta(cajero, 1, [{ id_metodo_pago: efectivo, monto: "1000.00" }]);
  check("una venta nueva mientras se cuenta", v4.status === 201);
  const desactualizado = await cerrar({ contado: contadoDe(r1), firma: firmaVieja });
  check("cerrar con un resumen viejo 409 RESUMEN_DESACTUALIZADO", desactualizado.status === 409 && desactualizado.data.codigo === "RESUMEN_DESACTUALIZADO" && desactualizado.data.resumen?.total_sistema === "6000.00");
  const r2 = await resumen();
  check("el resumen nuevo incluye la venta (6000)", r2.resumen.total_sistema === "6000.00" && fila(r2, efectivo).calculado === "4000.00");

  // --- Cierre con diferencia justificada (efectivo 3900 de 4000)
  const keyCierre = nuevaKey();
  const cuerpo = {
    contado: [{ id_metodo_pago: efectivo, monto: "3900" }, { id_metodo_pago: debito, monto: "0" }, { id_metodo_pago: credito, monto: "2000" }],
    justificacion: "Faltan 100 pesos: cambio mal entregado al cliente de las 10 am",
    turno: "Prueba",
    firma: r2.resumen.firma,
  };
  const cierre = await cerrar(cuerpo, { key: keyCierre });
  check("cierre con diferencia justificada 201", cierre.status === 201 && cierre.data.estado === "CON_DIFERENCIA", `${cierre.status} ${cierre.data.mensaje || ""} ${cierre.data.codigo || ""}`);
  const c = cierre.data;
  check("total del sistema, efectivo contado, vouchers y diferencia", c.total_sistema === "6000.00" && c.total_efectivo_contado === "3900.00" && c.total_vouchers === "2000.00" && c.diferencia === "-100.00", JSON.stringify([c.total_sistema, c.total_efectivo_contado, c.total_vouchers, c.diferencia]));
  check("queda su justificación, quién cerró y el periodo", c.justificacion?.startsWith("Faltan 100") && c.cerro === "Luis Mora" && c.periodo_caja === P);
  const efC = c.por_metodo.find((m) => m.id_metodo_pago === efectivo);
  check("por método: calculado, contado y diferencia", efC.calculado === "4000.00" && efC.reportado === "3900.00" && efC.diferencia === "-100.00" && efC.vendido === "4000.00");
  check("por empleado: el cierre guarda lo de cada uno", c.por_empleado.length === 2 && c.por_empleado.find((e) => e.id_empleado === cajeroId)?.metodos.some((m) => m.id_metodo_pago === efectivo && m.vendido === "3000.00"));
  check("la caja queda cerrada", (await estado()).abierta === false);
  const cierreRepetido = await cerrar(cuerpo, { key: keyCierre });
  check("reintento con la misma clave: el mismo cierre", cierreRepetido.status === 201 && cierreRepetido.data.id_cierre === c.id_cierre);
  check("cerrar otra vez con otra clave 409 CAJA_YA_CERRADA", (await cerrar(cuerpo)).data.codigo === "CAJA_YA_CERRADA");
  check("un solo cierre por periodo", (await contar(local, "select count(*) as n from cierre_caja where periodo_caja = $1", [P])) === 1);

  // --- Criterio 4: auditable e inmutable
  const aud = (await local.query("select id_empleado, fecha_hora, detalle from registro_actividad where accion = 'CAJA_CERRAR' and id_entidad_afectada = $1", [c.id_cierre])).rows;
  check("auditoría: CAJA_CERRAR con responsable, fecha y justificación", aud.length === 1 && aud[0].id_empleado === adminId && aud[0].detalle.includes("CON_DIFERENCIA") && aud[0].detalle.includes("Faltan 100") && Math.abs(Date.now() - new Date(aud[0].fecha_hora).getTime()) < 300000, JSON.stringify(aud));
  check("auditoría de la apertura", (await contar(local, "select count(*) as n from registro_actividad where accion = 'CAJA_ABRIR' and id_empleado = $1 and id_entidad_afectada = $2", [adminId, P])) === 1);
  let bloqueos = 0;
  for (const [sql, valor] of [
    ["update cierre_caja set total_sistema = 1 where id_cierre = $1", c.id_cierre],
    ["delete from cierre_caja where id_cierre = $1", c.id_cierre],
    ["update cierre_caja_metodo_pago set total_reportado_empleado = 0 where id_cierre = $1", c.id_cierre],
    ["delete from cierre_caja_metodo_pago where id_cierre = $1", c.id_cierre],
    ["update cierre_caja_empleado set vendido = 0 where id_cierre = $1", c.id_cierre],
    ["delete from cierre_caja_empleado where id_cierre = $1", c.id_cierre],
    ["update apertura_caja set turno = 'x' where periodo_caja = $1", P],
    ["delete from apertura_caja where periodo_caja = $1", P],
  ]) {
    try {
      await local.query(sql, [valor]);
    } catch (error) {
      if (error.code === "42501") bloqueos += 1;
    }
  }
  check("en la base, el cierre y sus detalles no se editan ni se borran", bloqueos === 8, `${bloqueos}/8`);
  let sinJustifBase = false;
  try {
    await local.query(
      `insert into cierre_caja (id_empleado, fecha, total_sistema, total_efectivo_contado, total_vouchers, diferencia, estado, periodo_caja)
       values ($1, current_date, 0, 0, 0, 0, 'CON_DIFERENCIA', 987654)`,
      [adminId],
    );
  } catch (error) {
    sinJustifBase = error.code === "23514";
  }
  check("la base rechaza un cierre con diferencia sin justificación", sinJustifBase);
  let incoherenteBase = false;
  const cliente = await local.connect();
  try {
    await cliente.query("begin");
    await cliente.query(
      `insert into cierre_caja (id_empleado, fecha, total_sistema, total_efectivo_contado, total_vouchers, diferencia, estado, periodo_caja)
       values ($1, current_date, 100, 0, 0, 0, 'CONCILIADO', 987655)`,
      [adminId],
    );
    await cliente.query("commit");
  } catch (error) {
    incoherenteBase = error.code === "23514";
    await cliente.query("rollback").catch(() => {});
  } finally {
    cliente.release();
  }
  check("la base rechaza al hacer commit un cierre cuyos métodos no suman su total", incoherenteBase);
  let periodoRepetido = false;
  try {
    await local.query(
      `insert into cierre_caja (id_empleado, fecha, total_sistema, total_efectivo_contado, total_vouchers, diferencia, estado, periodo_caja)
       values ($1, current_date, 0, 0, 0, 0, 'CONCILIADO', $2)`,
      [adminId, P],
    );
  } catch (error) {
    periodoRepetido = error.code === "23505";
  }
  check("la base no admite dos cierres del mismo periodo", periodoRepetido);

  // --- Criterio 5: con la caja cerrada no se registran ventas
  const facturasAntes = await contar(local, "select count(*) as n from factura");
  const stockAntes = await contar(local, "select cantidad_disponible as n from lote where id_lote = $1", [idLote]);
  const rechazada = await venta(cajero, 1, [{ id_metodo_pago: efectivo, monto: "1000.00" }]);
  check("vender con la caja cerrada 409 CAJA_CERRADA", rechazada.status === 409 && rechazada.data.codigo === "CAJA_CERRADA", `${rechazada.status} ${rechazada.data.codigo}`);
  check("el administrador tampoco puede vender con la caja cerrada", (await venta(admin, 1, [{ id_metodo_pago: efectivo, monto: "1000.00" }])).data.codigo === "CAJA_CERRADA");
  check("sin factura ni descuento de stock", (await contar(local, "select count(*) as n from factura")) === facturasAntes && (await contar(local, "select cantidad_disponible as n from lote where id_lote = $1", [idLote])) === stockAntes);
  let triggerCaja = null;
  try {
    await local.query("insert into factura (numero_factura, id_empleado, subtotal, impuestos, total) values ($1, $2, 1, 0, 1)", [`HU11-${S}`, adminId]);
  } catch (error) {
    triggerCaja = error;
  }
  check("la base rechaza una factura con la caja cerrada (cualquier camino)", triggerCaja?.code === "23514" && /CAJA_CERRADA/.test(triggerCaja.message));
  check("el estado que ve el cajero es cerrada", (await pedir("/api/local/caja/estado", { token: cajero })).data.abierta === false);

  // --- Una devolución con la caja cerrada se permite y cae en el periodo siguiente
  const devuelta = await pedir(`/api/local/facturas/${v1.data.id_factura}/devolver`, {
    method: "POST",
    token: admin,
    key: nuevaKey(),
    body: { motivo: "cliente devolvió una unidad", lineas: [{ id_lote: idLote, cantidad: 1 }] },
  });
  check("devolver con la caja cerrada 201", devuelta.status === 201, `${devuelta.status} ${devuelta.data.mensaje || ""}`);
  check("la nota cae en el periodo siguiente, no en el cerrado", (await contar(local, "select periodo_caja as n from anulacion_devolucion where id_anulacion = $1", [devuelta.data.nota.id_anulacion])) === P + 1);
  check("el periodo cerrado no cambia", (await detalleDe(c.id_cierre)).total_sistema === "6000.00");
  async function detalleDe(id) {
    return (await pedir(`/api/local/caja/cierres/${id}`, { token: admin })).data;
  }

  // --- Abrir un nuevo periodo: se vuelve a vender y la devolución cuenta ahí
  check("abrir lo hace solo el administrador", (await abrir({}, { token: cajero })).status === 403);
  const aper2 = await abrir({ turno: "Tarde" });
  check("nueva apertura 201 con el periodo siguiente", aper2.status === 201 && aper2.data.periodo === P + 1);
  const r3 = await resumen();
  check("el nuevo periodo arranca con la devolución (efectivo calculado −1000)", r3.resumen.notas === 1 && r3.resumen.facturas === 0 && fila(r3, efectivo).devuelto === "1000.00" && fila(r3, efectivo).calculado === "-1000.00");
  const v5 = await venta(cajero, 1, [{ id_metodo_pago: efectivo, monto: "1000.00" }]);
  check("con la caja abierta se vende otra vez 201", v5.status === 201, `${v5.status} ${v5.data.codigo || ""}`);
  check("la venta nueva es del periodo nuevo", (await contar(local, "select periodo_caja as n from factura where id_factura = $1", [v5.data.id_factura])) === P + 1);
  // Cierre sin diferencia: vendido 1000 − devuelto 1000 = 0 efectivo; se cuenta 0.
  const r4 = await resumen();
  const conciliado = await cerrar({ contado: [{ id_metodo_pago: efectivo, monto: "0" }], firma: r4.resumen.firma, justificacion: "No debería guardarse: no hay diferencia" });
  check("un cierre que cuadra queda CONCILIADO sin justificación", conciliado.status === 201 && conciliado.data.estado === "CONCILIADO" && conciliado.data.diferencia === "0.00" && conciliado.data.justificacion === null, `${conciliado.status} ${conciliado.data.mensaje || ""}`);
  const lista = await pedir("/api/local/caja/cierres", { token: admin });
  check("el historial lista los cierres, el último primero", lista.status === 200 && lista.data.cierres[0].id_cierre === conciliado.data.id_cierre && lista.data.cierres.some((k) => k.id_cierre === c.id_cierre && k.estado === "CON_DIFERENCIA"));
  check("cierre inexistente 404", (await pedir("/api/local/caja/cierres/99999999", { token: admin })).status === 404);
  const detalleViejo = await detalleDe(c.id_cierre);
  check("el detalle de un cierre anterior se consulta completo", detalleViejo.por_metodo.length >= 3 && detalleViejo.justificacion === cuerpo.justificacion);

  // --- Carrera: cinco ventas a la vez mientras se cierra la caja (cada una entra en el cierre o es rechazada, ninguna se pierde)
  await abrir({ turno: "Carrera" });
  const periodoCarrera = (await estado()).periodo;
  const resultados = await Promise.all([
    cerrar({ contado: [{ id_metodo_pago: efectivo, monto: "0" }], justificacion: "Prueba de concurrencia entre ventas y cierre" }),
    ...Array.from({ length: 5 }, () => venta(cajero, 1, [{ id_metodo_pago: efectivo, monto: "1000.00" }])),
  ]);
  const cierreCarrera = resultados[0];
  const ventasCarrera = resultados.slice(1);
  const aceptadas = ventasCarrera.filter((v) => v.status === 201);
  const rechazadas = ventasCarrera.filter((v) => v.status === 409 && v.data.codigo === "CAJA_CERRADA");
  check("la carrera: el cierre se completa", cierreCarrera.status === 201, `${cierreCarrera.status} ${cierreCarrera.data.mensaje || ""}`);
  check("cada venta se acepta o se rechaza por caja cerrada (ninguna falla de otro modo)", aceptadas.length + rechazadas.length === 5, ventasCarrera.map((v) => `${v.status}${v.data.codigo ? `:${v.data.codigo}` : ""}`).join(" "));
  const enCierre = cierreCarrera.data.por_metodo.find((m) => m.id_metodo_pago === efectivo);
  check(
    "el cierre incluye exactamente las ventas aceptadas (no se pierde ni sobra una)",
    enCierre.vendido === `${aceptadas.length * 1000}.00` && (await contar(local, "select count(*) as n from factura where periodo_caja = $1", [periodoCarrera])) === aceptadas.length,
    `aceptadas ${aceptadas.length}, cierre ${enCierre.vendido}`,
  );
  check(
    "ninguna factura es posterior al cierre",
    (await contar(local, "select count(*) as n from factura f where f.periodo_caja = $1 and f.fecha_hora > (select fecha_hora_cierre from cierre_caja where id_cierre = $2)", [periodoCarrera, cierreCarrera.data.id_cierre])) === 0,
  );

  // --- Sin conexión con el central: cerrar y abrir siguen funcionando (RNF-04)
  await abrir({ turno: "Sin red" });
  link.estado = "offline";
  const vOff = await venta(cajero, 1, [{ id_metodo_pago: efectivo, monto: "1000.00" }]);
  const rOff = await resumen();
  const cierreOff = await cerrar({ contado: [{ id_metodo_pago: efectivo, monto: "1000" }], firma: rOff.resumen.firma });
  const aperturaOff = await abrir({ turno: "Sin red 2" });
  link.estado = "online";
  check("sin central: se vende, se totaliza, se cierra y se abre", vOff.status === 201 && rOff.resumen.total_sistema === "1000.00" && cierreOff.status === 201 && cierreOff.data.estado === "CONCILIADO" && aperturaOff.status === 201, [vOff.status, cierreOff.status, aperturaOff.status].join(","));
} finally {
  link.estado = "online";
  // La caja de la tienda debe quedar ABIERTA, con un periodo nuevo, para que otras pruebas y la operación sigan.
  const caja = (await local.query("select periodo, abierta from caja_control where id = 1")).rows[0];
  if (!caja.abierta && adminId) {
    await local.query("update caja_control set periodo = periodo + 1, abierta = true, abierta_en = clock_timestamp()::timestamp where id = 1");
    await local.query("insert into apertura_caja (periodo_caja, id_empleado, turno) values ($1, $2, 'Fin de prueba')", [caja.periodo + 1, adminId]);
  }
  // Las ventas y devoluciones de la prueba esperan en el outbox: se envían al central para no dejar eventos pendientes que
  // otras pruebas (que miden el consolidado del central con sumas exactas) enviarían junto con los suyos.
  await flushOutbox(1).catch((error) => console.error("flushOutbox:", error.message));
  await central.query("update medicamento set activo = false where id_medicamento = $1", [idMed]);
  await local.query("update medicamento_ref set activo = false where id_medicamento = $1", [idMed]);
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}\n${fallos.join("\n")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
