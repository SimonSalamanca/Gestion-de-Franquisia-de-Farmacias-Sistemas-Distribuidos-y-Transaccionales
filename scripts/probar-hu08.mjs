// Pruebas de HU-08 por las rutas reales de app.mjs: cálculo exacto con impuestos por medicamento, pago combinado,
// factura consecutiva sin saltos, venta atómica (todo o nada), FEFO, concurrencia, receta de controlados (HU-12),
// venta sin conexión con el central y consolidado en el central.
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Cada corrida crea sus propios medicamentos y lotes; las facturas son inmutables y
// permanentes (los medicamentos de prueba quedan inactivos al final).
import crypto from "crypto";
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local, withTx } = await import("../apps/api/db.mjs");
const { migrate } = await import("../apps/api/migrate.mjs");
const { link, pullReplica, flushOutbox } = await import("../apps/api/sync.mjs");
const { crearServidor } = await import("../apps/api/app.mjs");
const { aplicarEnCentral } = await import("../apps/api/sync/central.mjs");

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
const TIENDA = 1;
const centavos = (texto) => Math.round(Number(texto) * 100);

// --- Medicamentos y lotes propios de esta corrida
const proveedor = (await local.query("select id_proveedor from proveedor_ref where activo order by id_proveedor limit 1")).rows[0]?.id_proveedor;
if (!proveedor) {
  console.error("Falta un proveedor en la tienda (SEED_DEMO=1)");
  process.exit(2);
}
async function crearMedicamento(sufijo, { precio, tasa = 0, receta = false }) {
  const r = await central.query(
    `insert into medicamento (codigo_interno, nombre_comercial, principio_activo, requiere_receta, tasa_impuesto)
     values ($1, $2, 'prueba de ventas', $3, $4) returning id_medicamento`,
    [`HU08-${S}-${sufijo}`, `Prueba Ventas ${S}-${sufijo}`, receta, tasa],
  );
  if (precio != null) {
    await central.query(
      "insert into precio_medicamento (id_medicamento, precio, fecha_inicio_vigencia) values ($1, $2, now()::timestamp - interval '1 hour')",
      [r.rows[0].id_medicamento, precio],
    );
  }
  return r.rows[0].id_medicamento;
}
const idA = await crearMedicamento("A", { precio: "1000.50", tasa: 19 }); // 3 x 1000.50 con 19 % = redondeo por línea
const idB = await crearMedicamento("B", { precio: "2500.00", tasa: 0 });
const idC = await crearMedicamento("C", { precio: "4000.00", tasa: 5, receta: true }); // controlado
const idD = await crearMedicamento("D", { precio: null }); // sin precio
const idE = await crearMedicamento("E", { precio: "100.00", tasa: 19 });
const idF = await crearMedicamento("F", { precio: "200.00", tasa: 5 });
await migrate();
await pullReplica();
check("los medicamentos de prueba llegaron a la tienda con su impuesto", (await local.query("select count(*)::int as n from medicamento_ref where id_medicamento = any($1::int[]) and tasa_impuesto in (0, 5, 19)", [[idA, idB, idC, idD, idE, idF]])).rows[0].n === 6);
check("la tasa de impuesto se replicó", (await local.query("select tasa_impuesto::text as t from medicamento_ref where id_medicamento = $1", [idA])).rows[0].t === "19.00");
check("los precios llegaron a la tienda", (await local.query("select precio_vigente($1)::text as p", [idA])).rows[0].p === "1000.50");

