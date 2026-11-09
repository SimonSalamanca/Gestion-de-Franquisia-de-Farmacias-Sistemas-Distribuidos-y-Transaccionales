// Pruebas de HU-05 por las rutas reales de app.mjs: reporte de la tienda (unidades e ingresos por método de pago, con
// devoluciones y anulaciones), inventario crítico y caducidad por tramos, comparativo de red (cuadre con la tienda,
// indicadores de stock, solo tiendas activas), permisos y auditoría, periodo inválido, sin conexión y rendimiento con
// volumen alto (100.000 facturas y 50 tiendas, dentro de transacciones que se revierten).
// ESCRIBE en las bases del .env: con URLs de Neon se niega a correr salvo PERMITIR_NEON=1 (rama de prueba).
// Correr con el API detenido. Las facturas y notas son permanentes (los medicamentos de prueba quedan inactivos).
// SIN_VOLUMEN=1 omite la prueba de rendimiento.
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
const { reporteTienda, comparativoRed } = await import("../apps/api/reportes.mjs");

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
const S = Date.now().toString(36).toUpperCase();
const TIENDA = 1;
const HOY = (await local.query("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0].d;
const HOY_CENTRAL = (await central.query("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0].d;
const hoy = `desde=${HOY}&hasta=${HOY}`;
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const proveedor = (await local.query("select id_proveedor from proveedor_ref where activo order by id_proveedor limit 1")).rows[0]?.id_proveedor;
if (!proveedor) {
  console.error("Falta un proveedor en la tienda (SEED_DEMO=1)");
  process.exit(2);
}
// Medicamento con precio y su umbral en cada tienda activa (HU-04 exige umbral en la misma transacción).
async function crearMedicamento(sufijo, { precio, minimo = 0 }) {
  const r = await central.query(
    `with m as (insert into medicamento (codigo_interno, nombre_comercial, principio_activo, requiere_receta, tasa_impuesto)
               values ($1, $2, 'prueba de reportes', false, 0) returning id_medicamento),
          u as (insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad)
                select t.id_tienda, m.id_medicamento, $3, 30 from tienda t cross join m where t.activa returning 1)
     select id_medicamento from m`,
    [`HU05-${S}-${sufijo}`, `Prueba Reportes ${S}-${sufijo}`, minimo],
  );
  await central.query(
    "insert into precio_medicamento (id_medicamento, precio, fecha_inicio_vigencia) values ($1, $2, now()::timestamp - interval '1 hour')",
    [r.rows[0].id_medicamento, precio],
  );
  return r.rows[0].id_medicamento;
}
async function crearLote(idMed, sufijo, cantidad, diasParaCaducar) {
  return (await local.query(
    `insert into lote (id_medicamento, id_proveedor, numero_lote, fecha_ingreso, fecha_caducidad, cantidad_inicial, cantidad_disponible, estado)
     values ($1, $2, $3, current_date - 60, current_date + $5::int, $4, $4, 'DISPONIBLE') returning id_lote`,
    [idMed, proveedor, `L05-${S}-${sufijo}`, cantidad, diasParaCaducar],
  )).rows[0].id_lote;
}

const fila = (red, id = TIENDA) => red.tiendas.find((t) => t.id_tienda === id);
const metodo = (rep, id) => rep.ventas.por_metodo.find((m) => m.id_metodo_pago === id) ?? { ingresos: 0, facturas: 0, reintegros: 0, notas: 0, ingresos_netos: 0 };

try {
  const cajero = await entrar("local", "cajero1");
  const adminTienda = await entrar("local", "admin.tienda");
  const adminGeneral = await entrar("central", "admin.general");
  check("logins demo", Boolean(cajero && adminTienda && adminGeneral));

  // --- Permiso nuevo, replicado como dato
  const tienePermiso = async (usuario) =>
    (await local.query(
      `select 1 from empleado_ref e join rol_permiso_ref rp on rp.id_rol = e.id_rol join permiso_ref p on p.id_permiso = rp.id_permiso
       where e.usuario = $1 and p.codigo = 'REPORTE_TIENDA_VER'`,
      [usuario],
    )).rowCount === 1;
  check("admin.tienda recibió REPORTE_TIENDA_VER por la réplica", await tienePermiso("admin.tienda"));
  check("el cajero no lo tiene", !(await tienePermiso("cajero1")));
  const modulos = (await pedir("/api/modulos")).data;
  check("el módulo Reportes está en el catálogo", modulos.REPORTE_TIENDA_VER?.ambito === "tienda");
  check("admin.tienda abre el módulo", (await pedir("/api/local/modulos/REPORTE_TIENDA_VER", { token: adminTienda })).status === 200);

  // --- Acceso
  check("sin sesión 401", (await pedir(`/api/local/reportes/tienda?${hoy}`)).status === 401);
  const denegadosAntes = Number((await local.query("select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and detalle = 'REPORTE_TIENDA_VER'")).rows[0].n);
  const delCajero = await pedir(`/api/local/reportes/tienda?${hoy}`, { token: cajero });
  check("el cajero recibe 403", delCajero.status === 403 && delCajero.data.codigo === "ACCESO_DENEGADO", `${delCajero.status}`);
  const denegados = Number((await local.query("select count(*) as n from registro_actividad where accion = 'ACCESO_DENEGADO' and detalle = 'REPORTE_TIENDA_VER'")).rows[0].n);
  check("el 403 queda en la auditoría como ACCESO_DENEGADO", denegados === denegadosAntes + 1);
  check("comparativo sin sesión 401", (await pedir(`/api/central/reportes/comparativo?${hoy}`)).status === 401);
  check("un token del POS no sirve en el comparativo 401", (await pedir(`/api/central/reportes/comparativo?${hoy}`, { token: adminTienda })).status === 401);

  // --- Periodo inválido
  const invalidos = [
    ["fecha imposible", "desde=2026-02-30&hasta=2026-03-01"],
    ["formato", "desde=01/11/2026&hasta=2026-11-09"],
    ["desde posterior a hasta", "desde=2026-11-09&hasta=2026-11-01"],
    ["más de 366 días", "desde=2025-01-01&hasta=2026-01-02"],
  ];
  for (const [nombre, q] of invalidos) {
    const r = await pedir(`/api/local/reportes/tienda?${q}`, { token: adminTienda });
    check(`periodo inválido (${nombre}) 400`, r.status === 400 && r.data.codigo === "DATOS_INVALIDOS", `${r.status}`);
  }
  check("periodo inválido también en el comparativo 400", (await pedir("/api/central/reportes/comparativo?desde=2026-11-09&hasta=2026-11-01", { token: adminGeneral })).status === 400);
  const porDefecto = await pedir("/api/local/reportes/tienda", { token: adminTienda });
  check("sin periodo usa el mes en curso", porDefecto.status === 200 && porDefecto.data.periodo.desde === `${HOY.slice(0, 8)}01` && porDefecto.data.periodo.hasta === new Date().toISOString().slice(0, 10), JSON.stringify(porDefecto.data.periodo));
  check("366 días es el máximo aceptado", (await pedir("/api/local/reportes/tienda?desde=2025-01-01&hasta=2026-01-01", { token: adminTienda })).status === 200);

  // --- Fotos antes de operar
  await flushOutbox(TIENDA);
  const red0 = (await pedir(`/api/central/reportes/comparativo?desde=${HOY_CENTRAL}&hasta=${HOY_CENTRAL}`, { token: adminGeneral })).data;
  const t0 = (await pedir(`/api/local/reportes/tienda?${hoy}`, { token: adminTienda })).data;

  // --- Datos de prueba: A y B se venden; C queda bajo su mínimo con lotes en cada tramo; D (sin lotes) queda agotado.
  const idA = await crearMedicamento("A", { precio: "5000.00" });
  const idB = await crearMedicamento("B", { precio: "2500.00" });
  const idC = await crearMedicamento("C", { precio: "1000.00", minimo: 10 });
  const idD = await crearMedicamento("D", { precio: "1000.00", minimo: 5 });
  await migrate();
  await pullReplica();
  const loteA = await crearLote(idA, "A1", 100, 200);
  const loteB = await crearLote(idB, "B1", 100, 200);
  const loteC = {
    VENCIDO: await crearLote(idC, "C0", 3, -1),
    HASTA_7: await crearLote(idC, "C1", 2, 5),
    HASTA_30: await crearLote(idC, "C2", 2, 20),
    HASTA_90: await crearLote(idC, "C3", 2, 60),
  };

  const metodos = (await pedir("/api/local/ventas/metodos-pago", { token: cajero })).data.metodos;
  const idMetodo = (n) => metodos.find((m) => m.nombre === n).id_metodo_pago;
  const [efectivo, debito] = [idMetodo("efectivo"), idMetodo("tarjeta_debito")];
  const venta = (lineas, pagos) => pedir("/api/local/ventas", { method: "POST", token: cajero, key: nuevaKey(), body: { lineas, pagos } });

  // V1: 30 A en efectivo (150.000). V2: 20 B en débito (50.000). V3: 1 A pagada 2.500 efectivo + 2.500 débito.
  const v1 = await venta([{ id_medicamento: idA, cantidad: 30 }], [{ id_metodo_pago: efectivo, monto: "150000.00" }]);
  const v2 = await venta([{ id_medicamento: idB, cantidad: 20 }], [{ id_metodo_pago: debito, monto: "50000.00" }]);
  const v3 = await venta([{ id_medicamento: idA, cantidad: 1 }], [{ id_metodo_pago: efectivo, monto: "2500.00" }, { id_metodo_pago: debito, monto: "2500.00" }]);
  check("tres ventas de prueba 201", [v1, v2, v3].every((v) => v.status === 201), [v1, v2, v3].map((v) => `${v.status} ${v.data.codigo || ""}`).join(", "));

  // --- Criterio 1: unidades e ingresos por método de pago
  const t1 = (await pedir(`/api/local/reportes/tienda?${hoy}`, { token: adminTienda })).data;
  const dv = (k) => t1.ventas[k] - t0.ventas[k];
  check("facturas +3", dv("facturas") === 3, String(dv("facturas")));
  check("unidades vendidas +51", dv("unidades_vendidas") === 51, String(dv("unidades_vendidas")));
  check("ingresos brutos +205.000", cerca(dv("ingresos_brutos"), 205000), String(dv("ingresos_brutos")));
  check("efectivo +152.500 en 2 facturas (pago combinado incluido)", cerca(metodo(t1, efectivo).ingresos - metodo(t0, efectivo).ingresos, 152500) && metodo(t1, efectivo).facturas - metodo(t0, efectivo).facturas === 2);
  check("débito +52.500 en 2 facturas", cerca(metodo(t1, debito).ingresos - metodo(t0, debito).ingresos, 52500) && metodo(t1, debito).facturas - metodo(t0, debito).facturas === 2);
  check("los métodos traen su etiqueta", metodo(t1, debito).metodo === "Tarjeta débito" && metodo(t1, efectivo).metodo === "Efectivo");
  check("la suma por método es igual a los ingresos brutos", cerca(t1.ventas.por_metodo.reduce((s, m) => s + m.ingresos, 0), t1.ventas.ingresos_brutos));
  const diaHoy = (rep) => rep.ventas.por_dia.find((d) => d.dia === HOY);
  check("por día: hoy +51 unidades y +205.000", diaHoy(t1).unidades - diaHoy(t0).unidades === 51 && cerca(diaHoy(t1).ingresos - diaHoy(t0).ingresos, 205000));

  // --- Devolución parcial (5 A de V1, en efectivo) y anulación total de V2 (débito), en el día de la nota
  const dev = await pedir(`/api/local/facturas/${v1.data.id_factura}/devolver`, { method: "POST", token: cajero, key: nuevaKey(), body: { motivo: "prueba de reportes: devuelve 5", lineas: [{ id_lote: loteA, cantidad: 5 }] } });
  const an = await pedir(`/api/local/facturas/${v2.data.id_factura}/anular`, { method: "POST", token: cajero, key: nuevaKey(), body: { motivo: "prueba de reportes: anulación" } });
  check("devolución y anulación 201", dev.status === 201 && an.status === 201, `${dev.status} ${an.status}`);
  const t2 = (await pedir(`/api/local/reportes/tienda?${hoy}`, { token: adminTienda })).data;
  const d2 = (k) => t2.ventas[k] - t0.ventas[k];
  check("notas +2, unidades devueltas +25", d2("notas") === 2 && d2("unidades_devueltas") === 25, `${d2("notas")} ${d2("unidades_devueltas")}`);
  check("reintegros +75.000 e ingresos netos +130.000", cerca(d2("reintegros"), 75000) && cerca(d2("ingresos_netos"), 130000), `${d2("reintegros")} ${d2("ingresos_netos")}`);
  check("unidades netas +26", d2("unidades_netas") === 26, String(d2("unidades_netas")));
  check("efectivo neto +127.500 (descuenta el reintegro)", cerca(metodo(t2, efectivo).ingresos_netos - metodo(t0, efectivo).ingresos_netos, 127500));
  check("débito neto +2.500 (la anulación reintegra los 50.000)", cerca(metodo(t2, debito).ingresos_netos - metodo(t0, debito).ingresos_netos, 2500));
  check("las facturas no cambian al devolver", d2("facturas") === 3);
  const topA = t2.ventas.mas_vendidos.find((m) => m.id_medicamento === idA);
  check("más vendidos: A con 31 vendidas, 5 devueltas, 26 netas y 130.000", topA && topA.unidades_vendidas === 31 && topA.unidades_devueltas === 5 && topA.unidades_netas === 26 && cerca(topA.ingresos_netos, 130000), JSON.stringify(topA));
  check("más vendidos está ordenado por unidades netas", t2.ventas.mas_vendidos.every((m, i, a) => i === 0 || a[i - 1].unidades_netas >= m.unidades_netas));
  check("B, anulada por completo, no figura entre los más vendidos", !t2.ventas.mas_vendidos.some((m) => m.id_medicamento === idB) && t2.ventas.mas_vendidos.every((m) => m.unidades_netas > 0));
  check("por día cuadra con los netos del periodo de un día", cerca(diaHoy(t2).ingresos, t2.ventas.ingresos_netos) && diaHoy(t2).unidades === t2.ventas.unidades_netas);

  // --- Criterio 2: stock crítico y caducidad por tramos
  const inv = t2.inventario;
  const critD = inv.criticos.find((c) => c.id_medicamento === idD);
  const critC = inv.criticos.find((c) => c.id_medicamento === idC);
  check("D sin lotes aparece agotado (crítica) con su mínimo", critD?.tipo === "STOCK_AGOTADO" && critD.nivel === "CRITICA" && critD.stock === 0 && critD.stock_minimo === 5, JSON.stringify(critD));
  check("C con 6 vendibles de un mínimo de 10 aparece bajo (media)", critC?.tipo === "STOCK_BAJO" && critC.nivel === "MEDIA" && critC.stock === 6 && critC.stock_minimo === 10, JSON.stringify(critC));
  check("los críticos van de crítica a media", inv.criticos.every((c, i, a) => i === 0 || ["CRITICA", "ALTA", "MEDIA"].indexOf(a[i - 1].nivel) <= ["CRITICA", "ALTA", "MEDIA"].indexOf(c.nivel)));
  const lotesC = Object.fromEntries(Object.entries(loteC).map(([tramo, id]) => [tramo, inv.caducidad.lotes.find((l) => l.id_lote === id)]));
  check("cada lote de C cae en su tramo", Object.entries(lotesC).every(([tramo, l]) => l?.tramo === tramo), JSON.stringify(Object.fromEntries(Object.entries(lotesC).map(([k, l]) => [k, l?.tramo]))));
  check("el lote vencido sale bloqueado por HU-04", lotesC.VENCIDO?.estado === "BLOQUEADO" && lotesC.VENCIDO.dias === -1);
  check("tramos: +1 lote en cada uno", ["VENCIDO", "HASTA_7", "HASTA_30", "HASTA_90"].every((k) => inv.caducidad.tramos[k].lotes - t0.inventario.caducidad.tramos[k].lotes === 1), JSON.stringify(inv.caducidad.tramos));
  check("los lotes de 200 días no aparecen", !inv.caducidad.lotes.some((l) => l.id_lote === loteA || l.id_lote === loteB));
  check("la lista está ordenada por caducidad", inv.caducidad.lotes.every((l, i, a) => i === 0 || a[i - 1].fecha_caducidad <= l.fecha_caducidad));

  // --- Sin conexión con el central
  link.estado = "offline";
  const sinRed = await pedir(`/api/local/reportes/tienda?${hoy}`, { token: adminTienda });
  check("sin conexión el reporte de la tienda se genera igual", sinRed.status === 200 && cerca(sinRed.data.ventas.ingresos_netos, t2.ventas.ingresos_netos));
  const redCaida = await pedir(`/api/central/reportes/comparativo?${hoy}`, { token: adminGeneral });
  check("sin conexión el comparativo responde 503 con la última sincronización", redCaida.status === 503 && redCaida.data.codigo === "SIN_CONEXION" && "ultima_sync" in redCaida.data, `${redCaida.status}`);
  link.estado = "online";
  link.openedUntil = 0;

  // --- Criterio 3: comparativo de red, cuadre con la tienda e indicadores de stock
  await flushOutbox(TIENDA);
  const red1 = (await pedir(`/api/central/reportes/comparativo?desde=${HOY_CENTRAL}&hasta=${HOY_CENTRAL}`, { token: adminGeneral })).data;
  check("el comparativo responde con la tienda 1", Boolean(fila(red1)));
  check("cuadre tienda-red: el central suma los mismos +130.000 netos", cerca(fila(red1).ingresos - fila(red0).ingresos, 130000), `${fila(red0).ingresos} -> ${fila(red1).ingresos}`);
  check("facturas en el central +4 (la combinada cuenta en cada método)", fila(red1).facturas - fila(red0).facturas === 4, String(fila(red1).facturas - fila(red0).facturas));
  check("la tienda trae su última sincronización de ventas y de stock", fila(red1).ultima_sync_ventas && fila(red1).ultima_sync_stock && !fila(red1).sin_datos);
  check("C cuenta como bajo mínimo en el central", fila(red1).bajo_minimo - fila(red0).bajo_minimo >= 1, `${fila(red0).bajo_minimo} -> ${fila(red1).bajo_minimo}`);
  const consolidadoD = await central.query("select 1 from inventario_consolidado where id_tienda = $1 and id_medicamento = $2", [TIENDA, idD]);
  check("D, sin movimientos, cuenta como sin reporte de stock", consolidadoD.rowCount === 0 && fila(red1).sin_reporte >= 1);
  const activas = new Set((await central.query("select id_tienda from tienda where activa")).rows.map((r) => r.id_tienda));
  check("solo tiendas activas", red1.tiendas.length === activas.size && red1.tiendas.every((t) => activas.has(t.id_tienda)));
  check("participación suma 100 % (si hay ingresos)", red1.totales.ingresos <= 0 || Math.abs(red1.tiendas.reduce((s, t) => s + t.participacion, 0) - 100) < 0.1);
  check("totales de la red = suma de tiendas", cerca(red1.totales.ingresos, red1.tiendas.reduce((s, t) => s + t.ingresos, 0)) && red1.totales.facturas === red1.tiendas.reduce((s, t) => s + t.facturas, 0));
  check("ordenado por ingresos", red1.tiendas.every((t, i, a) => i === 0 || a[i - 1].ingresos >= t.ingresos));
  const conVentas = new Set((await central.query("select distinct id_tienda from venta_consolidada")).rows.map((r) => r.id_tienda));
  check("'sin datos' solo para tiendas que nunca consolidaron", red1.tiendas.every((t) => t.sin_datos === !conVentas.has(t.id_tienda)));
  check("ticket promedio = ingresos / facturas", red1.tiendas.every((t) => !t.facturas || cerca(t.ticket_promedio, Math.round((t.ingresos / t.facturas) * 100) / 100)));

  // Una tienda desactivada sale del comparativo (se revierte: no queda ningún cambio).
  const c = await central.connect();
  try {
    await c.query("begin");
    await c.query("update tienda set activa = false where id_tienda = $1", [TIENDA]);
    const sinTienda = await comparativoRed({ desde: HOY_CENTRAL, hasta: HOY_CENTRAL }, c);
    check("una tienda desactivada no aparece", !sinTienda.tiendas.some((t) => t.id_tienda === TIENDA));
  } finally {
    await c.query("rollback");
    c.release();
  }

  // --- Criterio 5: rendimiento con volumen alto (p95 < 2 s), todo dentro de transacciones que se revierten
  if (process.env.SIN_VOLUMEN !== "1") {
    const p95 = (ms) => ms.slice().sort((a, b) => a - b)[Math.ceil(ms.length * 0.95) - 1];
    const medir = async (fn, veces = 20) => {
      const ms = [];
      for (let i = 0; i < veces; i += 1) {
        const t = performance.now();
        await fn();
        ms.push(performance.now() - t);
      }
      return ms;
    };
    const desdeAnio = (await local.query("select to_char(current_date - 365, 'YYYY-MM-DD') as d")).rows[0].d;
    const idCajero = (await local.query("select id_empleado from empleado_ref where usuario = 'cajero1'")).rows[0].id_empleado;

    const cl = await local.connect();
    try {
      await cl.query("begin");
      const t0v = performance.now();
      await cl.query(
        `insert into factura (numero_factura, id_empleado, fecha_hora, subtotal, impuestos, total, estado)
         select 'P05-' || $1 || '-' || g, $2, (current_date - (g % 366))::timestamp + make_interval(mins => g % 1440), 8500, 0, 8500, 'EMITIDA'
         from generate_series(1, 100000) g`,
        [S, idCajero],
      );
      await cl.query(
        `insert into detalle_factura (id_factura, id_lote, cantidad, precio_unitario_aplicado, subtotal_linea, tasa_impuesto, impuesto_linea)
         select f.id_factura, x.id_lote, 1, x.precio, x.precio, 0, 0
         from factura f
         cross join lateral (values ($2::int, 5000::numeric), ($3::int, 2500::numeric), ($4::int, 1000::numeric)) as x(id_lote, precio)
         where f.numero_factura like 'P05-' || $1 || '-%' and (x.id_lote <> $4 or f.id_factura % 2 = 0)`,
        [S, loteA, loteB, loteC.HASTA_90],
      );
      await cl.query(
        `insert into factura_metodo_pago (id_factura, id_metodo_pago, monto)
         select id_factura, case when id_factura % 2 = 0 then $2::int else $3::int end, 8500
         from factura where numero_factura like 'P05-' || $1 || '-%'`,
        [S, efectivo, debito],
      );
      const lineas = Number((await cl.query("select count(*) as n from detalle_factura d join factura f using (id_factura) where f.numero_factura like 'P05-' || $1 || '-%'", [S])).rows[0].n);
      console.log(`  volumen local: 100.000 facturas y ${lineas} líneas en ${Math.round(performance.now() - t0v)} ms`);
      const ms = await medir(() => reporteTienda({ desde: desdeAnio, hasta: HOY }, cl));
      const muestra = await reporteTienda({ desde: desdeAnio, hasta: HOY }, cl);
      check("con volumen el reporte cuenta las 100.000 facturas", muestra.ventas.facturas >= 100000 && muestra.ventas.por_dia.length === 366, String(muestra.ventas.facturas));
      check(`reporte de la tienda de un año con 100.000 facturas: p95 ${Math.round(p95(ms))} ms < 2000 ms`, p95(ms) < 2000, ms.map(Math.round).join(","));
    } finally {
      await cl.query("rollback");
      cl.release();
    }

    const cc = await central.connect();
    try {
      await cc.query("begin");
      const metodosRed = (await cc.query("select id_metodo_pago from metodo_pago order by id_metodo_pago limit 4")).rows.map((r) => r.id_metodo_pago);
      const nuevas = (await cc.query(
        `insert into tienda (nombre, direccion, ciudad, activa)
         select 'Volumen ' || $1 || ' ' || g, 'Calle ' || g, 'Prueba', true from generate_series(1, 50) g returning id_tienda`,
        [S],
      )).rows.map((r) => r.id_tienda);
      await cc.query(
        `insert into venta_consolidada (id_tienda, fecha, id_metodo_pago, total_vendido, total_facturas, fecha_sincronizacion)
         select t, current_date - d, m, 100000 + d, 20, now()
         from unnest($1::int[]) t cross join generate_series(0, 365) d cross join unnest($2::int[]) m`,
        [nuevas, metodosRed],
      );
      const filas = Number((await cc.query("select count(*) as n from venta_consolidada where id_tienda = any($1)", [nuevas])).rows[0].n);
      console.log(`  volumen red: 50 tiendas y ${filas} filas de venta_consolidada`);
      const ms = await medir(() => comparativoRed({ desde: desdeAnio, hasta: HOY_CENTRAL }, cc));
      const muestra = await comparativoRed({ desde: desdeAnio, hasta: HOY_CENTRAL }, cc);
      check("con volumen el comparativo trae las 50 tiendas nuevas", nuevas.every((id) => muestra.tiendas.some((t) => t.id_tienda === id)));
      check(`comparativo de un año con 50 tiendas: p95 ${Math.round(p95(ms))} ms < 2000 ms`, p95(ms) < 2000, ms.map(Math.round).join(","));
    } finally {
      await cc.query("rollback");
      cc.release();
    }
  }
} finally {
  link.estado = "online";
  await central.query("update medicamento set activo = false where codigo_interno like $1", [`HU05-${S}-%`]);
  await local.query("update medicamento_ref set activo = false where codigo_interno like $1", [`HU05-${S}-%`]);
  server.close();
}

console.log(fallos.length ? `FALLOS ${fallos.length}:\n- ${fallos.join("\n- ")}` : "TODO OK");
await central.end();
await local.end();
if (fallos.length) process.exit(1);