async function crearLote(idMed, sufijo, { cantidad, dias, estado = "DISPONIBLE" }) {
  return (await local.query(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, current_date + $4::int, $5, $5, $6) returning id_lote`,
    [idMed, proveedor, `L-${S}-${sufijo}`, dias, cantidad, estado],
  )).rows[0].id_lote;
}
const loteA1 = await crearLote(idA, "A1", { cantidad: 10, dias: 30 }); // vence antes: sale primero (FEFO)
const loteA2 = await crearLote(idA, "A2", { cantidad: 10, dias: 90 });
const loteAvencido = await crearLote(idA, "AV", { cantidad: 50, dias: -1 }); // vencido: no se vende
const loteAbloqueado = await crearLote(idA, "AB", { cantidad: 50, dias: 20, estado: "BLOQUEADO" });
const loteB = await crearLote(idB, "B1", { cantidad: 5, dias: 200 });
const loteC = await crearLote(idC, "C1", { cantidad: 20, dias: 200 });
const loteE = await crearLote(idE, "E1", { cantidad: 30, dias: 200 });
const loteF = await crearLote(idF, "F1", { cantidad: 30, dias: 200 });
const stock = async (idLote) => (await local.query("select cantidad_disponible::int as n from lote where id_lote = $1", [idLote])).rows[0].n;
const ultimoNumero = async () => Number((await local.query("select ultimo from secuencia_factura where id = 1")).rows[0].ultimo);
const facturas = () => contar(local, "select count(*) as n from factura");
const movimientosVenta = () => contar(local, "select count(*) as n from movimiento_inventario where tipo_movimiento = 'VENTA'");
const colaVentas = () => contar(local, "select count(*) as n from outbox_sync where tipo_evento = 'VENTA_REGISTRADA'");

try {
  const cajero = await entrar("local", "cajero1");
  const adminTienda = await entrar("local", "admin.tienda");
  const general = await entrar("central", "admin.general");
  check("logins demo", Boolean(cajero && adminTienda && general));

  // --- Acceso y métodos de pago
  check("sin sesión 401", (await pedir("/api/local/ventas/metodos-pago")).status === 401);
  check("sin sesión no se vende 401", (await pedir("/api/local/ventas", { method: "POST", key: nuevaKey(), body: {} })).status === 401);
  const metodosR = await pedir("/api/local/ventas/metodos-pago", { token: cajero });
  const nombres = (metodosR.data.metodos || []).map((m) => m.nombre);
  check("la tienda tiene los 4 métodos de pago replicados, sin duplicados", metodosR.data.metodos.length === 4 && ["efectivo", "tarjeta_debito", "tarjeta_credito", "transferencia"].every((n) => nombres.includes(n)), nombres.join(","));
  check("los métodos se muestran con su etiqueta", metodosR.data.metodos.find((m) => m.nombre === "tarjeta_debito")?.etiqueta === "Tarjeta débito");
  const metodo = (nombre) => metodosR.data.metodos.find((m) => m.nombre === nombre).id_metodo_pago;
  const [efectivo, debito, credito, transferencia] = ["efectivo", "tarjeta_debito", "tarjeta_credito", "transferencia"].map(metodo);
  check("los demo traen impuestos por medicamento", (await local.query("select count(*)::int as n from medicamento_ref where codigo_interno in ('MED-010', 'MED-011') and tasa_impuesto = 19")).rows[0].n === 2);

  // --- Vista previa: mismo cálculo, sin escribir
  const facturasAntes = await facturas();
  const stockA1Antes = await stock(loteA1);
  const calc = await pedir("/api/local/ventas/calcular", { method: "POST", token: cajero, body: { lineas: [{ id_medicamento: idA, cantidad: 3 }, { id_medicamento: idB, cantidad: 2 }] } });
  check("calcular 200 y puede vender", calc.status === 200 && calc.data.puede_vender === true);
  // A: 3 x 1000.50 = 3001.50; 19 % = 570.285 -> 570.29. B: 2 x 2500 = 5000.00 exento. Total 8571.79.
  check("subtotal a partir del precio vigente", calc.data.subtotal === "8001.50", calc.data.subtotal);
  check("impuesto por medicamento (19 % y exento) redondeado a centavos", calc.data.impuestos === "570.29", calc.data.impuestos);
  check("total = subtotal + impuestos", calc.data.total === "8571.79", calc.data.total);
  check("la vista previa no escribió nada", (await facturas()) === facturasAntes && (await stock(loteA1)) === stockA1Antes);
  const malo = await pedir("/api/local/ventas/calcular", { method: "POST", token: cajero, body: { lineas: [{ id_medicamento: idA, cantidad: 900 }, { id_medicamento: idD, cantidad: 1 }, { id_medicamento: 99999999, cantidad: 1 }] } });
  const codigos = (malo.data.problemas || []).map((p) => p.codigo).sort().join(",");
  check("calcular informa sin stock, sin precio y medicamento inválido", malo.data.puede_vender === false && codigos === "MEDICAMENTO_NO_VALIDO,SIN_PRECIO,STOCK_INSUFICIENTE", codigos);
  const lotesVendibles = await pedir("/api/local/ventas/calcular", { method: "POST", token: cajero, body: { lineas: [{ id_medicamento: idA, cantidad: 21 }] } });
  check("los lotes vencido y bloqueado no cuentan como stock (20 vendibles de 120)", lotesVendibles.data.problemas?.[0]?.disponible === 20);

  // --- Validaciones de la venta (nada se escribe)
  const venta = (cuerpo, opciones = {}) => pedir("/api/local/ventas", { method: "POST", token: cajero, key: nuevaKey(), body: cuerpo, ...opciones });
  const lineasOk = [{ id_medicamento: idA, cantidad: 3 }, { id_medicamento: idB, cantidad: 2 }];
  const pagosOk = [{ id_metodo_pago: efectivo, monto: "3000.00" }, { id_metodo_pago: debito, monto: "3000.00" }, { id_metodo_pago: transferencia, monto: "2571.79" }];
  const numeroAntes = await ultimoNumero();
  const colaAntes = await colaVentas();
  const movAntes = await movimientosVenta();
  const mala = async (cuerpo, nombre, status = 400) => {
    const r = await venta(cuerpo);
    check(nombre, r.status === status, `${r.status} ${r.data.codigo || ""} ${r.data.mensaje || ""}`);
    return r;
  };
  check("sin Idempotency-Key 400", (await pedir("/api/local/ventas", { method: "POST", token: cajero, body: { lineas: lineasOk, pagos: pagosOk } })).status === 400);
  await mala({ lineas: [], pagos: pagosOk }, "sin líneas 400");
  await mala({ lineas: [{ id_medicamento: idA, cantidad: 0 }], pagos: pagosOk }, "cantidad cero 400");
  await mala({ lineas: [{ id_medicamento: idA, cantidad: 1 }, { id_medicamento: idA, cantidad: 1 }], pagos: pagosOk }, "medicamento repetido 400");
  await mala({ lineas: lineasOk, pagos: [] }, "sin pagos 400");
  await mala({ lineas: lineasOk, pagos: [{ id_metodo_pago: efectivo, monto: "8571.789" }] }, "monto con tres decimales 400");
  await mala({ lineas: lineasOk, pagos: [{ id_metodo_pago: 99999, monto: "8571.79" }] }, "método de pago inexistente 400");
  await mala({ lineas: lineasOk, pagos: [{ id_metodo_pago: efectivo, monto: "100" }, { id_metodo_pago: efectivo, monto: "8471.79" }] }, "método repetido 400");
  const descuadre = await mala({ lineas: lineasOk, pagos: [{ id_metodo_pago: efectivo, monto: "8571.78" }] }, "los pagos no suman el total 400");
  check("el rechazo trae total y pagado", descuadre.data.codigo === "PAGO_NO_CUADRA" && descuadre.data.total === "8571.79" && descuadre.data.pagado === "8571.78");
  await mala({ lineas: [{ id_medicamento: idD, cantidad: 1 }], pagos: [{ id_metodo_pago: efectivo, monto: "1" }] }, "medicamento sin precio no se vende 400");
  const sinStock = await mala({ lineas: [{ id_medicamento: idA, cantidad: 21 }], pagos: [{ id_metodo_pago: efectivo, monto: "1" }] }, "más que el stock vendible 409", 409);
  check("el rechazo es STOCK_INSUFICIENTE con lo disponible", sinStock.data.codigo === "STOCK_INSUFICIENTE" && sinStock.data.disponible === 20);
  check("ninguna validación escribió factura, movimientos, eventos ni consumió el número", (await facturas()) === facturasAntes && (await movimientosVenta()) === movAntes && (await colaVentas()) === colaAntes && (await ultimoNumero()) === numeroAntes);

  // --- Atomicidad: falla DESPUÉS de insertar la factura (controlado sin receta) y todo se revierte
  const stockA1 = await stock(loteA1);
  const stockC = await stock(loteC);
  const faltaReceta = await venta({ lineas: [{ id_medicamento: idA, cantidad: 1 }, { id_medicamento: idC, cantidad: 1 }], pagos: [{ id_metodo_pago: efectivo, monto: "5390.60" }] });
  check("sin receta: 409 RECETA_REQUERIDA", faltaReceta.status === 409 && faltaReceta.data.codigo === "RECETA_REQUERIDA", `${faltaReceta.status} ${faltaReceta.data.codigo}`);
  check("la venta revertida no dejó factura, stock, movimientos ni eventos", (await facturas()) === facturasAntes && (await stock(loteA1)) === stockA1 && (await stock(loteC)) === stockC && (await movimientosVenta()) === movAntes && (await colaVentas()) === colaAntes);
  check("y el número de factura no se consumió (sin saltos)", (await ultimoNumero()) === numeroAntes);

  // --- Venta correcta con pago combinado
  const key = nuevaKey();
  const tiempos = [];
  let t0 = Date.now();
  const v1 = await venta({ lineas: lineasOk, pagos: pagosOk }, { key });
  tiempos.push(Date.now() - t0);
  check("venta con pago combinado 201", v1.status === 201, `${v1.status} ${v1.data.mensaje || ""}`);
  check("número consecutivo con el formato de la tienda", v1.data.numero_factura === `T${TIENDA}-${String(numeroAntes + 1).padStart(6, "0")}`, v1.data.numero_factura);
  check("subtotal, impuestos y total exactos", v1.data.subtotal === "8001.50" && v1.data.impuestos === "570.29" && v1.data.total === "8571.79");
  const sumaLineas = v1.data.lineas.reduce((s, l) => s + centavos(l.subtotal), 0);
  const sumaImpuesto = v1.data.lineas.reduce((s, l) => s + centavos(l.impuesto), 0);
  const sumaPagos = v1.data.pagos.reduce((s, p) => s + centavos(p.monto), 0);
  check("el total es exactamente la suma de las líneas", sumaLineas === centavos(v1.data.subtotal) && sumaImpuesto === centavos(v1.data.impuestos) && sumaPagos === centavos(v1.data.total));
  check("la factura guarda la tasa y el precio de cada línea", v1.data.lineas.find((l) => l.id_medicamento === idA)?.tasa_impuesto === "19.00" && v1.data.lineas.find((l) => l.id_medicamento === idA)?.precio_unitario === "1000.50");
  check("tres métodos de pago registrados", v1.data.pagos.length === 3 && ["Efectivo", "Tarjeta débito", "Transferencia"].every((m) => v1.data.pagos.some((p) => p.metodo === m)));
  const idV1 = v1.data.id_factura;
  check("el stock del lote que vence antes bajó 3 (FEFO)", (await stock(loteA1)) === stockA1 - 3 && (await stock(loteB)) === 3);
  const movs = await local.query("select tipo_movimiento, sentido, cantidad, id_empleado from movimiento_inventario where referencia_documento = $1 order by id_movimiento", [v1.data.numero_factura]);
  check("un movimiento de venta por lote, con signo negativo", movs.rowCount === 2 && movs.rows.every((m) => m.tipo_movimiento === "VENTA" && m.sentido === -1));
  check("la venta queda auditada", (await contar(local, "select count(*) as n from registro_actividad where accion = 'VENTA_REGISTRAR' and id_entidad_afectada = $1", [idV1])) === 1);
  check("la venta y el stock quedan encolados para el central", (await colaVentas()) === colaAntes + 1);
  const mismaVenta = await venta({ lineas: lineasOk, pagos: pagosOk }, { key });
  check("reintento con la misma clave: la misma factura", mismaVenta.status === 201 && mismaVenta.data.id_factura === idV1);
  check("el reintento no descontó dos veces ni facturó dos veces", (await stock(loteA1)) === stockA1 - 3 && (await facturas()) === facturasAntes + 1);
  check("la misma clave con otro cuerpo 409", (await venta({ lineas: [{ id_medicamento: idB, cantidad: 1 }], pagos: [{ id_metodo_pago: efectivo, monto: "2500" }] }, { key })).status === 409);
  const consultada = await pedir(`/api/local/ventas/${idV1}`, { token: cajero });
  check("la factura se consulta", consultada.status === 200 && consultada.data.numero_factura === v1.data.numero_factura && consultada.data.cajero);
  check("factura inexistente 404", (await pedir("/api/local/ventas/99999999", { token: cajero })).status === 404);

  // --- Consecutivo sin saltos y FEFO entre lotes
  const calc2 = await pedir("/api/local/ventas/calcular", { method: "POST", token: cajero, body: { lineas: [{ id_medicamento: idA, cantidad: 12 }] } });
  // Dos filas de lote (7 y 5 unidades): el impuesto se redondea por lote, 1330.67 + 950.48 = 2281.15; total 14287.15.
  check("la vista previa reparte la línea por lotes y redondea el impuesto por lote", calc2.data.impuestos === "2281.15" && calc2.data.total === "14287.15", `${calc2.data.impuestos} / ${calc2.data.total}`);
  t0 = Date.now();
  const v2 = await venta({ lineas: [{ id_medicamento: idA, cantidad: 12 }], pagos: [{ id_metodo_pago: credito, monto: calc2.data.total }] });
  tiempos.push(Date.now() - t0);
  check("segunda venta: 12 unidades repartidas entre dos lotes 201", v2.status === 201, `${v2.status} ${v2.data.mensaje || ""} ${v2.data.codigo || ""}`);
  check("el número es el siguiente, sin saltos", v2.data.numero_factura === `T${TIENDA}-${String(numeroAntes + 2).padStart(6, "0")}`, v2.data.numero_factura);
  check("el lote que vence antes se agotó primero y el siguiente cubrió el resto", (await stock(loteA1)) === 0 && (await stock(loteA2)) === 10 - (12 - (stockA1 - 3)) && v2.data.lineas.length === 2);
  check("el lote agotado quedó AGOTADO", (await local.query("select estado from lote where id_lote = $1", [loteA1])).rows[0].estado === "AGOTADO");
  check("los lotes vencido y bloqueado no se tocaron", (await stock(loteAvencido)) === 50 && (await stock(loteAbloqueado)) === 50);
  check("el impuesto de la factura es la suma de sus líneas de lote", v2.data.lineas.reduce((s, l) => s + centavos(l.impuesto), 0) === centavos(v2.data.impuestos) && v2.data.impuestos === "2281.15");

  // --- Controlado con receta validada con el central (HU-12)
  const codigoReceta = `HU08R-${S}`;
  const emitida = await pedir("/api/central/recetas-emitidas", {
    method: "POST",
    token: general,
    key: nuevaKey(),
    body: { codigo: codigoReceta, medico_prescriptor: `Dr. Ventas ${S}`, fecha_emision: (await local.query("select current_date::text as f")).rows[0].f, paciente_nombre: `Paciente Ventas ${S}`, paciente_documento: `HV${S}`, medicamentos: [{ id_medicamento: idC, cantidad: 2 }] },
  });
  check("se emite la receta del controlado", emitida.status === 201);
  const validada = await pedir("/api/local/recetas/codigo", { method: "POST", token: cajero, body: { codigo: codigoReceta } });
  check("el cajero valida la receta con el central", validada.status === 200);
  const idReceta = validada.data.id_receta;
  const pagoC = [{ id_metodo_pago: efectivo, monto: "8400.00" }];
  const saldo = await venta({ lineas: [{ id_medicamento: idC, cantidad: 3, id_receta: idReceta }], pagos: [{ id_metodo_pago: efectivo, monto: "12600.00" }] });
  check("más de lo autorizado por la receta 409 RECETA_SALDO", saldo.status === 409 && saldo.data.codigo === "RECETA_SALDO", `${saldo.status} ${saldo.data.codigo}`);
  const otroMed = await venta({ lineas: [{ id_medicamento: idC, cantidad: 1, id_receta: 99999999 }], pagos: [{ id_metodo_pago: efectivo, monto: "4200.00" }] });
  check("una receta inexistente 409 RECETA_INVALIDA", otroMed.status === 409 && otroMed.data.codigo === "RECETA_INVALIDA", `${otroMed.status} ${otroMed.data.codigo}`);
  check("los rechazos de receta no tocaron el stock del controlado", (await stock(loteC)) === 20);
  const vC = await venta({ lineas: [{ id_medicamento: idC, cantidad: 2, id_receta: idReceta }], pagos: pagoC });
  check("controlado con receta válida 201 (5 % de impuesto)", vC.status === 201 && vC.data.subtotal === "8000.00" && vC.data.impuestos === "400.00" && vC.data.total === "8400.00", `${vC.status} ${vC.data.codigo || ""} ${vC.data.mensaje || ""}`);
  check("la factura guarda la receta y el paciente", vC.data.lineas[0]?.codigo_receta === codigoReceta && vC.data.cliente === `Paciente Ventas ${S}`);
  check("el lote del controlado bajó 2", (await stock(loteC)) === 18);
  const segunda = await venta({ lineas: [{ id_medicamento: idC, cantidad: 1, id_receta: idReceta }], pagos: [{ id_metodo_pago: efectivo, monto: "4200.00" }] });
  check("la receta ya quemada no sirve en otra factura 409 RECETA_RECLAMADA", segunda.status === 409 && segunda.data.codigo === "RECETA_RECLAMADA", `${segunda.status} ${segunda.data.codigo}`);
  check("la baja de la receta quedó en el outbox", (await contar(local, "select count(*) as n from outbox_sync where tipo_evento = 'RECETA_DISPENSADA' and payload ->> 'codigo' = $1", [codigoReceta])) === 1);

  // --- Sin conexión con el central: se vende igual (RNF-04)
  const colaOffline = await colaVentas();
  link.estado = "offline";
  const vOff = await venta({ lineas: [{ id_medicamento: idE, cantidad: 2 }], pagos: [{ id_metodo_pago: efectivo, monto: "238.00" }] });
  check("sin central: la venta se registra 201", vOff.status === 201 && vOff.data.total === "238.00", `${vOff.status} ${vOff.data.mensaje || ""}`);
  check("sin central: los eventos esperan en el outbox", (await colaVentas()) === colaOffline + 1);
  link.estado = "online";

  // --- Consolidado en el central tras sincronizar
  const consolidado = async (idMetodo) =>
    (await central.query(
      "select coalesce(sum(total_vendido), 0)::text as total, coalesce(sum(total_facturas), 0)::int as facturas from venta_consolidada where id_tienda = $1 and id_metodo_pago = $2",
      [TIENDA, idMetodo],
    )).rows[0];
  const antesDeb = await consolidado(debito);
  const antesTr = await consolidado(transferencia);
  const antesCr = await consolidado(credito);
  const envio = await flushOutbox(TIENDA);
  check("el ciclo del outbox envía las ventas", envio.sent >= 4, String(envio.sent));
  const despuesDeb = await consolidado(debito);
  const despuesTr = await consolidado(transferencia);
  const despuesCr = await consolidado(credito);
  check("el central suma lo cobrado por método (débito 3000.00)", centavos(despuesDeb.total) - centavos(antesDeb.total) === 300000 && despuesDeb.facturas === antesDeb.facturas + 1);
  check("el central suma la transferencia (2571.79)", centavos(despuesTr.total) - centavos(antesTr.total) === 257179 && despuesTr.facturas === antesTr.facturas + 1);
  check("el central suma la tarjeta de crédito de la segunda venta", centavos(despuesCr.total) - centavos(antesCr.total) === 1428715);
  const recla = (await central.query("select estado, id_tienda_reclamo from receta_emitida where codigo = $1", [codigoReceta])).rows[0];
  check("el central dio de baja la receta vendida", recla.estado === "RECLAMADA" && recla.id_tienda_reclamo === TIENDA);
  check("el stock del controlado llegó al consolidado", Number((await central.query("select cantidad_disponible from inventario_consolidado where id_tienda = $1 and id_medicamento = $2", [TIENDA, idC])).rows[0]?.cantidad_disponible) === 18);
  // Un evento repetido (reintento tras una caída) no suma dos veces.
  const evento = { idempotency_key: nuevaKey(), tipo_evento: "VENTA_REGISTRADA", payload: { fecha: "2026-01-02", total: "10.00", pagos: [{ id_metodo_pago: efectivo, monto: "10.00" }] } };
  const antesEf = await consolidado(efectivo);
  await withTx(central, (c) => aplicarEnCentral(c, TIENDA, evento));
  await withTx(central, (c) => aplicarEnCentral(c, TIENDA, evento));
  const despuesEf = await consolidado(efectivo);
  check("un evento duplicado no suma dos veces en el central", centavos(despuesEf.total) - centavos(antesEf.total) === 1000 && despuesEf.facturas === antesEf.facturas + 1);

  // --- Garantía en la base: una factura incompleta no hace commit
  async function commitIncompleto(preparar) {
    const client = await local.connect();
    try {
      await client.query("begin");
      const numero = `HU08X-${S}-${crypto.randomInt(1e6)}`;
      const f = await client.query(
        "insert into factura (numero_factura, id_empleado, subtotal, impuestos, total) values ($1, (select id_empleado from empleado_ref where usuario = 'cajero1'), 100, 0, 100) returning id_factura, numero_factura",
        [numero],
      );
      await preparar(client, f.rows[0]);
      await client.query("commit");
      return { ok: true, numero };
    } catch (error) {
      await client.query("rollback");
      return { ok: false, code: error.code, message: error.message, numero: null };
    } finally {
      client.release();
    }
  }
  const detalle = (client, id, cantidad = 1) =>
    client.query("insert into detalle_factura (id_factura, id_lote, cantidad, precio_unitario_aplicado, subtotal_linea) values ($1, $2, $3, 100, $3 * 100)", [id, loteF, cantidad]);
  const sinLineas = await commitIncompleto(async () => {});
  check("una factura sin líneas no hace commit (FACTURA_INCOMPLETA)", !sinLineas.ok && sinLineas.message.startsWith("FACTURA_INCOMPLETA"), sinLineas.message);
  const sinPago = await commitIncompleto(async (c, f) => {
    await detalle(c, f.id_factura);
    await c.query("insert into movimiento_inventario (id_lote, tipo_movimiento, sentido, cantidad, id_empleado, referencia_documento) values ($1, 'VENTA', -1, 1, (select id_empleado from empleado_ref where usuario = 'cajero1'), $2)", [loteF, f.numero_factura]);
  });
  check("sin pagos que sumen el total no hace commit (FACTURA_PAGOS)", !sinPago.ok && sinPago.message.startsWith("FACTURA_PAGOS"), sinPago.message);
  const sinMov = await commitIncompleto(async (c, f) => {
    await detalle(c, f.id_factura);
    await c.query("insert into factura_metodo_pago (id_factura, id_metodo_pago, monto) values ($1, $2, 100)", [f.id_factura, efectivo]);
  });
  check("sin movimiento de inventario no hace commit (FACTURA_SIN_MOVIMIENTO)", !sinMov.ok && sinMov.message.startsWith("FACTURA_SIN_MOVIMIENTO"), sinMov.message);
  check("ninguna factura incompleta quedó guardada", (await contar(local, "select count(*) as n from factura where numero_factura like $1", [`HU08X-${S}-%`])) === 0);

  // --- Concurrencia 1: más ventas simultáneas que stock (lote B: quedan 3 unidades)
  const stockB = await stock(loteB);
  const numerosAntes = await ultimoNumero();
  const carrera = await Promise.all(
    Array.from({ length: 8 }, () => venta({ lineas: [{ id_medicamento: idB, cantidad: 1 }], pagos: [{ id_metodo_pago: efectivo, monto: "2500.00" }] })),
  );
  const exitosas = carrera.filter((r) => r.status === 201);
  const rechazadas = carrera.filter((r) => r.status === 409 && r.data.codigo === "STOCK_INSUFICIENTE");
  check("8 ventas simultáneas contra 3 unidades: venden exactamente 3", exitosas.length === stockB && rechazadas.length === 8 - stockB, `${exitosas.length} ok / ${rechazadas.length} sin stock / ${carrera.map((r) => r.status).join(",")}`);
  check("el stock nunca queda negativo y llega a cero", (await stock(loteB)) === 0);
  const numeros = exitosas.map((r) => Number(r.data.numero_factura.split("-")[1])).sort((a, b) => a - b);
  check("los números de las ventas simultáneas son únicos y consecutivos", new Set(numeros).size === numeros.length && numeros.every((n, i) => n === numerosAntes + 1 + i), numeros.join(","));
  check("movimientos de venta = unidades vendidas", (await contar(local, "select coalesce(sum(cantidad), 0) as n from movimiento_inventario where tipo_movimiento = 'VENTA' and id_lote = $1", [loteB])) === 5);

  // --- Concurrencia 2: ventas con las mismas líneas en distinto orden (sin interbloqueos)
  const stockE = await stock(loteE);
  const stockF = await stock(loteF);
  const cruzadas = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      venta({
        lineas: i % 2 === 0 ? [{ id_medicamento: idE, cantidad: 1 }, { id_medicamento: idF, cantidad: 1 }] : [{ id_medicamento: idF, cantidad: 1 }, { id_medicamento: idE, cantidad: 1 }],
        pagos: [{ id_metodo_pago: efectivo, monto: "329.00" }],
      }),
    ),
  );
  check("8 ventas cruzadas simultáneas: todas 201, sin interbloqueo", cruzadas.every((r) => r.status === 201), cruzadas.map((r) => r.status).join(","));
  check("el stock bajó exactamente 8 en cada lote", (await stock(loteE)) === stockE - 8 && (await stock(loteF)) === stockF - 8);

  // --- Tiempo de respuesta (RNF-05): venta completa confirmada en ≤ 3 s
  for (let i = 0; i < 2; i += 1) {
    t0 = Date.now();
    await venta({ lineas: [{ id_medicamento: idE, cantidad: 1 }, { id_medicamento: idF, cantidad: 1 }], pagos: [{ id_metodo_pago: efectivo, monto: "329.00" }] });
    tiempos.push(Date.now() - t0);
  }
  const mediana = [...tiempos].sort((a, b) => a - b)[Math.floor(tiempos.length / 2)];
  check("la venta completa se confirma en ≤ 3 s (mediana)", mediana <= 3000, `${mediana} ms (${tiempos.join(", ")})`);
} finally {
  link.estado = "online";
  // Los medicamentos de prueba quedan inactivos: sus facturas y precios ya no se pueden borrar.
  await central.query("update medicamento set activo = false where codigo_interno like $1", [`HU08-${S}-%`]);
  await local.query("update medicamento_ref set activo = false where codigo_interno like $1", [`HU08-${S}-%`]);
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}:\n- ${fallos.join("\n- ")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
